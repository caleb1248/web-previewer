const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: "esbuild-problem-matcher",

  setup(build) {
    build.onStart(() => {
      console.log("[watch] build started");
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log("[watch] build finished");
    });
  },
};

/**
 * @rolldown/browser uses top-level await and locates its wasm and thread worker
 * via `import.meta.url`, neither of which survives bundling into the CommonJS
 * browser extension. Build it as a standalone ES module in dist/rolldown/ (with
 * the wasm next to it) that the extension loads at runtime with import().
 */
async function buildRolldownBrowser() {
  const dist = path.dirname(require.resolve("@rolldown/browser/package.json"));
  const outdir = path.join("dist", "rolldown");
  fs.mkdirSync(outdir, { recursive: true });
  fs.copyFileSync(
    path.join(dist, "dist", "rolldown-binding.wasm32-wasi.wasm"),
    path.join(outdir, "rolldown-binding.wasm32-wasi.wasm"),
  );
  await esbuild.build({
    entryPoints: {
      // Names must match the files the binding resolves against import.meta.url.
      "index.browser": path.join(dist, "dist", "index.browser.mjs"),
      "wasi-worker-browser": path.join(dist, "dist", "wasi-worker-browser.mjs"),
    },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "esnext",
    minify: production,
    outdir,
    outExtension: { ".js": ".mjs" },
    logLevel: "silent",
    plugins: [classicWasiWorkerPlugin, esbuildProblemMatcherPlugin],
  });
}

/**
 * The binding starts its thread workers as module workers:
 * `new Worker(new URL('./wasi-worker-browser.mjs', import.meta.url), { type: 'module' })`.
 * VS Code's web extension host replaces `Worker` with a wrapper that starts a
 * classic bootstrap script which loads the real one via `importScripts(url)`,
 * passing our options through. With `type: 'module'` the bootstrap runs as a
 * module, where importScripts throws. The bundled worker has no imports/exports
 * (it's a valid classic script), so start it as a classic worker instead.
 */
const classicWasiWorkerPlugin = {
  name: "classic-wasi-worker",
  setup(build) {
    build.onLoad({ filter: /rolldown-binding\.wasi-browser\.js$/ }, async (args) => {
      const source = await fs.promises.readFile(args.path, "utf8");
      const target =
        /new Worker\(new URL\('\.\/wasi-worker-browser\.mjs', import\.meta\.url\), \{\s*type: 'module',?\s*\}\)/g;
      if (!target.test(source)) {
        return {
          errors: [{ text: `classic-wasi-worker: worker construction not found in ${args.path}; the binding changed` }],
        };
      }
      return {
        contents: source.replace(target, "new Worker(new URL('./wasi-worker-browser.mjs', import.meta.url))"),
        loader: "js",
      };
    });
  },
};

/**
 * rolldown's JavaScript is bundled into dist/extension.node.js, but its binding
 * loader still `require()`s `@rolldown/binding-*` at runtime, resolved from dist/.
 * The repo's node_modules isn't shipped (see .vscodeignore), so production builds
 * copy bindings, with their dependencies, from node_modules into dist/node_modules/.
 * The loader prefers a native binding and falls back to the WASI one when none loads.
 *
 * Which bindings are copied depends on VSCE_TARGET (set by scripts/package-vsix.js
 * for each package; vsce passes the environment on to vscode:prepublish):
 * - a vsce target such as `linux-x64`: that platform's native binding + WASI;
 * - `universal`: only the WASI binding;
 * - `web`: nothing (see WEB_ONLY);
 * - unset: this machine's native binding + WASI.
 * Native bindings for other platforms are only in node_modules after
 * `bun install --os='*' --cpu='*'`.
 */
const NATIVE_BINDINGS = {
  "win32-x64": "win32-x64-msvc",
  "win32-arm64": "win32-arm64-msvc",
  "linux-x64": "linux-x64-gnu",
  "linux-arm64": "linux-arm64-gnu",
  "linux-armhf": "linux-arm-gnueabihf",
  "alpine-x64": "linux-x64-musl",
  "alpine-arm64": "linux-arm64-musl",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
};
const WASI_BINDING = "@rolldown/binding-wasm32-wasi";
const BINDINGS_DIR = path.join("dist", "node_modules");

/** The vsce target for this machine, e.g. `win32-x64` or `alpine-arm64`. */
function hostTarget() {
  const arch = process.arch === "arm" ? "armhf" : process.arch;
  if (process.platform === "linux") {
    // glibcVersionRuntime is only reported on glibc; its absence means musl (Alpine).
    const glibc = process.report?.getReport().header.glibcVersionRuntime;
    return `${glibc ? "linux" : "alpine"}-${arch}`;
  }
  return `${process.platform}-${arch}`;
}

/**
 * A `web` package only runs in VS Code for the Web, which loads the "browser"
 * entry (dist/extension.browser.js + dist/rolldown/), so it ships no bindings.
 * The node bundle is still built: vsce requires every entry point in
 * package.json ("main" too) to exist, and it's small without the bindings.
 */
const WEB_ONLY = process.env.VSCE_TARGET === "web";

function stageRolldownBindings() {
  fs.rmSync(BINDINGS_DIR, { recursive: true, force: true });
  if (WEB_ONLY) {
    console.log("[bindings] web: none");
    return;
  }
  const target = process.env.VSCE_TARGET || hostTarget();
  const names = [WASI_BINDING];
  if (target !== "universal") {
    if (!(target in NATIVE_BINDINGS)) {
      throw new Error(
        `No native rolldown binding for target "${target}". Known: universal, web, ${Object.keys(NATIVE_BINDINGS).join(", ")}`,
      );
    }
    names.unshift(`@rolldown/binding-${NATIVE_BINDINGS[target]}`);
  }
  const version = readJson(require.resolve("rolldown/package.json")).version;

  const copied = new Set();
  for (const name of names) {
    if (!copyInstalled(name, process.cwd(), copied, version)) {
      throw new Error(
        `${name}@${version} isn't installed. Install bindings for every platform with: ` +
          "bun install --os='*' --cpu='*'",
      );
    }
  }
  console.log(`[bindings] ${target}: ${[...copied].sort().join(", ")}`);
}

/**
 * Copies an installed package (resolved from `fromDir`) and its dependency
 * closure, flat, into dist/node_modules. Returns false if it isn't installed, or
 * (when `version` is given) is installed at another version.
 */
function copyInstalled(name, fromDir, copied, version) {
  if (copied.has(name)) {
    return true;
  }
  let pkgJson;
  try {
    pkgJson = require.resolve(`${name}/package.json`, { paths: [fromDir] });
  } catch {
    return false;
  }
  const pkg = readJson(pkgJson);
  if (version && pkg.version !== version) {
    return false;
  }
  const pkgDir = fs.realpathSync(path.dirname(pkgJson));
  copyPackage(pkgDir, path.join(BINDINGS_DIR, name));
  copied.add(name);
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (!copyInstalled(dep, pkgDir, copied)) {
      throw new Error(`${name} depends on ${dep}, which isn't installed`);
    }
  }
  return true;
}

/** Copies a package directory without its nested node_modules (dependencies are staged flat). */
function copyPackage(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (src) => src === from || path.basename(src) !== "node_modules",
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function main() {
  if (production) {
    stageRolldownBindings();
  } else {
    // Development builds load the bindings from the repo's node_modules.
    fs.rmSync(BINDINGS_DIR, { recursive: true, force: true });
  }
  // Only changes when the dependency does, so it isn't part of watch mode.
  await buildRolldownBrowser();
  const ctx = await esbuild.context({
    entryPoints: ["src/node/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "node",
    outfile: "dist/extension.node.js",
    external: ["vscode"],
    logLevel: "silent",
    target: "esnext",
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }

  const ctx2 = await esbuild.context({
    entryPoints: ["src/browser/extension.ts"],
    bundle: true,
    format: "cjs",
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: "browser",
    outfile: "dist/extension.browser.js",
    external: ["vscode"],
    logLevel: "silent",
    plugins: [
      /* add to the end of plugins array */
      esbuildProblemMatcherPlugin,
    ],
  });
  if (watch) {
    await ctx2.watch();
  } else {
    await ctx2.rebuild();
    await ctx2.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
