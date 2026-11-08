import * as vscode from 'vscode';
// The browser build of esbuild-wasm runs the compiler in-process from a
// WebAssembly module, so the same code works on desktop and (later) vscode.dev.
import * as esbuild from 'esbuild-wasm/lib/browser.js';

const NAMESPACE = 'vfs';

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css'];

const EXPORT_CONDITIONS = ['browser', 'import', 'module', 'default', 'require'];

const LOADERS: Record<string, esbuild.Loader> = {
	'.ts': 'ts', '.mts': 'ts', '.cts': 'ts',
	'.tsx': 'tsx',
	'.js': 'js', '.mjs': 'js', '.cjs': 'js',
	'.jsx': 'jsx',
	'.json': 'json',
	'.css': 'css',
	'.txt': 'text', '.md': 'text', '.html': 'text', '.glsl': 'text', '.wgsl': 'text',
	'.png': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl', '.gif': 'dataurl', '.webp': 'dataurl',
	'.avif': 'dataurl', '.svg': 'dataurl', '.ico': 'dataurl', '.bmp': 'dataurl',
	'.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.otf': 'dataurl', '.eot': 'dataurl',
	'.mp3': 'dataurl', '.wav': 'dataurl', '.ogg': 'dataurl', '.mp4': 'dataurl', '.webm': 'dataurl',
	'.wasm': 'binary',
};

let initPromise: Promise<void> | undefined;

/** Loads esbuild.wasm (shipped in dist/) and starts esbuild once per session. */
export function initializeEsbuild(extensionUri: vscode.Uri): Promise<void> {
	if (!initPromise) {
		initPromise = (async () => {
			// esbuild's browser build expects `self` to exist; the desktop
			// extension host is Node, which only has `globalThis`.
			const g = globalThis as Record<string, unknown>;
			if (g.self === undefined) {
				g.self = globalThis;
			}
			const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, 'dist', 'esbuild.wasm'));
			// tsconfig has no DOM lib, so reach WebAssembly through globalThis.
			const wasm = (globalThis as unknown as { WebAssembly: { compile(b: Uint8Array): Promise<object> } }).WebAssembly;
			const wasmModule = await wasm.compile(bytes);
			await esbuild.initialize({ wasmModule: wasmModule as esbuild.InitializeOptions['wasmModule'], worker: false });
		})();
		initPromise.catch(() => { initPromise = undefined; });
	}
	return initPromise;
}

export interface BundleInput {
	/** URI of the entry file, or of a virtual file registered in `virtualFiles`. */
	entry: vscode.Uri;
	format: 'esm' | 'iife';
	/** In-memory file contents (e.g. inline <script type="module"> blocks). */
	virtualFiles?: Map<string, string>;
	/** Root used for absolute imports like "/src/main.ts" and as the node_modules search ceiling. */
	root: vscode.Uri;
	tsconfigRaw?: string;
}

export interface BundleOutput {
	js?: string;
	css?: string;
	warnings: esbuild.Message[];
	/** Every file read while bundling, as URI strings; used for live reload. */
	dependencies: Set<string>;
}

export class BundleError extends Error {
	constructor(public readonly errors: esbuild.Message[], public readonly dependencies: Set<string>) {
		super(errors.map(e => e.text).join('\n'));
	}
}

export async function bundle(input: BundleInput): Promise<BundleOutput> {
	const dependencies = new Set<string>();
	const virtualFiles = input.virtualFiles ?? new Map<string, string>();
	const isCss = extname(input.entry.path) === '.css';

	try {
		const result = await esbuild.build({
			entryPoints: [input.entry.toString()],
			bundle: true,
			write: false,
			outdir: '/out',
			format: isCss ? undefined : input.format,
			platform: 'browser',
			target: 'es2022',
			sourcemap: 'inline',
			logLevel: 'silent',
			charset: 'utf8',
			define: {
				'process.env.NODE_ENV': '"development"',
			},
			tsconfigRaw: input.tsconfigRaw,
			plugins: [workspacePlugin(input.root, virtualFiles, dependencies)],
		});
		const out: BundleOutput = { warnings: result.warnings, dependencies };
		for (const file of result.outputFiles ?? []) {
			if (file.path.endsWith('.css')) {
				out.css = (out.css ?? '') + file.text;
			} else if (file.path.endsWith('.js')) {
				out.js = (out.js ?? '') + file.text;
			}
		}
		return out;
	} catch (e) {
		const failure = e as esbuild.BuildFailure;
		if (Array.isArray(failure.errors)) {
			throw new BundleError(failure.errors, dependencies);
		}
		throw e;
	}
}

/**
 * Resolves and loads every module through vscode.workspace.fs (instead of the
 * host file system), so dirty editor buffers and virtual workspaces both work.
 */
function workspacePlugin(root: vscode.Uri, virtualFiles: Map<string, string>, dependencies: Set<string>): esbuild.Plugin {
	return {
		name: 'vscode-workspace',
		setup(build) {
			build.onResolve({ filter: /.*/ }, async args => {
				if (args.kind === 'entry-point') {
					return { path: args.path, namespace: NAMESPACE };
				}
				const spec = args.path;
				if (/^(https?:)?\/\//.test(spec) || spec.startsWith('data:')) {
					return { path: spec, external: true };
				}

				const importerDir = args.importer && args.namespace === NAMESPACE
					? dirname(vscode.Uri.parse(args.importer))
					: root;

				let resolved: vscode.Uri | undefined;
				if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
					resolved = await resolveFile(vscode.Uri.joinPath(importerDir, spec), virtualFiles);
				} else if (spec.startsWith('/')) {
					resolved = await resolveFile(vscode.Uri.joinPath(root, spec), virtualFiles);
				} else {
					resolved = await resolvePackage(spec, importerDir, virtualFiles);
				}

				if (!resolved) {
					return { errors: [{ text: `Could not resolve "${spec}"` }] };
				}
				return { path: resolved.toString(), namespace: NAMESPACE };
			});

			build.onLoad({ filter: /.*/, namespace: NAMESPACE }, async args => {
				const uri = vscode.Uri.parse(args.path);
				const ext = extname(uri.path);
				const loader = LOADERS[ext] ?? 'file';
				dependencies.add(args.path);

				const virtual = virtualFiles.get(args.path);
				if (virtual !== undefined) {
					return { contents: virtual, loader };
				}
				return { contents: await readFile(uri, loader), loader };
			});
		},
	};
}

/** Reads from an open editor buffer when available (so unsaved edits preview), else from disk. */
async function readFile(uri: vscode.Uri, loader: esbuild.Loader): Promise<string | Uint8Array> {
	const isText = loader !== 'dataurl' && loader !== 'binary' && loader !== 'file';
	if (isText) {
		const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
		if (doc) {
			return doc.getText();
		}
	}
	return vscode.workspace.fs.readFile(uri);
}

async function isFile(uri: vscode.Uri, virtualFiles: Map<string, string>): Promise<boolean> {
	if (virtualFiles.has(uri.toString())) {
		return true;
	}
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		return (stat.type & vscode.FileType.File) !== 0;
	} catch {
		return false;
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

/** Node/TypeScript-style file resolution: exact, extensions, `.js`→`.ts` swap, then index files. */
async function resolveFile(base: vscode.Uri, virtualFiles: Map<string, string>): Promise<vscode.Uri | undefined> {
	if (await isFile(base, virtualFiles)) {
		return base;
	}
	// TypeScript ESM convention: `import "./foo.js"` refers to foo.ts.
	const tsSwaps: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
	const ext = extname(base.path);
	for (const swap of tsSwaps[ext] ?? []) {
		const candidate = base.with({ path: base.path.slice(0, -ext.length) + swap });
		if (await isFile(candidate, virtualFiles)) {
			return candidate;
		}
	}
	for (const e of RESOLVE_EXTENSIONS) {
		const candidate = base.with({ path: base.path + e });
		if (await isFile(candidate, virtualFiles)) {
			return candidate;
		}
	}
	for (const e of RESOLVE_EXTENSIONS) {
		const candidate = vscode.Uri.joinPath(base, 'index' + e);
		if (await isFile(candidate, virtualFiles)) {
			return candidate;
		}
	}
	return undefined;
}

async function resolvePackage(spec: string, fromDir: vscode.Uri, virtualFiles: Map<string, string>): Promise<vscode.Uri | undefined> {
	const parts = spec.split('/');
	const nameLength = spec.startsWith('@') ? 2 : 1;
	const name = parts.slice(0, nameLength).join('/');
	const subpath = parts.slice(nameLength).join('/');

	// Walk up from the importer looking for node_modules/<name>.
	let dir: vscode.Uri | undefined = fromDir;
	while (dir) {
		const pkgDir = vscode.Uri.joinPath(dir, 'node_modules', name);
		const pkg = await readJson(vscode.Uri.joinPath(pkgDir, 'package.json')) as PackageJson | undefined;
		if (pkg) {
			return resolveInPackage(pkgDir, pkg, subpath, virtualFiles);
		}
		const parent = dirname(dir);
		dir = parent.path === dir.path ? undefined : parent;
	}
	return undefined;
}

interface PackageJson {
	exports?: unknown;
	browser?: unknown;
	module?: unknown;
	main?: unknown;
}

async function resolveInPackage(pkgDir: vscode.Uri, pkg: PackageJson, subpath: string, virtualFiles: Map<string, string>): Promise<vscode.Uri | undefined> {
	if (pkg.exports !== undefined) {
		const target = resolveExports(pkg.exports, subpath ? './' + subpath : '.');
		if (target) {
			return resolveFile(vscode.Uri.joinPath(pkgDir, target), virtualFiles);
		}
	}
	if (subpath) {
		return resolveFile(vscode.Uri.joinPath(pkgDir, subpath), virtualFiles);
	}
	for (const field of [pkg.browser, pkg.module, pkg.main]) {
		if (typeof field === 'string') {
			const resolved = await resolveFile(vscode.Uri.joinPath(pkgDir, field), virtualFiles);
			if (resolved) {
				return resolved;
			}
		}
	}
	return resolveFile(vscode.Uri.joinPath(pkgDir, 'index'), virtualFiles);
}

/** Minimal implementation of package.json "exports" with conditions and "*" patterns. */
function resolveExports(exports: unknown, subpath: string): string | undefined {
	const isSubpathMap = typeof exports === 'object' && exports !== null && !Array.isArray(exports)
		&& Object.keys(exports).some(k => k.startsWith('.'));
	if (!isSubpathMap) {
		return subpath === '.' ? pickCondition(exports) : undefined;
	}
	const map = exports as Record<string, unknown>;
	if (subpath in map) {
		return pickCondition(map[subpath]);
	}
	for (const [key, value] of Object.entries(map)) {
		const star = key.indexOf('*');
		if (star === -1) {
			continue;
		}
		const prefix = key.slice(0, star);
		const suffix = key.slice(star + 1);
		if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1) {
			const match = subpath.slice(prefix.length, subpath.length - suffix.length);
			return pickCondition(value)?.split('*').join(match);
		}
	}
	return undefined;
}

function pickCondition(value: unknown): string | undefined {
	if (typeof value === 'string') {
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
	if (value && typeof value === 'object') {
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
	return vscode.Uri.joinPath(uri, '..');
}

export function extname(path: string): string {
	const base = path.slice(path.lastIndexOf('/') + 1);
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot).toLowerCase() : '';
}
