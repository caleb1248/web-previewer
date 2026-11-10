# JS Preview

Preview large Typescript/React Projects in `vscode.dev`, powered by Rolldown.

## How to use

- Navigate to your html file
- Open the command palette and run "start web preview" (or click the preview icon in the editor title bar / right-click the file in the explorer)
- A webview will open up in an editor to the side
- The preview rebuilds when you save a file and when files change on disk
- `console.*` output and uncaught errors from the page show up in the "JS Preview" output channel
- Run "refresh web preview" to force a rebuild

## Notes

- Bun is the current package manager in order to speed up development.

## Under the hood

- Scans the HTML for scripts, which are then passed in as Rolldown entrypoints.
  - `<script src="...">` pointing at local files (`.ts`, `.tsx`, `.js`, ...) is bundled and inlined. `type="module"` scripts are bundled as ESM, classic scripts as an IIFE.
  - inline `<script type="module">` blocks are bundled too, so they can import local files and packages.
  - `<link rel="stylesheet">` pointing at local files is bundled (resolving `@import`) and inlined as `<style>`. CSS imported from scripts is inlined as well.
  - remote URLs, import maps and other script types are left untouched.
- All module resolution and file reads go through a custom esbuild plugin backed by `vscode.workspace.fs` (preferring open editor buffers), not Node's `fs`, so it can work in vscode.dev later.
  - relative, root-absolute (`/src/main.ts`, relative to the workspace folder) and bare (`node_modules`) imports are supported, including `package.json` `exports` (with conditions and `*` patterns), `browser`, `module` and `main`.
  - TypeScript-style `./foo.js` → `foo.ts` resolution and extensionless/`index` imports work.
  - the workspace folder's `tsconfig.json` is passed to esbuild (`tsconfigRaw`), so JSX settings etc. are respected.
  - images, fonts and other assets imported from code are inlined as data URLs.
- A `<base>` tag pointing at the HTML file's folder (via `asWebviewUri`) makes relative images, `fetch()` calls, etc. resolve to workspace files.
- Build errors are shown as an overlay on top of the page and logged to the output channel.
