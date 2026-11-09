import * as vscode from "vscode";
import { dirname, invalidateBuildCache } from "./bundler";
import { renderPreview } from "./html";

const REBUILD_DELAY_MS = 300;

/** One webview panel previewing one HTML file, rebuilt whenever a dependency changes. */
export class PreviewPanel implements vscode.Disposable {
  private static readonly panels = new Map<string, PreviewPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private dependencies = new Set<string>();
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  private buildGeneration = 0;
  /** Closes the "building" notification; set while one is showing. */
  private finishProgress: (() => void) | undefined;

  static show(
    context: vscode.ExtensionContext,
    htmlUri: vscode.Uri,
    output: vscode.LogOutputChannel,
  ): void {
    const existing = PreviewPanel.panels.get(htmlUri.toString());
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      existing.rebuild();
      return;
    }
    PreviewPanel.panels.set(htmlUri.toString(), new PreviewPanel(context, htmlUri, output));
  }

  static refreshAll(): void {
    PreviewPanel.panels.forEach((p) => p.rebuild());
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly htmlUri: vscode.Uri,
    private readonly output: vscode.LogOutputChannel,
  ) {
    const root = this.root();
    const roots = [
      root,
      dirname(htmlUri),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
    ];
    this.panel = vscode.window.createWebviewPanel(
      "jsPreview.preview",
      `Preview ${basename(htmlUri)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, enableForms: true, localResourceRoots: roots },
    );
    this.panel.iconPath = new vscode.ThemeIcon("preview");

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("jsPreview.sourceMaps", htmlUri)) {
          this.rebuild();
        }
      }),
    );
    // Rebuilds come only from the file system: saves from the editor and changes
    // made outside it (git checkout, codegen, bun install...).
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, "**/*"),
    );
    watcher.onDidChange((uri) => this.onFileChanged(uri));
    watcher.onDidCreate(() => this.scheduleRebuild()); // a new file may satisfy a failed import
    watcher.onDidDelete((uri) => this.onFileChanged(uri));
    this.disposables.push(watcher);

    this.panel.webview.html = loadingPage();
    this.rebuild();
  }

  private root(): vscode.Uri {
    return vscode.workspace.getWorkspaceFolder(this.htmlUri)?.uri ?? dirname(this.htmlUri);
  }

  private onFileChanged(uri: vscode.Uri): void {
    const key = uri.toString();
    if (key.includes("/node_modules/")) {
      invalidateBuildCache(key);
    }
    if (this.dependencies.has(key) || key.endsWith("/tsconfig.json")) {
      this.scheduleRebuild();
    }
  }

  private scheduleRebuild(): void {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.rebuild(), REBUILD_DELAY_MS);
  }

  /**
   * Rebuilds the preview. One "building" notification stays up while builds are
   * running, including ones that supersede each other, and closes when the
   * newest build finishes.
   */
  async rebuild(): Promise<void> {
    if (!this.finishProgress) {
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => (finish = resolve));
      this.finishProgress = finish;
      void vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Web Previewer: building ${basename(this.htmlUri)}...`,
        },
        () => finished,
      );
    }
    const build = this.build(); // bumps buildGeneration synchronously
    const generation = this.buildGeneration;
    try {
      await build;
    } finally {
      if (generation === this.buildGeneration) {
        this.closeProgress();
      }
    }
  }

  private closeProgress(): void {
    this.finishProgress?.();
    this.finishProgress = undefined;
  }

  private async build(): Promise<void> {
    // @ts-ignore
    globalThis.currentPerf = performance.now();
    clearTimeout(this.rebuildTimer);
    const generation = ++this.buildGeneration;
    const started = Date.now();
    try {
      const html = await readText(this.htmlUri);
      const tsconfigRaw = await readTsconfig(this.root());
      const result = await renderPreview({
        htmlUri: this.htmlUri,
        html: html ?? "",
        root: this.root(),
        tsconfigRaw,
        sourceMaps: vscode.workspace
          .getConfiguration("jsPreview", this.htmlUri)
          .get<boolean>("sourceMaps", false),
        webview: this.panel.webview,
        outputChannel: this.output,
      });
      if (generation !== this.buildGeneration) {
        return; // a newer build superseded this one
      }
      this.dependencies = result.dependencies;
      if (tsconfigRaw !== undefined) {
        this.dependencies.add(vscode.Uri.joinPath(this.root(), "tsconfig.json").toString());
      }
      for (const w of result.warnings) {
        this.output.warn(`[build] ${formatMessage(w)}`);
      }
      for (const e of result.errors) {
        this.output.error(`[build] ${formatMessage(e)}`);
      }
      const summary = `[${basename(this.htmlUri)}] built in ${Date.now() - started}ms`;
      if (result.errors.length) {
        this.output.error(`${summary} with ${result.errors.length} error(s)`);
      } else {
        this.output.info(summary);
      }
      this.panel.webview.html = result.html;
    } catch (e) {
      if (generation !== this.buildGeneration) {
        return;
      }
      const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.output.error(`[${basename(this.htmlUri)}] ${message}`);
      this.panel.webview.html = failurePage(message);
    }
  }

  private onMessage(msg: unknown): void {
    const m = msg as { type?: string; level?: string; text?: string };
    if (m?.type === "console") {
      // The page's console level becomes the log level, so the output's level filter applies.
      const text = `[console] ${m.text}`;
      switch (m.level) {
        case "error":
          this.output.error(text);
          break;
        case "warn":
          this.output.warn(text);
          break;
        case "debug":
          this.output.debug(text);
          break;
        case "trace":
          this.output.trace(text);
          break;
        default:
          this.output.info(text);
      }
      if (m.level === "error") {
        this.output.show(true);
      }
    }
  }

  dispose(): void {
    PreviewPanel.panels.delete(this.htmlUri.toString());
    clearTimeout(this.rebuildTimer);
    this.buildGeneration++;
    this.closeProgress();
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
    this.panel.dispose();
  }
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc) {
    return doc.getText();
  }
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function readTsconfig(root: vscode.Uri): Promise<string | undefined> {
  return readText(vscode.Uri.joinPath(root, "tsconfig.json"));
}

function basename(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf("/") + 1);
}

function formatMessage(m: {
  text: string;
  location?: { file: string; line: number; column: number } | null;
}): string {
  return m.location
    ? `${decodeURIComponent(m.location.file.replace(/^vfs:/, ""))}:${m.location.line}:${m.location.column}: ${m.text}`
    : m.text;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function loadingPage(): string {
  return `<!DOCTYPE html><html><body style="font-family:sans-serif;color:var(--vscode-foreground)">Building preview…</body></html>`;
}

function failurePage(message: string): string {
  return (
    `<!DOCTYPE html><html><body style="font-family:sans-serif;color:var(--vscode-errorForeground)">` +
    `<h3>Preview failed</h3><pre style="white-space:pre-wrap">${escapeHtml(message)}</pre></body></html>`
  );
}
