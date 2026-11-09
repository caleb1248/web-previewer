import * as vscode from "vscode";
import { bundle, BundleError, dirname, FileTree } from "./bundler";
import type { BuildMessage as Message } from "./bundler";

export interface RenderOptions {
  htmlUri: vscode.Uri;
  html: string;
  /** Root for absolute ("/foo.ts") references; the workspace folder containing the HTML file. */
  root: vscode.Uri;
  tsconfigRaw?: string;
  /** Emit inline source maps (the jsPreview.sourceMaps setting). */
  sourceMaps?: boolean;
  webview: vscode.Webview;
  outputChannel: vscode.LogOutputChannel;
}

export interface RenderResult {
  html: string;
  dependencies: Set<string>;
  errors: Message[];
  warnings: Message[];
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const LINK_RE = /<link\b([^>]*?)\/?>/gi;
const HEAD_RE = /<head\b[^>]*>/i;
const HTML_RE = /<html\b[^>]*>/i;

function basename(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf("/") + 1);
}

/**
 * Turns the user's HTML page into something a webview can display: local
 * <script src> / inline module scripts / stylesheets are bundled with rolldown
 * and inlined, and a <base> tag points relative URLs (images, fetch) at the
 * workspace through the webview resource scheme.
 */
export async function renderPreview(opts: RenderOptions): Promise<RenderResult> {
  const htmlDir = dirname(opts.htmlUri);
  const dependencies = new Set<string>([opts.htmlUri.toString()]);
  const errors: Message[] = [];
  const warnings: Message[] = [];
  let inlineCounter = 0;

  // One snapshot of the workspace for every script and stylesheet on the page,
  // taken the first time something needs bundling.
  let fileTree: Promise<FileTree> | undefined;
  const getFileTree = () => {
    if (!fileTree) {
      const started = Date.now();
      opts.outputChannel.info(`[file tree] scanning ${opts.root.toString(true)}...`);
      fileTree = FileTree.scan(opts.root).then((tree) => {
        opts.outputChannel.info(
          `[file tree] scanned ${tree.size} entries (${tree.directoriesListed} folders listed) ` +
            `in ${Date.now() - started}ms`,
        );
        return tree;
      });
    }
    return fileTree;
  };

  const runBundle = async (
    entry: vscode.Uri,
    format: "esm" | "iife",
    virtualFiles?: Map<string, string>,
  ) => {
    try {
      const tree = await getFileTree();
      opts.outputChannel.info(`[${basename(entry)}] bundling...`);
      const out = await bundle({
        entry,
        format,
        root: opts.root,
        tsconfigRaw: opts.tsconfigRaw,
        sourceMaps: opts.sourceMaps,
        virtualFiles,
        fileTree: tree,
      });
      out.dependencies.forEach((d) => dependencies.add(d));
      warnings.push(...out.warnings);
      return out;
    } catch (e) {
      if (e instanceof BundleError) {
        e.dependencies.forEach((d) => dependencies.add(d));
        errors.push(...e.errors);
        return undefined;
      }
      throw e;
    }
  };

  // Stylesheets first, so bundled script text is never scanned for <link> tags.
  let html = await replaceAsync(opts.html, LINK_RE, async (match, rawAttrs: string) => {
    const attrs = parseAttributes(rawAttrs);
    const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attrs.get("href");
    if (!rel.includes("stylesheet") || href === undefined || !isLocalUrl(href)) {
      return match;
    }
    const out = await runBundle(resolveUrl(href, htmlDir, opts.root), "esm");
    if (!out) {
      return `<!-- js-preview: failed to bundle ${escapeHtml(href)} -->`;
    }
    const media = attrs.get("media");
    return `<style${media ? ` media="${escapeHtml(media)}"` : ""}>${escapeStyle(out.css ?? "")}</style>`;
  });

  html = await replaceAsync(html, SCRIPT_RE, async (match, rawAttrs: string, body: string) => {
    const attrs = parseAttributes(rawAttrs);
    const type = (attrs.get("type") ?? "").toLowerCase();
    const isModule = type === "module";
    const isClassic = type === "" || /^(text|application)\/(java|ecma|type)script$/.test(type);
    if (!isModule && !isClassic) {
      return match; // importmap, JSON data blocks, templates, etc.
    }

    const src = attrs.get("src");
    let out;
    if (src !== undefined) {
      if (!isLocalUrl(src)) {
        return match;
      }
      const entry = resolveUrl(src, htmlDir, opts.root);
      // Module scripts run as ESM; classic ones get wrapped in an IIFE.
      out = await runBundle(entry, isModule ? "esm" : "iife");
    } else if (isModule) {
      // Inline module scripts may import local files, so they need bundling too.
      const entry = vscode.Uri.joinPath(htmlDir, `__inline_script_${inlineCounter++}.ts`);
      out = await runBundle(entry, "esm", new Map([[entry.toString(), body]]));
    } else {
      return match;
    }
    if (!out) {
      return `<!-- js-preview: failed to bundle ${escapeHtml(src ?? "inline script")} -->`;
    }

    // An inlined classic script loses defer/async semantics; running it as a
    // module restores "after the document is parsed" timing.
    const deferred = isModule || attrs.has("defer") || attrs.has("async");
    let result = "";
    if (out.css) {
      result += `<style>${escapeStyle(out.css)}</style>`;
    }
    if (out.js) {
      result += `<script${deferred ? ' type="module"' : ""}>${escapeScript(out.js)}</script>`;
    }
    return result;
  });

  html = injectHead(html, headPrelude(opts.webview, htmlDir));
  if (errors.length > 0) {
    html = injectHead(html, errorOverlay(errors));
  }
  return { html, dependencies, errors, warnings };
}

function headPrelude(webview: vscode.Webview, htmlDir: vscode.Uri): string {
  const source = webview.cspSource;
  const csp = [
    `default-src ${source} https: data: blob:`,
    `script-src ${source} https: data: blob: 'unsafe-inline' 'unsafe-eval'`,
    `style-src ${source} https: data: 'unsafe-inline'`,
    `img-src ${source} https: data: blob:`,
    `font-src ${source} https: data:`,
    `media-src ${source} https: data: blob:`,
    `connect-src ${source} https: wss: data: blob:`,
    `worker-src ${source} blob: data:`,
  ].join("; ");
  const base = webview.asWebviewUri(htmlDir).toString().replace(/\/?$/, "/");
  return (
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<base href="${escapeHtml(base)}">` +
    `<script>${CONSOLE_BRIDGE}</script>`
  );
}

/** Forwards console output and uncaught errors to the extension's output channel. */
const CONSOLE_BRIDGE = `(() => {
	const vscode = acquireVsCodeApi();
	window.acquireVsCodeApi = () => vscode;
	const fmt = (v) => {
		if (v instanceof Error) return v.stack || String(v);
		if (typeof v === 'string') return v;
		try { return JSON.stringify(v); } catch { return String(v); }
	};
	for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
		const orig = console[level].bind(console);
		console[level] = (...args) => {
			orig(...args);
			try { vscode.postMessage({ type: 'console', level, text: args.map(fmt).join(' ') }); } catch {}
		};
	}
	window.addEventListener('error', (e) => {
		vscode.postMessage({ type: 'console', level: 'error', text: 'Uncaught ' + fmt(e.error ?? e.message) });
	});
	window.addEventListener('unhandledrejection', (e) => {
		vscode.postMessage({ type: 'console', level: 'error', text: 'Unhandled rejection: ' + fmt(e.reason) });
	});
})();`;

function errorOverlay(errors: Message[]): string {
  const items = errors
    .map((e) => {
      const loc = e.location
        ? `<div class="loc">${escapeHtml(decodeURIComponent(e.location.file.replace(/^vfs:/, "")))}:${e.location.line}:${e.location.column}</div>` +
          `<pre>${escapeHtml(e.location.lineText)}</pre>`
        : "";
      return `<li><div class="msg">${escapeHtml(e.text)}</div>${loc}</li>`;
    })
    .join("");
  return (
    `<style>
#__wp_errors{position:fixed;inset:0;z-index:2147483647;overflow:auto;background:rgba(20,0,0,.92);color:#fff;
font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;padding:24px}
#__wp_errors h1{font-size:16px;color:#ff6b6b;margin:0 0 12px}
#__wp_errors ul{list-style:none;padding:0;margin:0}
#__wp_errors li{margin:0 0 16px;padding:12px;background:rgba(255,255,255,.06);border-left:3px solid #ff6b6b}
#__wp_errors .loc{color:#aaa}#__wp_errors pre{margin:4px 0 0;white-space:pre-wrap}
#__wp_errors button{position:absolute;top:16px;right:16px;background:none;border:1px solid #888;color:#fff;cursor:pointer}
</style><template id="__wp_errors_tpl"><div id="__wp_errors"><button onclick="this.parentNode.remove()">Dismiss</button>` +
    `<h1>Build failed</h1><ul>${items}</ul></div></template>` +
    `<script>addEventListener('DOMContentLoaded',()=>document.body.appendChild(document.getElementById('__wp_errors_tpl').content.cloneNode(true)))</script>`
  );
}

function injectHead(html: string, content: string): string {
  const head = HEAD_RE.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + content + html.slice(at);
  }
  const root = HTML_RE.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + `<head>${content}</head>` + html.slice(at);
  }
  return `<head>${content}</head>` + html;
}

function isLocalUrl(url: string): boolean {
  return !/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
}

function resolveUrl(url: string, htmlDir: vscode.Uri, root: vscode.Uri): vscode.Uri {
  const path = decodeURIComponent(url.replace(/[?#].*$/, ""));
  return path.startsWith("/")
    ? vscode.Uri.joinPath(root, path)
    : vscode.Uri.joinPath(htmlDir, path);
}

function parseAttributes(raw: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    attrs.set(m[1].toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return attrs;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Prevents a literal "</script" in bundled code from closing the inline tag. */
function escapeScript(js: string): string {
  return js.replace(/<\/(script)/gi, "<\\/$1");
}

function escapeStyle(css: string): string {
  return css.replace(/<\/(style)/gi, "<\\/$1");
}

async function replaceAsync(
  input: string,
  re: RegExp,
  fn: (match: string, ...groups: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...input.matchAll(re)];
  // Bundle all tags concurrently, then splice results back in order.
  const replacements = await Promise.all(matches.map((m) => fn(m[0], ...m.slice(1))));
  let out = "";
  let last = 0;
  matches.forEach((m, i) => {
    out += input.slice(last, m.index) + replacements[i];
    last = m.index! + m[0].length;
  });
  return out + input.slice(last);
}
