import * as vscode from "vscode";
import { PreviewPanel } from "./preview";
import { installDependencies } from "../install";

declare namespace globalThis {
  export let outputChannel: vscode.LogOutputChannel;
  export let currentPerf: number;
}

globalThis.outputChannel;

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("JS Preview", { log: true });
  globalThis.outputChannel = output;
  output.info(Object.keys(globalThis).join(", "));
  output.info(
    "sharedArrayBuffer is" +
      (typeof SharedArrayBuffer !== "undefined" ? " supported" : " not supported"),
  );
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand("js-preview.startPreview", (uri?: vscode.Uri) => {
      // Invoked from the explorer/editor title menus with a URI, or from the
      // command palette with none (fall back to the active editor).
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
      if (!target || !/\.html?$/i.test(target.path)) {
        vscode.window.showErrorMessage("JS Preview: open an HTML file to preview it.");
        return;
      }
      PreviewPanel.show(context, target, output);
    }),
    vscode.commands.registerCommand("js-preview.refreshPreview", () => PreviewPanel.refreshAll()),
    vscode.commands.registerCommand("js-preview.installDependencies", () =>
      installDependencies(output),
    ),
  );
}

export function deactivate() {}
