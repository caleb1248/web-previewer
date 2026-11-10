import * as vscode from "vscode";
import type { InputOptions, OutputOptions, Plugin, RolldownLog } from "@rolldown/browser" with {
  "resolution-mode": "import",
};

declare namespace globalThis {
  export let outputChannel: vscode.LogOutputChannel;
  export let currentPerf: number;
}

function getBuildTime(): string {
  return Math.round(performance.now() - globalThis.currentPerf).toString() + " ms";
}

type Rolldown = typeof import("@rolldown/browser", { with: { "resolution-mode": "import" } });

let extensionUri: vscode.Uri | undefined;
let rolldownPromise: Promise<Rolldown> | undefined;

/** Must be called from activate() before the first bundle(). */
export function initRolldown(uri: vscode.Uri): void {
  extensionUri = uri;
}

/**
 * @rolldown/browser is built separately into dist/rolldown/ (see esbuild.js) and
 * imported from the extension's own URL at runtime. As a real ES module it can
 * use top-level await, and its `import.meta.url` resolves the wasm and thread
 * worker sitting next to it.
 */
function loadRolldown(): Promise<Rolldown> {
  if (!extensionUri) {
    return Promise.reject(new Error("initRolldown() was not called"));
  }
  if (!rolldownPromise) {
    const url = vscode.Uri.joinPath(extensionUri, "dist", "rolldown", "index.browser.mjs").toString(
      true,
    );
    // A computed specifier, so esbuild leaves this as a real runtime import().
    rolldownPromise = import(url) as Promise<Rolldown>;
    rolldownPromise.catch(() => {
      rolldownPromise = undefined;
    });
  }
  return rolldownPromise;
}

const RESOLVE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
];

const EXPORT_CONDITIONS = ["browser", "import", "module", "default", "require"];

/** How a file is turned into a module. `css`, `dataurl` and `binary` are handled by the plugin itself. */
type Loader = "js" | "jsx" | "ts" | "tsx" | "json" | "text" | "css" | "dataurl" | "binary";

const LOADERS: Record<string, Loader> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".json": "json",
  ".css": "css",
  ".txt": "text",
  ".md": "text",
  ".html": "text",
  ".glsl": "text",
  ".wgsl": "text",
  ".wasm": "binary",
};

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
  // Text types, for `?url` imports of non-asset files.
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".html": "text/html",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

/** Build diagnostic in the shape the HTML error overlay and output channel expect. */
export interface BuildMessage {
  text: string;
  location?: { file: string; line: number; column: number; lineText: string } | null;
}

export interface BundleInput {
  /** URI of the entry file, or of a virtual file registered in `virtualFiles`. */
  entry: vscode.Uri;
  format: "esm" | "iife";
  /** In-memory file contents (e.g. inline <script type="module"> blocks). */
  virtualFiles?: Map<string, string>;
  /** Root used for absolute imports like "/src/main.ts" and as the node_modules search ceiling. */
  root: vscode.Uri;
  tsconfigRaw?: string;
  /**
   * Snapshot of `root` to resolve against. Pass one shared tree to every bundle()
   * of a page; when omitted, a new one is scanned for this build.
   */
  fileTree?: FileTree;
  /** Emit an inline source map (the jsPreview.sourceMaps setting). */
  sourceMaps?: boolean;
}

export interface BundleOutput {
  js?: string;
  css?: string;
  warnings: BuildMessage[];
  /** Every file read while bundling, as URI strings; used for live reload. */
  dependencies: Set<string>;
}

export class BundleError extends Error {
  constructor(
    public readonly errors: BuildMessage[],
    public readonly dependencies: Set<string>,
  ) {
    super(errors.map((e) => e.text).join("\n"));
  }
}

/**
 * @param workerChain URIs of `?worker` entries currently being bundled around
 * this build; used to reject a worker that (indirectly) spawns itself.
 */
export async function bundle(
  input: BundleInput,
  workerChain: ReadonlySet<string> = new Set(),
): Promise<BundleOutput> {
  const dependencies = new Set<string>();
  const virtualFiles = input.virtualFiles ?? new Map<string, string>();
  const ctx: ResolveContext = {
    virtualFiles,
    tree: input.fileTree ?? (await FileTree.scan(input.root)),
  };

  // Rolldown no longer bundles CSS, so stylesheet entries are flattened here.
  if (extname(input.entry.path) === ".css") {
    try {
      const css = await processCss(input.entry, input.root, ctx, dependencies, new Set());
      return { css, warnings: [], dependencies };
    } catch (e) {
      throw new BundleError([{ text: e instanceof Error ? e.message : String(e) }], dependencies);
    }
  }

  const warnings: BuildMessage[] = [];
  // CSS imported from JS, keyed by module id; reordered into import order once the graph is built.
  const cssModules = new Map<string, string>();
  // node_modules files imported directly by project files; built separately (see buildDeps).
  const depEntries = new Set<string>();
  const transform: Transform = {
    target: "es2022",
    define: { "process.env.NODE_ENV": '"development"' },
    ...transformFromTsconfig(input.tsconfigRaw),
  };
  try {
    const app = await runRolldown(
      input.entry.toString(),
      transform,
      workspacePlugin({ input, ctx, dependencies, warnings, cssModules, workerChain, depEntries }),
      warnings,
      { format: input.format, sourcemap: input.sourceMaps ? "hidden" : false },
    );

    let deps: DepsBuild | undefined;
    if (depEntries.size > 0) {
      deps = await getDeps([...depEntries].sort(), input, ctx, transform, warnings);
      deps.dependencies.forEach((d) => dependencies.add(d));
    }

    const out: BundleOutput = { warnings, dependencies, js: joinChunks(app, deps, input.format) };
    const css = [deps?.css, ...cssModules.values()].filter((c) => c !== undefined);
    if (css.length > 0) {
      out.css = css.join("\n");
    }
    return out;
  } catch (e) {
    if (e instanceof BundleError) {
      e.dependencies.forEach((d) => dependencies.add(d));
      throw new BundleError(e.errors, dependencies);
    }
    const errors = (e as { errors?: RolldownLog[] }).errors;
    if (Array.isArray(errors)) {
      throw new BundleError(errors.map(toMessage), dependencies);
    }
    throw e;
  }
}

type Transform = NonNullable<InputOptions["transform"]>;

interface Chunk {
  code: string;
  map?: RawSourceMap;
}

interface RawSourceMap {
  version: number;
  sources: string[];
  mappings: string;
  [key: string]: unknown;
}

/** One rolldown build to a single chunk, with its source map kept separately. */
async function runRolldown(
  input: string,
  transform: Transform,
  plugin: Plugin,
  warnings: BuildMessage[],
  output: Pick<OutputOptions, "format" | "name" | "exports" | "sourcemap">,
): Promise<Chunk> {
  let oc = globalThis.outputChannel;
  // The dependency build's entry is a virtual id starting with \0; give it a readable name.
  let fileName = input === DEPS_ENTRY ? "dependencies" : input.split("/").pop();

  const overallPerf = performance.now();

  if (oc) {
    oc.info(`[bundle ${fileName}] starting at t=${getBuildTime()}`);
    oc.info(`[bundle ${fileName}] Loading rolldown...`);
  }

  const { rolldown } = await loadRolldown();

  if (oc) {
    oc.info(`[bundle ${fileName}] rolldown loaded at t=${getBuildTime()}`);
    oc.info(`[bundle ${fileName}] running rolldown...`);
  }

  const build = await rolldown({
    input,
    // There's no `process` in the web extension host, and rolldown falls back to
    // process.cwd() without this. Every module goes through our plugin as a URI,
    // so this is only a base path; "/" is the root of the WASI in-memory fs.
    cwd: "/",
    platform: "browser",
    logLevel: "warn",
    onLog: (_level, log) => {
      const message = toMessage(log);
      warnings.push({ ...message, text: `[${fileName}] ${message.text}` });
    },
    // The tsconfig is read through workspace.fs and mapped onto transform options instead.
    tsconfig: false,
    transform,
    plugins: [plugin],
  });
  try {
    // Maps are "hidden" (returned, not linked) when enabled, since joinChunks inlines them.
    const result = await build.generate({ ...output, codeSplitting: false });
    const chunk = result.output.find((f) => f.type === "chunk");
    return {
      code: chunk?.code ?? "",
      map: chunk?.map ? (JSON.parse(chunk.map.toString()) as RawSourceMap) : undefined,
    };
  } finally {
    await build.close();
    if (oc) {
      oc.info(
        `[bundle ${fileName}] build completed at t=${getBuildTime()} (total ${Math.round(performance.now() - overallPerf)} ms)`,
      );
    }
  }
}

/**
 * Global (scoped to the output script, see joinChunks) that holds the
 * pre-bundled dependencies, keyed by the entry file's URI.
 */
const DEPS_GLOBAL = "__jsPreviewDeps";
const DEP_PREFIX = "\0js-preview-dep:";
const DEPS_ENTRY = "\0js-preview-deps";

/** Modules a project file can import from node_modules through a dependency stub. */
const DEP_LOADERS = new Set<Loader>(["js", "jsx", "ts", "tsx", "json"]);

/**
 * Stub that stands in for a node_modules entry in the app build. It's CommonJS,
 * so rolldown's interop handles default, named and namespace imports alike by
 * reading properties at runtime; no export names need to be known up front.
 */
function depStubModule(uri: string): string {
  return `module.exports = ${DEPS_GLOBAL}[${JSON.stringify(uri)}];\n`;
}

/**
 * Entry for the dependency build. Each entry's namespace is exposed as an
 * `__esModule` object with live getters, which the stubs' interop unwraps back
 * into the original default and named exports. CommonJS packages arrive here
 * already converted by rolldown (`default` = module.exports, plus its keys).
 */
function depsEntryModule(entries: readonly string[]): string {
  const imports = entries.map((uri, i) => `import * as d${i} from ${JSON.stringify(uri)};`);
  const fields = entries.map((uri, i) => `\t${JSON.stringify(uri)}: wrap(d${i}),`);
  return `${imports.join("\n")}
const wrap = (ns) => {
	const o = { __esModule: true };
	for (const k of Object.keys(ns)) {
		if (k !== "__esModule") Object.defineProperty(o, k, { enumerable: true, get: () => ns[k] });
	}
	return o;
};
export default {
${fields.join("\n")}
};
`;
}

interface DepsBuild extends Chunk {
  css?: string;
  dependencies: Set<string>;
}

/**
 * Builds of node_modules code that are reused across builds: dependency bundles
 * (getDeps) and `?worker` entries inside node_modules. Most recently used last.
 */
const buildCache = new Map<string, Promise<{ dependencies: Set<string> }>>();
const BUILD_CACHE_LIMIT = 32;

/**
 * Returns the cached build for `key`, starting `build` on a miss. `hit` is true
 * when the result was (or is being) produced by an earlier call, so its warnings
 * were already reported. A failed build isn't cached; the next call retries.
 */
function cachedBuild<T extends { dependencies: Set<string> }>(
  key: string,
  build: () => Promise<T>,
): { result: Promise<T>; hit: boolean } {
  let result = buildCache.get(key) as Promise<T> | undefined;
  const hit = result !== undefined;
  if (result) {
    buildCache.delete(key); // re-insert as most recently used
  } else {
    const started = build();
    started.catch(() => buildCache.get(key) === started && buildCache.delete(key));
    result = started;
  }
  buildCache.set(key, result);
  while (buildCache.size > BUILD_CACHE_LIMIT) {
    buildCache.delete(buildCache.keys().next().value!);
  }
  return { result, hit };
}

/** Drops cached builds that read `uri` (a file in node_modules changed). */
export function invalidateBuildCache(uri: string): void {
  for (const [key, entry] of buildCache) {
    void entry.then(
      (b) => b.dependencies.has(uri) && buildCache.get(key) === entry && buildCache.delete(key),
      () => {},
    );
  }
}

const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"];

/**
 * Part of every build cache key: the options that change node_modules output,
 * plus the root lockfiles' size and mtime, so an install invalidates the cache.
 * Editing a file inside node_modules is caught by invalidateBuildCache instead.
 */
async function cacheKeyBase(input: BundleInput, tree: FileTree, transform: Transform) {
  const lockfiles = await Promise.all(
    LOCKFILES.map(async (name) => {
      const uri = vscode.Uri.joinPath(input.root, name);
      if (tree.kind(uri) === "missing") {
        return undefined;
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        return [name, stat.size, stat.mtime];
      } catch {
        return undefined;
      }
    }),
  );
  return { transform, sourceMaps: input.sourceMaps ?? false, lockfiles: lockfiles.filter(Boolean) };
}

/**
 * Returns the bundle of every node_modules entry point the app imports, built
 * together (so packages they share, like react under react-dom, exist once) and
 * reused by later builds that import exactly the same entry points.
 */
async function getDeps(
  entries: readonly string[],
  input: BundleInput,
  ctx: ResolveContext,
  transform: Transform,
  warnings: BuildMessage[],
): Promise<DepsBuild> {
  const key = JSON.stringify({
    deps: entries,
    ...(await cacheKeyBase(input, ctx.tree, transform)),
  });
  // Warnings go only to the build that produced them, not to every cache hit.
  return cachedBuild(key, () => buildDeps(entries, input, ctx, transform, warnings)).result;
}

async function buildDeps(
  entries: readonly string[],
  input: BundleInput,
  ctx: ResolveContext,
  transform: Transform,
  warnings: BuildMessage[],
): Promise<DepsBuild> {
  const dependencies = new Set<string>();
  const cssModules = new Map<string, string>();
  try {
    const chunk = await runRolldown(
      DEPS_ENTRY,
      transform,
      workspacePlugin({
        input,
        ctx,
        dependencies,
        // Only reported by the build that produced them, not on every cache hit.
        warnings,
        cssModules,
        workerChain: new Set(),
        depsEntry: { code: depsEntryModule(entries), ids: new Set(entries) },
      }),
      warnings,
      {
        format: "iife",
        name: DEPS_GLOBAL,
        exports: "default",
        sourcemap: input.sourceMaps ? "hidden" : false,
      },
    );
    return {
      ...chunk,
      css: cssModules.size > 0 ? [...cssModules.values()].join("\n") : undefined,
      dependencies,
    };
  } catch (e) {
    const errors = (e as { errors?: RolldownLog[] }).errors;
    if (Array.isArray(errors)) {
      throw new BundleError(errors.map(toMessage), dependencies);
    }
    throw e;
  }
}

/**
 * Concatenates the dependency chunk (if any) and the app chunk into one script
 * with an inline index source map covering both. For classic scripts the pair is
 * wrapped in a function so the deps global doesn't leak onto `window` (where
 * another script's deps would replace it); a module script is already scoped.
 */
function joinChunks(app: Chunk, deps: DepsBuild | undefined, format: "esm" | "iife"): string {
  if (!deps) {
    return app.code + (app.map ? sourceMapComment(app.map) : "");
  }
  const open = format === "iife" ? "(function(){" : "";
  const close = format === "iife" ? "\n})();" : "";
  const depsCode = deps.code.endsWith("\n") ? deps.code : deps.code + "\n";
  const appLine = (open + depsCode).split("\n").length - 1;
  const sections = [];
  if (deps.map) {
    sections.push({ offset: { line: 0, column: open.length }, map: deps.map });
  }
  if (app.map) {
    sections.push({ offset: { line: appLine, column: 0 }, map: app.map });
  }
  const code = open + depsCode + app.code + close;
  return sections.length > 0
    ? code + sourceMapComment({ version: 3, sections } as unknown as RawSourceMap)
    : code;
}

function sourceMapComment(map: RawSourceMap): string {
  const json = new TextEncoder().encode(JSON.stringify(map));
  return `\n//# sourceMappingURL=data:application/json;base64,${toBase64(json)}\n`;
}

function toMessage(log: RolldownLog): BuildMessage {
  // Rolldown prefixes messages with "[CODE] " and appends a code frame; keep only the summary line.
  const text = log.message.replace(/^\[[A-Z_]+\]\s*/, "").split("\n")[0];
  const loc = log.loc;
  const file = loc?.file ?? log.id;
  if (!loc || !file) {
    return { text };
  }
  const frameLine = log.frame?.split("\n").find((l) => l.startsWith(`${loc.line}:`));
  return {
    text,
    location: {
      file,
      line: loc.line,
      column: loc.column,
      lineText: frameLine ? frameLine.slice(frameLine.indexOf(":") + 2) : "",
    },
  };
}

/** Maps the JSX/decorator settings of a raw tsconfig.json onto rolldown's transform options. */
function transformFromTsconfig(tsconfigRaw: string | undefined): InputOptions["transform"] {
  if (!tsconfigRaw) {
    return {};
  }
  let opts: Record<string, unknown> | undefined;
  try {
    // Tolerate the comments and trailing commas tsconfig files usually contain.
    const json = tsconfigRaw
      .replace(
        /("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
        (_m, str: string | undefined) => str ?? "",
      )
      .replace(/,(\s*[}\]])/g, "$1");
    opts = (JSON.parse(json) as { compilerOptions?: Record<string, unknown> }).compilerOptions;
  } catch {
    return {};
  }
  if (!opts) {
    return {};
  }
  const transform: NonNullable<InputOptions["transform"]> = {};
  const jsx = typeof opts.jsx === "string" ? opts.jsx.toLowerCase() : undefined;
  if (jsx === "preserve") {
    transform.jsx = "preserve";
  } else if (jsx === "react") {
    transform.jsx = {
      runtime: "classic",
      pragma: typeof opts.jsxFactory === "string" ? opts.jsxFactory : undefined,
      pragmaFrag: typeof opts.jsxFragmentFactory === "string" ? opts.jsxFragmentFactory : undefined,
    };
  } else if (jsx === "react-jsx" || jsx === "react-jsxdev") {
    transform.jsx = {
      runtime: "automatic",
      development: jsx === "react-jsxdev",
      importSource: typeof opts.jsxImportSource === "string" ? opts.jsxImportSource : undefined,
    };
  }
  if (opts.experimentalDecorators === true) {
    transform.decorator = {
      legacy: true,
      emitDecoratorMetadata: opts.emitDecoratorMetadata === true,
    };
  }
  return transform;
}

/** Vite-style import suffixes: `?url` imports a file's URL, `?worker` a Worker constructor. */
const SUFFIX_RE = /\?(url|worker)$/;

/**
 * Module for a `?worker` import: the worker is bundled separately as ESM, inlined
 * as a string, and started from a blob URL as a module worker (so top-level await,
 * import.meta and external URL imports work). Mirrors Vite's default export shape.
 */
function workerModule(code: string): string {
  return `const code = ${JSON.stringify(code)};
export default function WorkerWrapper(options) {
	const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
	try {
		return new Worker(url, { name: options?.name, type: 'module' });
	} finally {
		URL.revokeObjectURL(url);
	}
}
`;
}

function isExternalUrl(spec: string): boolean {
  return /^(https?:)?\/\//.test(spec) || spec.startsWith("data:");
}

/** A package import like "react" or "@scope/pkg/sub", as opposed to a path. */
function isBare(spec: string): boolean {
  return !spec.startsWith(".") && !spec.startsWith("/");
}

async function resolveSpecifier(
  spec: string,
  importerDir: vscode.Uri,
  root: vscode.Uri,
  ctx: ResolveContext,
): Promise<vscode.Uri | undefined> {
  if (spec.startsWith("./") || spec.startsWith("../") || spec === "." || spec === "..") {
    return resolveFile(vscode.Uri.joinPath(importerDir, spec), ctx);
  }
  if (spec.startsWith("/")) {
    // Vite-style public directory: when it exists, "/" imports resolve only there,
    // and only as an exact file match (no extension or index resolution).
    const publicDir = vscode.Uri.joinPath(root, "public");
    if (await ctx.tree.isDirectory(publicDir)) {
      const inPublic = vscode.Uri.joinPath(publicDir, spec);
      return (await isFile(inPublic, ctx)) ? inPublic : undefined;
    }
    return resolveFile(vscode.Uri.joinPath(root, spec), ctx);
  }
  return resolvePackage(spec, importerDir, ctx);
}

/**
 * Resolves and loads every module through vscode.workspace.fs (instead of the
 * host file system), so dirty editor buffers and virtual workspaces both work.
 */
function workspacePlugin({
  input,
  ctx,
  dependencies,
  warnings,
  cssModules,
  workerChain,
  depEntries,
  depsEntry,
}: {
  input: BundleInput;
  ctx: ResolveContext;
  dependencies: Set<string>;
  warnings: BuildMessage[];
  cssModules: Map<string, string>;
  workerChain: ReadonlySet<string>;
  /** App build: collects node_modules entries imported by project files, which become stubs. */
  depEntries?: Set<string>;
  /** Dependency build: the generated entry module and the entry URIs it imports. */
  depsEntry?: { code: string; ids: ReadonlySet<string> };
}): Plugin {
  const root = input.root;
  const { virtualFiles, tree } = ctx;
  return {
    name: "vscode-workspace",
    async resolveId(spec, importer, { isEntry }) {
      if (isEntry) {
        return spec;
      }
      if (importer === DEPS_ENTRY && depsEntry?.ids.has(spec)) {
        return spec; // already resolved by the app build
      }
      if (isExternalUrl(spec)) {
        return { id: spec, external: true };
      }
      const suffix = SUFFIX_RE.exec(spec)?.[1];
      const path = suffix ? spec.slice(0, -suffix.length - 1) : spec;
      const importerDir = importer ? dirname(vscode.Uri.parse(importer)) : root;
      const resolved = await resolveSpecifier(path, importerDir, root, ctx);
      if (!resolved) {
        this.error(`Could not resolve "${spec}"${importer ? ` from "${importer}"` : ""}`);
      }
      if (
        depEntries &&
        !suffix &&
        isBare(path) &&
        !(importer ?? "").includes("/node_modules/") &&
        resolved.path.includes("/node_modules/") &&
        DEP_LOADERS.has(LOADERS[extname(resolved.path)] ?? "dataurl")
      ) {
        const id = resolved.toString();
        depEntries.add(id);
        return DEP_PREFIX + id;
      }
      // Keep the suffix in the id so `x.js`, `x.js?url` and `x.js?worker` are distinct modules.
      return (suffix ? resolved.with({ query: suffix }) : resolved).toString();
    },

    async load(id) {
      if (id === DEPS_ENTRY && depsEntry) {
        return { code: depsEntry.code, moduleType: "js" };
      }
      if (id.startsWith(DEP_PREFIX)) {
        return { code: depStubModule(id.slice(DEP_PREFIX.length)), moduleType: "js" };
      }
      const parsed = vscode.Uri.parse(id);
      const suffix = parsed.query === "url" || parsed.query === "worker" ? parsed.query : "";
      const uri = suffix ? parsed.with({ query: "" }) : parsed;
      const ext = extname(uri.path);
      dependencies.add(uri.toString());

      if (suffix === "worker") {
        const workerId = uri.toString();
        if (workerChain.has(workerId)) {
          this.error(`Worker "${workerId}" imports itself with ?worker`);
        }
        try {
          const build = () =>
            bundle(
              {
                entry: uri,
                format: "esm",
                root,
                virtualFiles,
                tsconfigRaw: input.tsconfigRaw,
                fileTree: tree,
                sourceMaps: input.sourceMaps,
              },
              new Set([...workerChain, workerId]),
            );
          let out: BundleOutput;
          if (uri.path.includes("/node_modules/")) {
            // Package workers (e.g. Monaco's) don't change between builds; reuse them.
            const base = await cacheKeyBase(
              input,
              tree,
              transformFromTsconfig(input.tsconfigRaw) ?? {},
            );
            const cached = cachedBuild(JSON.stringify({ worker: workerId, ...base }), build);
            out = await cached.result;
            if (!cached.hit) {
              warnings.push(...out.warnings);
            }
          } else {
            out = await build();
            warnings.push(...out.warnings);
          }
          out.dependencies.forEach((d) => dependencies.add(d));
          return { code: workerModule(out.js ?? ""), moduleType: "js" };
        } catch (e) {
          if (!(e instanceof BundleError)) {
            throw e;
          }
          e.dependencies.forEach((d) => dependencies.add(d));
          // Surface the worker's first error with its own location; mention the rest.
          const [first, ...rest] = e.errors;
          const more = rest.length ? ` (and ${rest.length} more error(s))` : "";
          this.error({
            message: `${first.text}${more}`,
            loc: first.location ?? undefined,
            frame: first.location
              ? `${first.location.line}: ${first.location.lineText}`
              : undefined,
          });
        }
      }

      const loader = suffix === "url" ? "dataurl" : (LOADERS[ext] ?? "dataurl");

      switch (loader) {
        case "css":
          cssModules.set(id, await processCss(uri, root, ctx, dependencies, new Set()));
          return { code: "export {};", moduleType: "js" };
        case "dataurl": {
          const url = toDataUrl(await readBytes(uri, virtualFiles), ext);
          return { code: `export default ${JSON.stringify(url)};`, moduleType: "js" };
        }
        case "binary": {
          const b64 = toBase64(await readBytes(uri, virtualFiles));
          return {
            code: `export default Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));`,
            moduleType: "js",
          };
        }
        default:
          return { code: await readText(uri, virtualFiles), moduleType: loader };
      }
    },

    // Loads finish in arbitrary order; sort the CSS by a post-order walk of the
    // import graph (i.e. execution order), matching how a browser would apply it.
    buildEnd(error) {
      if (error || cssModules.size === 0) {
        return;
      }
      const ordered = new Map<string, string>();
      const visited = new Set<string>();
      const visit = (id: string) => {
        if (visited.has(id)) {
          return;
        }
        visited.add(id);
        const info = this.getModuleInfo(id);
        for (const dep of [...(info?.importedIds ?? []), ...(info?.dynamicallyImportedIds ?? [])]) {
          visit(dep);
        }
        const css = cssModules.get(id);
        if (css !== undefined) {
          ordered.set(id, css);
        }
      };
      for (const id of this.getModuleIds()) {
        if (this.getModuleInfo(id)?.isEntry) {
          visit(id);
        }
      }
      cssModules.clear();
      ordered.forEach((css, id) => cssModules.set(id, css));
    },
  };
}

const CSS_IMPORT_RE = /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?\s*([^;]*);/g;
const CSS_URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;

/** Inlines local @imports and turns local url() references into data URLs. */
async function processCss(
  uri: vscode.Uri,
  root: vscode.Uri,
  ctx: ResolveContext,
  dependencies: Set<string>,
  seen: Set<string>,
): Promise<string> {
  const { virtualFiles } = ctx;
  const id = uri.toString();
  if (seen.has(id)) {
    return "";
  }
  seen.add(id);
  dependencies.add(id);
  const dir = dirname(uri);
  let css = await readText(uri, virtualFiles);

  css = await replaceAsync(css, CSS_IMPORT_RE, async (match, _q, spec, media) => {
    if (isExternalUrl(spec)) {
      return match;
    }
    const resolved = await resolveSpecifier(spec, dir, root, ctx);
    if (!resolved) {
      throw new Error(`Could not resolve "${spec}" from "${id}"`);
    }
    const inner = await processCss(resolved, root, ctx, dependencies, seen);
    return media.trim() ? `@media ${media.trim()} {\n${inner}\n}` : inner;
  });

  return replaceAsync(css, CSS_URL_RE, async (match, _q, spec) => {
    if (isExternalUrl(spec) || spec.startsWith("#")) {
      return match;
    }
    // In CSS, url(foo.png) is relative even without "./".
    const path = spec.replace(/[?#].*$/, "");
    const relative = path.startsWith("/") || path.startsWith(".") ? path : "./" + path;
    const resolved = await resolveSpecifier(relative, dir, root, ctx);
    if (!resolved) {
      return match;
    }
    dependencies.add(resolved.toString());
    return `url(${JSON.stringify(toDataUrl(await readBytes(resolved, virtualFiles), extname(resolved.path)))})`;
  });
}

async function replaceAsync(
  input: string,
  re: RegExp,
  fn: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...input.matchAll(re)];
  const replacements = await Promise.all(matches.map((m) => fn(m[0], ...m.slice(1))));
  let out = "";
  let last = 0;
  matches.forEach((m, i) => {
    out += input.slice(last, m.index) + replacements[i];
    last = m.index + m[0].length;
  });
  return out + input.slice(last);
}

/** Base64 without Node's Buffer, which doesn't exist in the web extension host. */
function toBase64(bytes: Uint8Array): string {
  // Build a binary string for btoa in chunks; spreading a large array into
  // String.fromCharCode at once would overflow the call stack.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function toDataUrl(bytes: Uint8Array, ext: string): string {
  return `data:${MIME_TYPES[ext] ?? "application/octet-stream"};base64,${toBase64(bytes)}`;
}

/** Reads from a virtual file or open editor buffer when available (so unsaved edits preview), else from disk. */
async function readText(uri: vscode.Uri, virtualFiles: Map<string, string>): Promise<string> {
  const virtual = virtualFiles.get(uri.toString());
  if (virtual !== undefined) {
    return virtual;
  }
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc) {
    return doc.getText();
  }
  return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

async function readBytes(uri: vscode.Uri, virtualFiles: Map<string, string>): Promise<Uint8Array> {
  const virtual = virtualFiles.get(uri.toString());
  if (virtual !== undefined) {
    return new TextEncoder().encode(virtual);
  }
  return vscode.workspace.fs.readFile(uri);
}

/** How deep below the root FileTree.scan lists directories. */
const SCAN_DEPTH = 5;
/**
 * readDirectory calls in flight at once while scanning. Every one is useful (unlike
 * speculative stats), but the File System Access provider runs them all on the
 * main window, so a small pool is enough to hide latency without flooding it.
 */
const SCAN_CONCURRENCY = 8;
/** Never imported from, and can be large. */
const SCAN_SKIP = new Set([".git"]);

/** A file, a scanned directory's listing, or a directory past the scan depth. */
type TreeEntry = "file" | "unscanned" | Map<string, TreeEntry>;

/**
 * Snapshot of the workspace's file names and types (no contents), taken once per
 * build. In the web extension host every workspace.fs.stat is a round trip to
 * the main window and, for folders opened with the File System Access API, an
 * uncached walk of directory handles from the root that throws on every miss.
 * Module resolution probes ~20 candidate paths per import, nearly all misses;
 * answering those from memory leaves one readDirectory per folder. Paths outside
 * the snapshot (above the root, or deeper than SCAN_DEPTH) fall back to stat.
 */
export class FileTree {
  /** package.json contents, parsed once per build and shared by every import of the package. */
  private readonly packageJsons = new Map<string, Promise<unknown>>();

  private constructor(
    private readonly root: vscode.Uri,
    private readonly top: TreeEntry,
    /** Number of files and folders recorded; for logging. */
    readonly size: number,
    /** Number of folders listed (one readDirectory call each); for logging. */
    readonly directoriesListed: number,
  ) {}

  static async scan(root: vscode.Uri): Promise<FileTree> {
    let top: TreeEntry = "unscanned";
    let size = 0;
    let directoriesListed = 0;
    interface Job {
      uri: vscode.Uri;
      depth: number;
      /** Records the listing (or "unscanned" if it couldn't be read) in the parent. */
      settle: (entry: TreeEntry) => void;
    }
    const pending: Job[] = [{ uri: root, depth: 0, settle: (e) => (top = e) }];

    const list = async ({ uri, depth, settle }: Job) => {
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(uri);
      } catch {
        settle("unscanned");
        return;
      }
      const dir = new Map<string, TreeEntry>();
      settle(dir);
      directoriesListed++;
      size += entries.length;
      for (const [name, type] of entries) {
        if (type & vscode.FileType.Directory) {
          if (depth + 1 >= SCAN_DEPTH || SCAN_SKIP.has(name)) {
            dir.set(name, "unscanned");
          } else {
            dir.set(name, "unscanned"); // until its own listing arrives
            pending.push({
              uri: vscode.Uri.joinPath(uri, name),
              depth: depth + 1,
              settle: (e) => dir.set(name, e),
            });
          }
        } else if (type & vscode.FileType.File) {
          dir.set(name, "file");
        }
      }
    };

    await new Promise<void>((resolve) => {
      let active = 0;
      const pump = () => {
        while (active < SCAN_CONCURRENCY && pending.length > 0) {
          active++;
          void list(pending.pop()!).finally(() => {
            active--;
            pump();
          });
        }
        if (active === 0 && pending.length === 0) {
          resolve();
        }
      };
      pump();
    });
    return new FileTree(root, top, size, directoriesListed);
  }

  /** What's at `uri`, or undefined if it's outside the snapshot and has to be asked for. */
  kind(uri: vscode.Uri): "file" | "dir" | "missing" | undefined {
    if (uri.scheme !== this.root.scheme || uri.authority !== this.root.authority) {
      return undefined;
    }
    const rootPath = this.root.path.replace(/\/$/, "");
    if (uri.path !== rootPath && !uri.path.startsWith(rootPath + "/")) {
      return undefined;
    }
    let entry = this.top;
    for (const segment of uri.path.slice(rootPath.length).split("/")) {
      if (!segment) {
        continue;
      }
      if (entry === "file") {
        return "missing";
      }
      if (entry === "unscanned") {
        return undefined;
      }
      const next = entry.get(segment);
      if (next === undefined) {
        return "missing";
      }
      entry = next;
    }
    return entry === "file" ? "file" : "dir";
  }

  async isFile(uri: vscode.Uri): Promise<boolean> {
    const known = this.kind(uri);
    if (known !== undefined) {
      return known === "file";
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return (stat.type & vscode.FileType.File) !== 0;
    } catch {
      return false;
    }
  }

  async isDirectory(uri: vscode.Uri): Promise<boolean> {
    const known = this.kind(uri);
    if (known !== undefined) {
      return known === "dir";
    }
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      return (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
      return false;
    }
  }

  readJson(uri: vscode.Uri): Promise<unknown> {
    const key = uri.toString();
    let json = this.packageJsons.get(key);
    if (!json) {
      json = this.kind(uri) === "missing" ? Promise.resolve(undefined) : readJson(uri);
      this.packageJsons.set(key, json);
    }
    return json;
  }
}

async function readJson(uri: vscode.Uri): Promise<unknown> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

async function isFile(uri: vscode.Uri, ctx: ResolveContext): Promise<boolean> {
  return ctx.virtualFiles.has(uri.toString()) || ctx.tree.isFile(uri);
}

interface ResolveContext {
  virtualFiles: Map<string, string>;
  tree: FileTree;
}

/** Node/TypeScript-style file resolution: exact, `.js`→`.ts` swap, extensions, then index files. */
async function resolveFile(base: vscode.Uri, ctx: ResolveContext): Promise<vscode.Uri | undefined> {
  if (await isFile(base, ctx)) {
    return base;
  }
  // TypeScript ESM convention: `import "./foo.js"` refers to foo.ts.
  const ext = extname(base.path);
  const swaps: Record<string, string[]> = {
    ".js": [".ts", ".tsx"],
    ".jsx": [".tsx"],
    ".mjs": [".mts"],
    ".cjs": [".cts"],
  };
  for (const swap of swaps[ext] ?? []) {
    const candidate = base.with({ path: base.path.slice(0, -ext.length) + swap });
    if (await isFile(candidate, ctx)) {
      return candidate;
    }
  }
  for (const e of RESOLVE_EXTENSIONS) {
    const candidate = base.with({ path: base.path + e });
    if (await isFile(candidate, ctx)) {
      return candidate;
    }
  }
  for (const e of RESOLVE_EXTENSIONS) {
    const candidate = vscode.Uri.joinPath(base, "index" + e);
    if (await isFile(candidate, ctx)) {
      return candidate;
    }
  }
  return undefined;
}

async function resolvePackage(
  spec: string,
  fromDir: vscode.Uri,
  ctx: ResolveContext,
): Promise<vscode.Uri | undefined> {
  const parts = spec.split("/");
  const nameLength = spec.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, nameLength).join("/");
  const subpath = parts.slice(nameLength).join("/");

  // Walk up from the importer looking for node_modules/<name>.
  let dir = fromDir;
  while (true) {
    const pkgDir = vscode.Uri.joinPath(dir, "node_modules", name);
    const pkg = (await ctx.tree.readJson(vscode.Uri.joinPath(pkgDir, "package.json"))) as
      | PackageJson
      | undefined;
    if (pkg) {
      return resolveInPackage(pkgDir, pkg, subpath, ctx);
    }
    const parent = dirname(dir);
    if (parent.path === dir.path) {
      return undefined;
    }
    dir = parent;
  }
}

interface PackageJson {
  exports?: unknown;
  browser?: unknown;
  module?: unknown;
  main?: unknown;
}

async function resolveInPackage(
  pkgDir: vscode.Uri,
  pkg: PackageJson,
  subpath: string,
  ctx: ResolveContext,
): Promise<vscode.Uri | undefined> {
  if (pkg.exports !== undefined) {
    const target = resolveExports(pkg.exports, subpath ? "./" + subpath : ".");
    if (target) {
      return resolveFile(vscode.Uri.joinPath(pkgDir, target), ctx);
    }
  }
  if (subpath) {
    return resolveFile(vscode.Uri.joinPath(pkgDir, subpath), ctx);
  }
  for (const field of [pkg.browser, pkg.module, pkg.main]) {
    if (typeof field === "string") {
      const resolved = await resolveFile(vscode.Uri.joinPath(pkgDir, field), ctx);
      if (resolved) {
        return resolved;
      }
    }
  }
  return resolveFile(vscode.Uri.joinPath(pkgDir, "index"), ctx);
}

/** Minimal implementation of package.json "exports" with conditions and "*" patterns. */
function resolveExports(exports: unknown, subpath: string): string | undefined {
  const isSubpathMap =
    typeof exports === "object" &&
    exports !== null &&
    !Array.isArray(exports) &&
    Object.keys(exports).some((k) => k.startsWith("."));
  if (!isSubpathMap) {
    return subpath === "." ? pickCondition(exports) : undefined;
  }
  const map = exports as Record<string, unknown>;
  if (subpath in map) {
    return pickCondition(map[subpath]);
  }
  for (const [key, value] of Object.entries(map)) {
    const star = key.indexOf("*");
    if (star === -1) {
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= key.length - 1
    ) {
      const match = subpath.slice(prefix.length, subpath.length - suffix.length);
      return pickCondition(value)?.split("*").join(match);
    }
  }
  return undefined;
}

function pickCondition(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const r = pickCondition(v);
      if (r) {
        return r;
      }
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const cond of EXPORT_CONDITIONS) {
      if (cond in obj) {
        const r = pickCondition(obj[cond]);
        if (r) {
          return r;
        }
      }
    }
  }
  return undefined;
}

export function dirname(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, "..");
}

export function extname(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}
