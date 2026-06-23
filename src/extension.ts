import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';
import { ensureParser } from './parser';
import { buildCfg } from './cfg/builder';
import { CodeFlowPanel } from './panel';
import { WorkspaceIndex } from './indexer';
import { ClassIndex } from './class-indexer';
import { resolveCall } from './resolver';
import { Cfg, CfgNode, CfgEdge } from './cfg/model';

let currentPanel: CodeFlowPanel | undefined;
let workspaceIndex: WorkspaceIndex;
let classIndex: ClassIndex;

export function activate(context: vscode.ExtensionContext) {
  workspaceIndex = new WorkspaceIndex();
  classIndex = new ClassIndex();

  context.subscriptions.push(
    vscode.commands.registerCommand('codeflow.showProcedural', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'python') {
        vscode.window.showInformationMessage('Place the cursor inside a Python function.');
        return;
      }

      const parser = await ensureParser(context);

      if (!workspaceIndex.isReady()) {
        await workspaceIndex.build(parser, classIndex);
      }

      const src = editor.document.getText();
      const tree = parser.parse(src);
      classIndex.build(editor.document.uri, src, tree.rootNode);

      const offset = editor.document.offsetAt(editor.selection.active);

      let fnNode: import('web-tree-sitter').default.SyntaxNode | null = null;
      let resolvedSource: string | undefined;
      const cursorNode = tree.rootNode.descendantForIndex(offset);
      const callNode = findCallAncestor(cursorNode);
      if (callNode) {
        const resolved = resolveCall(callNode, editor.document.uri, workspaceIndex, classIndex);
        if (resolved) {
          fnNode = resolved.entry.node;
          if (resolved.entry.uri.toString() !== editor.document.uri.toString()) {
            const doc = await vscode.workspace.openTextDocument(resolved.entry.uri);
            resolvedSource = doc.getText();
          }
        } else {
          const callName = callNode.childForFieldName('function')?.text ?? 'unknown';
          const lspResult = await resolveViaLSP(editor, parser, callName);
          if (lspResult) {
            fnNode = lspResult.node;
            resolvedSource = lspResult.source;
          } else {
            // Try signature card for external calls
            const sigCard = await buildSignatureCard(editor, callName);
            if (sigCard) {
              showCfg(editor, context, sigCard);
              return;
            }
            vscode.window.showInformationMessage(`Cannot resolve call "${callName}" — showing enclosing function.`);
          }
        }
      }
      if (!fnNode) {
        fnNode = findEnclosingFunction(tree.rootNode, offset);
      }
      if (!fnNode) {
        fnNode = findFirstFunction(tree.rootNode);
        if (!fnNode) {
          vscode.window.showInformationMessage('No function found in this file.');
          return;
        }
      }

      const useSrc = resolvedSource ?? src;
      const doc = await vscode.workspace.openTextDocument({ content: useSrc });
      const cfg = buildCfg(fnNode, {
        getText: () => useSrc,
        offsetAt: (pos) => doc.offsetAt(new vscode.Position(pos.line, pos.character)),
        positionAt: (offset) => {
          const pos = doc.positionAt(offset);
          return { line: pos.line, character: pos.character };
        },
      }, workspaceIndex, editor.document.uri.toString(), classIndex);

      showCfg(editor, context, cfg);
    })
  );
}

function showCfg(editor: vscode.TextEditor, context: vscode.ExtensionContext, cfg: Cfg) {
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
}

async function resolveViaLSP(
  editor: vscode.TextEditor,
  parser: Parser,
  _callName: string,
): Promise<{ node: Parser.SyntaxNode; source: string } | null> {
  const pos = editor.selection.active;
  const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
    'vscode.executeDefinitionProvider',
    editor.document.uri,
    pos,
  );
  if (!definitions || definitions.length === 0) return null;

  const def = definitions[0];
  const doc = await vscode.workspace.openTextDocument(def.uri);
  const src = doc.getText();
  const tree = parser.parse(src);
  const defOffset = doc.offsetAt(def.range.start);

  // Try to find enclosing function at definition
  let n = tree.rootNode.descendantForIndex(defOffset);
  while (n) {
    if (n.type === 'function_definition') return { node: n, source: src };
    if (n.type === 'class_definition') return { node: n, source: src };
    n = n.parent;
  }
  return null;
}

async function buildSignatureCard(editor: vscode.TextEditor, callName: string): Promise<Cfg | null> {
  const pos = editor.selection.active;
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    'vscode.executeHoverProvider',
    editor.document.uri,
    pos,
  );
  if (!hovers || hovers.length === 0) return null;

  const hover = hovers[0];
  const contents = hover.contents.map(c => typeof c === 'string' ? c : (c as any).value).join('\n');
  const lines = contents.split('\n');
  const signature = lines[0] ?? callName;
  const docstring = lines.slice(1).filter(l => l.trim()).join('\n').replace(/^```[\w]*\n?|```$/gm, '').trim();

  return {
    nodes: [
      { id: 'entry', kind: 'entry', label: 'entry' },
      { id: 'sig', kind: 'statement', label: signature },
      { id: 'doc', kind: 'statement', label: docstring || '(no documentation)' },
      { id: 'exit', kind: 'exit', label: 'exit' },
    ],
    edges: [
      { from: 'entry', to: 'sig', kind: 'normal' },
      { from: 'sig', to: 'doc', kind: 'normal' },
      { from: 'doc', to: 'exit', kind: 'normal' },
    ],
    regions: [],
    entryId: 'entry',
    exitId: 'exit',
  };
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
  // First try walking up to find a direct call ancestor
  let n = node;
  while (n) {
    if (n.type === 'call') return n;
    n = n.parent;
  }
  // If not found, search the entire statement at cursor for any call
  if (!node) return null;
  let stmt = node;
  while (stmt.parent && stmt.parent.type !== 'function_definition' && stmt.parent.type !== 'module' && stmt.parent.type !== 'block') {
    stmt = stmt.parent;
  }
  return findFirstCallDescendant(stmt);
}

function findFirstCallDescendant(node: import('web-tree-sitter').default.SyntaxNode | null): import('web-tree-sitter').default.SyntaxNode | null {
  if (!node) return null;
  if (node.type === 'call') return node;
  for (const child of node.namedChildren) {
    const found = findFirstCallDescendant(child);
    if (found) return found;
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
