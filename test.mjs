import { memfs } from './rolldown-wasi/node_modules/@napi-rs/wasm-runtime/dist/fs';

const vscode = require('vscode');
vscode.workspace.fs.readFile();
