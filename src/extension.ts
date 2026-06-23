import * as vscode from 'vscode';
import { ensureParser } from './parser';
import { buildCfg } from './cfg/builder';
import { CodeFlowPanel } from './panel';
import { WorkspaceIndex } from './indexer';
import { resolveCall } from './resolver';

let currentPanel: CodeFlowPanel | undefined;
let workspaceIndex: WorkspaceIndex;

export function activate(context: vscode.ExtensionContext) {
  workspaceIndex = new WorkspaceIndex();

  context.subscriptions.push(
    vscode.commands.registerCommand('codeflow.showProcedural', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'python') {
        vscode.window.showInformationMessage('Place the cursor inside a Python function.');
        return;
      }

      const parser = await ensureParser(context);

      if (!workspaceIndex.isReady()) {
        await workspaceIndex.build(parser);
      }

      const tree = parser.parse(editor.document.getText());
      const offset = editor.document.offsetAt(editor.selection.active);

      let fnNode = findEnclosingFunction(tree.rootNode, offset);
      if (!fnNode) {
        const cursorNode = tree.rootNode.descendantForIndex(offset);
        const callNode = findCallAncestor(cursorNode);
        if (callNode) {
          const resolved = resolveCall(callNode, editor.document.uri, workspaceIndex);
          if (resolved) fnNode = resolved.entry.node;
        }
      }
      if (!fnNode) {
        fnNode = findFirstFunction(tree.rootNode);
        if (!fnNode) {
          vscode.window.showInformationMessage('No function found in this file.');
          return;
        }
      }

      const cfg = buildCfg(fnNode, {
        getText: () => editor.document.getText(),
        offsetAt: (pos) => editor.document.offsetAt(new vscode.Position(pos.line, pos.character)),
        positionAt: (offset) => {
          const pos = editor.document.positionAt(offset);
          return { line: pos.line, character: pos.character };
        },
      }, workspaceIndex, editor.document.uri.toString());

      if (currentPanel) currentPanel.dispose();
      currentPanel = CodeFlowPanel.create(context, editor.document.uri, cfg, (range) => {
        if (!range) return;
        if (range.uri) {
          const uri = vscode.Uri.parse(range.uri);
          vscode.workspace.openTextDocument(uri).then(doc => {
            vscode.window.showTextDocument(doc).then(e => {
              const start = new vscode.Position(range.startLine, range.startCol);
              const end = new vscode.Position(range.endLine, range.endCol);
              e.selection = new vscode.Selection(start, end);
              e.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
            });
          });
        } else {
          const start = new vscode.Position(range.startLine, range.startCol);
          const end = new vscode.Position(range.endLine, range.endCol);
          editor.selection = new vscode.Selection(start, end);
          editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
        }
      });
    })
  );
}

function findEnclosingFunction(root: import('web-tree-sitter').default.SyntaxNode, offset: number): import('web-tree-sitter').default.SyntaxNode | null {
  let node = root.descendantForIndex(offset);
  while (node) {
    if (node.type === 'function_definition') return node;
    node = node.parent;
  }
  return null;
}

function findCallAncestor(node: import('web-tree-sitter').default.SyntaxNode | null): import('web-tree-sitter').default.SyntaxNode | null {
  while (node) {
    if (node.type === 'call') return node;
    node = node.parent;
  }
  return null;
}

function findFirstFunction(root: import('web-tree-sitter').default.SyntaxNode): import('web-tree-sitter').default.SyntaxNode | null {
  if (root.type === 'function_definition') return root;
  for (const child of root.namedChildren) {
    const found = findFirstFunction(child);
    if (found) return found;
  }
  return null;
}

export function deactivate() {}
