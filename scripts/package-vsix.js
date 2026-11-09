// Builds the extension packages: one per platform with that platform's native
// rolldown binding (plus the WASI fallback), and a universal one with only the
// WASI binding. The Marketplace serves the universal package on platforms with
// no specific package. The web package has no bindings.
// vsce runs the vscode:prepublish build before each package; that build copies
// the bindings for VSCE_TARGET from node_modules into dist/node_modules (see
// esbuild.js). Needs every platform's binding installed:
//   bun install --os='*' --cpu='*'
//
//   bun scripts/package-vsix.js                     # every target + universal
//   bun scripts/package-vsix.js win32-x64 linux-x64 # just these
//   bun scripts/package-vsix.js universal           # just the universal package

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const ALL_TARGETS = [
  "win32-x64",
  "win32-arm64",
  "linux-x64",
  "linux-arm64",
  "linux-armhf",
  "alpine-x64",
  "alpine-arm64",
  "darwin-x64",
  "darwin-arm64",
  // VS Code for the Web: no rolldown bindings (the web only runs the browser build).
  "web",
];

function run(cmd, args, env) {
  execFileSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
}

// "universal" isn't a vsce target: it's the package built without --target.
const UNIVERSAL = "universal";
const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== UNIVERSAL && !ALL_TARGETS.includes(a));
if (unknown.length > 0) {
  console.error(
    `Unknown target(s): ${unknown.join(", ")}. Valid: ${UNIVERSAL}, ${ALL_TARGETS.join(", ")}`,
  );
  process.exit(1);
}
const targets = args.length > 0 ? [...new Set(args)] : [...ALL_TARGETS, UNIVERSAL];

const { name, version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
fs.mkdirSync(path.join(ROOT, "vsix"), { recursive: true });

for (const target of targets) {
  const out = path.join("vsix", `${name}-${target}-${version}.vsix`);
  run("bunx", [
    "@vscode/vsce",
    "package",
    ...(target === UNIVERSAL ? [] : ["--target", target]),
    // Dependencies are bundled by esbuild or staged into dist/node_modules; vsce
    // shouldn't collect node_modules itself.
    "--no-dependencies",
    "--out",
    out,
  ], {
    // Read by esbuild.js (via vscode:prepublish) to pick which rolldown bindings to ship.
    VSCE_TARGET: target,
  });
}

// Leave dist/ as a development build would have it.
fs.rmSync(path.join(ROOT, "dist", "node_modules"), { recursive: true, force: true });
