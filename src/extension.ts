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
import { TypeEnv } from './type-env';

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

      const src = editor.document.getText();
      const tree = parser.parse(src);
      const offset = editor.document.offsetAt(editor.selection.active);
      const cursorNode = tree.rootNode.descendantForIndex(offset);
      const className = findEnclosingClassName(cursorNode);

      const erd = await buildErd(parser, editor.document.uri);
      if (erd.entities.length === 0) {
        vscode.window.showInformationMessage('No entities found in the workspace.');
        return;
      }

      let cfg = erdToCfg(erd, className);
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
    (range) => { if (range) revealRange(editor, range); },
    (range) => handleDrillIn(editor, context, range),
  );
}

async function handleDrillIn(
  editor: vscode.TextEditor,
  context: vscode.ExtensionContext,
  range: SrcRange,
) {
  if (!currentPanel) return;
  try {
    const uri = range.uri ? vscode.Uri.parse(range.uri) : editor.document.uri;
    const srcBuf = await vscode.workspace.fs.readFile(uri);
    const src = Buffer.from(srcBuf).toString('utf-8');
    const parser = await ensureParser(context);

    if (!workspaceIndex.isReady()) {
      await workspaceIndex.build(parser, classIndex);
    }

    const tree = parser.parse(src);
    const offset = offsetInText(src, range.startLine, range.startCol);
    const descendant = tree.rootNode.descendantForIndex(offset) as Parser.SyntaxNode | null;

    const layout = currentPanel.getLayout();

    // ERD drill-in: refocus on the clicked entity
    if (layout === 'erd') {
      let cls: Parser.SyntaxNode | null = descendant;
      while (cls) {
        if (cls.type === 'class_definition') break;
        cls = cls.parent as Parser.SyntaxNode | null;
      }
      if (cls) {
        const nameNode = cls.childForFieldName('name');
        const className = nameNode?.text;
        if (className) {
          const erd = await buildErd(parser, editor.document.uri);
          const cfg = erdToCfg(erd, className);
          currentPanel.updateCfg(cfg, className);
          return;
        }
      }
      // Fallback: reveal source
      revealRange(editor, range);
      return;
    }

    // CFG drill-in logic:

    // Helper: walk up to find the first ancestor matching one of the given types
    function walkUp(node: Parser.SyntaxNode | null, types: string[]): Parser.SyntaxNode | null {
      while (node) {
        if (types.includes(node.type)) return node;
        node = node.parent as Parser.SyntaxNode | null;
      }
      return null;
    }

    // Helper: check if a node contains a call expression among its descendants
    function findCallDescendant(node: Parser.SyntaxNode | null): Parser.SyntaxNode | null {
      if (!node) return null;
      if (node.type === 'call') return node;
      for (const child of node.namedChildren) {
        const found = findCallDescendant(child);
        if (found) return found;
      }
      return null;
    }

    // Build TypeEnv from enclosing function's parameters and class context
    function buildTypeEnv(): TypeEnv {
      const tenv = new TypeEnv();
      const fn = walkUp(descendant, ['function_definition', 'async_function_definition']);
      if (!fn) return tenv;

      const cls = walkUp(descendant, ['class_definition']);
      if (cls) {
        const cn = cls.childForFieldName('name');
        if (cn) tenv.set('self', cn.text);
      }

      const params = fn.childForFieldName('parameters');
      if (params) {
        for (const p of params.namedChildren) {
          const pName = p.child(0)?.text;
          const pType = p.childForFieldName('type')?.text;
          if (pName && pType && pName !== 'self' && pName !== 'cls') {
            tenv.set(pName, pType);
          }
        }
      }

      const body = fn.childForFieldName('body');
      if (body) {
        for (const stmt of body.namedChildren) tenv.trackAssignment(stmt);
      }
      return tenv;
    }

    // Step 1: Try to find a call ancestor (walk up from the deepest node)
    const typeEnv = buildTypeEnv();
    let callNode = walkUp(descendant, ['call']);
    if (!callNode) {
      // The range might cover a whole statement; search its descendants for a call
      let stmt = walkUp(descendant, ['expression_statement', 'assignment', 'return_statement']);
      if (!stmt) stmt = descendant;
      callNode = findCallDescendant(stmt);
    }

    if (callNode) {
      const resolved = resolveCall(callNode, uri, workspaceIndex, classIndex, typeEnv);
      if (resolved) {
        const resolvedUri = resolved.entry.uri;
        const resolvedSrc = resolvedUri.toString() !== uri.toString()
          ? Buffer.from(await vscode.workspace.fs.readFile(resolvedUri)).toString('utf-8')
          : src;
        const resolvedNode = resolved.entry.node;
        const nameNode = resolvedNode.childForFieldName('name');
        const crumbLabel = nameNode?.text ?? '<anonymous>';
        const cfg = buildCfg(resolvedNode, textDoc(resolvedSrc), workspaceIndex, resolvedUri.toString(), classIndex, false);
        currentPanel.updateCfg(cfg, crumbLabel);
        return;
      }
    }

    // Step 2: Walk up to find enclosing function or class definition
    const fnNode = walkUp(descendant, ['function_definition', 'class_definition', 'async_function_definition']);
    if (fnNode) {
      const nameNode = fnNode.childForFieldName('name');
      const crumbLabel = nameNode?.text ?? '<anonymous>';
      const cfg = buildCfg(fnNode, textDoc(src), workspaceIndex, uri.toString(), classIndex, false);
      currentPanel.updateCfg(cfg, crumbLabel);
      return;
    }

    // Step 3: Nothing worked — reveal the source so user can see the code
    revealRange(editor, range);
  } catch (e) {
    vscode.window.showInformationMessage(`Drill-in failed: ${e}`);
  }
}

function revealRange(editor: vscode.TextEditor, range: SrcRange) {
  if (!range) return;
  function fallbackReveal(r: SrcRange) {
    if (!editor) return;
    const start = new vscode.Position(r.startLine, r.startCol);
    const end = new vscode.Position(r.endLine, r.endCol);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
  }
  if (range.uri) {
    try {
      const dstUri = vscode.Uri.parse(range.uri);
      vscode.workspace.openTextDocument(dstUri).then(doc => {
        vscode.window.showTextDocument(doc).then(e => {
          const start = new vscode.Position(range.startLine, range.startCol);
          const end = new vscode.Position(range.endLine, range.endCol);
          e.selection = new vscode.Selection(start, end);
          e.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
        });
      }, () => fallbackReveal(range));
    } catch {
      fallbackReveal(range);
    }
  } else {
    fallbackReveal(range);
  }
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
    layout: 'cfg',
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

function findEnclosingClassName(node: Parser.SyntaxNode | null): string | undefined {
  // Check if the cursor node itself is a class name
  if (node?.type === 'identifier') {
    const parent = node.parent;
    if (parent?.type === 'class_definition' && parent.childForFieldName('name') === node) {
      return node.text;
    }
  }

  // Walk up to find enclosing call or class definition
  let n = node;
  while (n) {
    if (n.type === 'call') {
      const func = n.childForFieldName('function');
      if (func?.type === 'identifier') return func.text;
    }
    if (n.type === 'class_definition') {
      // Cursor is inside a class body — it might reference another class
      if (node?.type === 'identifier') return node.text;
      return undefined;
    }
    n = n.parent;
  }
  return undefined;
}

function findInitMethod(cls: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const body = cls.childForFieldName('body');
  if (!body) return null;
  for (const stmt of body.namedChildren) {
    if (stmt.type === 'function_definition' && stmt.childForFieldName('name')?.text === '__init__') {
      return stmt;
    }
    // Handle decorated __init__ (@something above def __init__)
    if (stmt.type === 'decorated_definition') {
      const inner = stmt.namedChildren[stmt.namedChildren.length - 1];
      if (inner?.type === 'function_definition' && inner.childForFieldName('name')?.text === '__init__') {
        return inner;
      }
    }
  }
  return null;
}

export function deactivate() {}
