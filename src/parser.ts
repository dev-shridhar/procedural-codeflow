import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';

let parserPromise: Promise<Parser> | undefined;

export function ensureParser(ctx: vscode.ExtensionContext): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      const wasmDir = vscode.Uri.joinPath(ctx.extensionUri, 'dist');
      await Parser.init({
        locateFile(scriptPath: string) {
          return vscode.Uri.joinPath(wasmDir, scriptPath).fsPath;
        },
      });
      const parser = new Parser();
      const wasmPath = vscode.Uri.joinPath(ctx.extensionUri, 'media', 'tree-sitter-python.wasm');
      const Python = await Parser.Language.load(wasmPath.fsPath);
      parser.setLanguage(Python);
      return parser;
    })();
  }
  return parserPromise;
}

export interface TextDocLike {
  getText(): string;
  offsetAt(pos: { line: number; character: number }): number;
  positionAt(offset: number): { line: number; character: number };
}


