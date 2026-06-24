import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';
import { ensureParser, TextDocLike } from './parser';
import { buildCfg } from './cfg/builder';
import { CodeFlowPanel } from './panel';
import { WorkspaceIndex } from './indexer';
import { ClassIndex } from './class-indexer';
import { resolveCall } from './resolver';
import { Cfg, CfgNode, CfgEdge, SrcRange } from './cfg/model';
import { buildErd, erdToCfg } from './erd/builder';

let currentPanel: CodeFlowPanel | undefined;
let workspaceIndex: WorkspaceIndex;
let classIndex: ClassIndex;

export function activate(context: vscode.ExtensionContext) {
  workspaceIndex = new WorkspaceIndex();
  classIndex = new ClassIndex();

  context.subscriptions.push(
    vscode.commands.registerCommand('codedetective.showCodeFlow', async () => {
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

      let fnNode: Parser.SyntaxNode | null = null;
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
      const isModuleMode = !fnNode;
      if (!fnNode) {
        fnNode = tree.rootNode;
      }

      const useSrc = resolvedSource ?? src;
      const cfg = buildCfg(fnNode, textDoc(useSrc), workspaceIndex, editor.document.uri.toString(), classIndex, isModuleMode);

      showCfg(editor, context, cfg);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codedetective.showErd', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'python') {
        vscode.window.showInformationMessage('Open a Python file.');
        return;
      }

      const parser = await ensureParser(context);

      if (!workspaceIndex.isReady()) {
        await workspaceIndex.build(parser, classIndex);
      }

      const erd = await buildErd(parser);
      if (erd.entities.length === 0) {
        vscode.window.showInformationMessage('No entities found in the workspace.');
        return;
      }

      const cfg = erdToCfg(erd);
      showCfg(editor, context, cfg);
    })
  );
}

function showCfg(editor: vscode.TextEditor, context: vscode.ExtensionContext, cfg: Cfg) {
  if (currentPanel) currentPanel.dispose();
  currentPanel = CodeFlowPanel.create(
    context,
    editor.document.uri,
    cfg,
    (range) => {
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
    },
    (range) => handleDrillIn(editor, context, range),
  );
}

async function handleDrillIn(
  editor: vscode.TextEditor,
  context: vscode.ExtensionContext,
  range: SrcRange,
) {
  if (!currentPanel) return;
  const uri = range.uri ? vscode.Uri.parse(range.uri) : editor.document.uri;
  const srcBuf = await vscode.workspace.fs.readFile(uri);
  const src = Buffer.from(srcBuf).toString('utf-8');
  const parser = await ensureParser(context);

  if (!workspaceIndex.isReady()) {
    await workspaceIndex.build(parser, classIndex);
  }

  const tree = parser.parse(src);
  const offset = offsetInText(src, range.startLine, range.startCol);
  let n: Parser.SyntaxNode | null = tree.rootNode.descendantForIndex(offset) as Parser.SyntaxNode | null;
  while (n) {
    if (n.type === 'function_definition' || n.type === 'class_definition' || n.type === 'async_function_definition') {
      break;
    }
    n = n.parent as Parser.SyntaxNode | null;
  }
  if (!n) {
    vscode.window.showInformationMessage('No function or class at this location.');
    return;
  }
  const cfg = buildCfg(n, textDoc(src), workspaceIndex, uri.toString(), classIndex, false);
  currentPanel.updateCfg(cfg);
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
  let n: Parser.SyntaxNode | null = tree.rootNode.descendantForIndex(defOffset);
  while (n) {
    if (n.type === 'function_definition') return { node: n, source: src };
    if (n.type === 'class_definition') return { node: n, source: src };
    n = n.parent as Parser.SyntaxNode | null;
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

function findEnclosingFunction(root: Parser.SyntaxNode, offset: number): Parser.SyntaxNode | null {
  let node: Parser.SyntaxNode | null = root.descendantForIndex(offset);
  while (node) {
    if (node.type === 'function_definition') return node;
    node = node.parent as Parser.SyntaxNode | null;
  }
  return null;
}

function findCallAncestor(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
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

function findFirstCallDescendant(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
  if (!node) return null;
  if (node.type === 'call') return node;
  for (const child of node.namedChildren) {
    const found = findFirstCallDescendant(child);
    if (found) return found;
  }
  return null;
}

function findFirstFunction(root: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (root.type === 'function_definition') return root;
  for (const child of root.namedChildren) {
    const found = findFirstFunction(child);
    if (found) return found;
  }
  return null;
}

function offsetInText(text: string, line: number, col: number): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < line && i < lines.length; i++) offset += lines[i].length + 1;
  return offset + col;
}

function positionInText(text: string, offset: number): { line: number; character: number } {
  let line = 0, col = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 0; } else col++;
  }
  return { line, character: col };
}

function textDoc(source: string): TextDocLike {
  return {
    getText: () => source,
    offsetAt: (pos) => offsetInText(source, pos.line, pos.character),
    positionAt: (off) => positionInText(source, off),
  };
}

export function deactivate() {}
