import * as vscode from 'vscode';
import { dirname, initializeEsbuild } from './bundler';
import { renderPreview } from './html';

const REBUILD_DELAY_MS = 300;

/** One webview panel previewing one HTML file, rebuilt whenever a dependency changes. */
export class PreviewPanel implements vscode.Disposable {
  private static readonly panels = new Map<string, PreviewPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private dependencies = new Set<string>();
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  private buildGeneration = 0;

  static show(
    context: vscode.ExtensionContext,
    htmlUri: vscode.Uri,
    output: vscode.OutputChannel,
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
    private readonly output: vscode.OutputChannel,
  ) {
    const root = this.root();
    const roots = [
      root,
      dirname(htmlUri),
      ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
    ];
    this.panel = vscode.window.createWebviewPanel(
      'webPreviewer.preview',
      `Preview ${basename(htmlUri)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, enableForms: true, localResourceRoots: roots },
    );
    this.panel.iconPath = new vscode.ThemeIcon('preview');

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      // Unsaved edits are read from the editor buffer, so preview as you type.
      vscode.workspace.onDidChangeTextDocument((e) => this.onFileChanged(e.document.uri)),
    );
    // Changes made outside the editor (git checkout, codegen, bun install...).
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, '**/*'),
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
    if (this.dependencies.has(key) || key.endsWith('/tsconfig.json')) {
      this.scheduleRebuild();
    }
  }

  private scheduleRebuild(): void {
    clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => this.rebuild(), REBUILD_DELAY_MS);
  }

  async rebuild(): Promise<void> {
    clearTimeout(this.rebuildTimer);
    const generation = ++this.buildGeneration;
    const started = Date.now();
    try {
      this.output.appendLine(`[${basename(this.htmlUri)}] Initializing esbuild...`);
      await initializeEsbuild(this.context.extensionUri);
      const html = await readText(this.htmlUri);
      const tsconfigRaw = await readTsconfig(this.root());
      const result = await renderPreview({
        htmlUri: this.htmlUri,
        html: html ?? '',
        root: this.root(),
        tsconfigRaw,
        webview: this.panel.webview,
        outputChannel: this.output,
      });
      if (generation !== this.buildGeneration) {
        return; // a newer build superseded this one
      }
      this.dependencies = result.dependencies;
      if (tsconfigRaw !== undefined) {
        this.dependencies.add(vscode.Uri.joinPath(this.root(), 'tsconfig.json').toString());
      }
      for (const w of result.warnings) {
        this.output.appendLine(`[build warning] ${formatMessage(w)}`);
      }
      for (const e of result.errors) {
        this.output.appendLine(`[build error] ${formatMessage(e)}`);
      }
      this.output.appendLine(
        `[${basename(this.htmlUri)}] built in ${Date.now() - started}ms` +
          (result.errors.length ? ` with ${result.errors.length} error(s)` : ''),
      );
      this.panel.webview.html = result.html;
    } catch (e) {
      if (generation !== this.buildGeneration) {
        return;
      }
      const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
      this.output.appendLine(`[error] ${message}`);
      this.panel.webview.html = failurePage(message);
    }
  }

  private onMessage(msg: unknown): void {
    const m = msg as { type?: string; level?: string; text?: string };
    if (m?.type === 'console') {
      this.output.appendLine(`[console.${m.level}] ${m.text}`);
      if (m.level === 'error') {
        this.output.show(true);
      }
    }
  }

  dispose(): void {
    PreviewPanel.panels.delete(this.htmlUri.toString());
    clearTimeout(this.rebuildTimer);
    this.buildGeneration++;
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
  return readText(vscode.Uri.joinPath(root, 'tsconfig.json'));
}

function basename(uri: vscode.Uri): string {
  return uri.path.slice(uri.path.lastIndexOf('/') + 1);
}

function formatMessage(m: {
  text: string;
  location?: { file: string; line: number; column: number } | null;
}): string {
  return m.location
    ? `${decodeURIComponent(m.location.file.replace(/^vfs:/, ''))}:${m.location.line}:${m.location.column}: ${m.text}`
    : m.text;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
