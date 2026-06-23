import Parser from 'web-tree-sitter';
import * as vscode from 'vscode';
import { Cfg, CfgNode, CfgEdge, CfgRegion, SrcRange } from './model';
import * as N from './python-nodes';
import { TextDocLike } from '../parser';
import { resolveCall } from '../resolver';
import { WorkspaceIndex, IndexEntry } from '../indexer';
import { ClassIndex } from '../class-indexer';
import { TypeEnv } from '../type-env';

interface LoopCtx {
  continueTo: string;
  breakTo: string;
}

class Builder {
  nodes: CfgNode[] = [];
  edges: CfgEdge[] = [];
  regions: CfgRegion[] = [];
  private seq = 0;
  private loops: LoopCtx[] = [];
  private exitStack: string[] = [];
  readonly exitId = 'exit';
  private callDepth = 0;
  private currentFileUri?: string;
  private typeEnv = new TypeEnv();

  constructor(
    private doc: TextDocLike,
    private index?: WorkspaceIndex,
    private currentUri?: string,
    private classIndex?: ClassIndex,
  ) {
    this.currentFileUri = currentUri;
    this.add({ id: 'entry', kind: 'entry', label: 'entry' });
    this.add({ id: this.exitId, kind: 'exit', label: 'exit' });
    this.exitStack = [this.exitId];
  }

  private id(): string {
    return `n${this.seq++}`;
  }

  private add(n: CfgNode): string {
    this.nodes.push(n);
    return n.id;
  }

  private link(from: string[], to: string, kind: CfgEdge['kind'] = 'normal', label?: string): void {
    for (const f of from) {
      this.edges.push({ from: f, to, kind, label });
    }
  }

  block(block: Parser.SyntaxNode, preds: string[]): string[] {
    let frontier = preds;
    for (const stmt of block.namedChildren) {
      if (isDocstring(stmt)) continue;
      frontier = this.statement(stmt, frontier);
      if (frontier.length === 0) break;
    }
    return frontier;
  }

  statement(node: Parser.SyntaxNode, preds: string[]): string[] {
    switch (node.type) {
      case N.IF:        return this.ifStmt(node, preds);
      case N.FOR:       return this.forStmt(node, preds);
      case N.WHILE:     return this.whileStmt(node, preds);
      case N.RETURN:    return this.terminator(node, preds, 'return');
      case N.RAISE:     return this.terminator(node, preds, 'raise');
      case N.BREAK:     this.link(preds, this.loops.at(-1)!.breakTo); return [];
      case N.CONTINUE:  this.link(preds, this.loops.at(-1)!.continueTo); return [];
      case N.TRY:       return this.tryStmt(node, preds);
      case N.WITH:      return this.block(node.childForFieldName('body')!, preds);
      case N.MATCH:     return this.matchStmt(node, preds);
      case N.CLASS_DEF: {
        const clsName = node.childForFieldName('name')?.text;
        if (clsName) this.typeEnv.set('self', clsName);
        return this.block(node.childForFieldName('body')!, preds);
      }
      default:          return this.defaultStmt(node, preds);
    }
  }

  private defaultStmt(node: Parser.SyntaxNode, preds: string[]): string[] {
    this.typeEnv.trackAssignment(node);

    if (this.index && this.callDepth < 1) {
      const callNode = findCallExpression(node);
      if (callNode) {
        const resolved = resolveCall(
          callNode,
          this.currentUri ? uriFromString(this.currentUri) : undefined,
          this.index,
          this.classIndex,
          this.typeEnv,
        );
        if (resolved && resolved.entry.uri.fsPath !== this.currentFileUri) {
          return this.inlineCall(node, resolved.entry, preds);
        }
      }
    }

    const hasCall = findCallExpression(node) !== null;
    const id = this.add({
      id: this.id(), kind: hasCall ? 'call' : 'statement',
      label: this.text(node),
      range: withUri(this.range(node), this.currentFileUri),
    });
    this.link(preds, id);
    return [id];
  }

  private inlineCall(stmtNode: Parser.SyntaxNode, resolved: IndexEntry, preds: string[]): string[] {
    this.callDepth++;

    const callId = this.add({
      id: this.id(), kind: 'call',
      label: `call ${resolved.name}`,
      range: withUri(this.range(stmtNode), resolved.uri.toString()),
    });
    this.link(preds, callId);

    const fn = resolved.node;
    const body = fn.childForFieldName('body');
    if (!body) { this.callDepth--; return [callId]; }

    const calleeExitId = `inline_exit_${this.seq++}`;
    this.add({ id: calleeExitId, kind: 'merge', label: '' });

    this.exitStack.push(calleeExitId);

    const oldDoc = this.doc;
    this.doc = {
      getText: () => resolved.source,
      offsetAt: (pos) => {
        const lines = resolved.source.split('\n');
        let offset = 0;
        for (let i = 0; i < pos.line && i < lines.length; i++) {
          offset += lines[i].length + 1;
        }
        return offset + pos.character;
      },
      positionAt: (offset) => {
        const text = resolved.source;
        let line = 0, col = 0;
        for (let i = 0; i < offset && i < text.length; i++) {
          if (text[i] === '\n') { line++; col = 0; }
          else col++;
        }
        return { line, character: col };
      },
    };
    const oldFileUri = this.currentFileUri;
    this.currentFileUri = resolved.uri.toString();

    const calleeFrontier = this.block(body, [callId]);

    this.doc = oldDoc;
    this.currentFileUri = oldFileUri;
    this.exitStack.pop();

    this.link(calleeFrontier, calleeExitId);

    this.callDepth--;
    return [calleeExitId];
  }

  private ifStmt(node: Parser.SyntaxNode, preds: string[]): string[] {
    const condId = this.add({
      id: this.id(), kind: 'branch',
      label: this.text(node.childForFieldName('condition')!),
      range: withUri(this.range(node), this.currentFileUri),
    });
    this.link(preds, condId);

    const consequence = node.childForFieldName('consequence')!;
    const trueFrontier = this.block(consequence, [condId]);
    this.edges.filter(e => e.from === condId && trueFrontier.includes(e.to)).forEach(e => (e.kind = 'true'));

    let falsePreds: string[] = [condId];
    let elseFrontier: string[] = [];
    let sawElse = false;

    for (const alt of node.childrenForFieldName('alternative')) {
      if (alt.type === N.ELIF) {
        const cId = this.add({
          id: this.id(), kind: 'branch',
          label: this.text(alt.childForFieldName('condition')!),
          range: withUri(this.range(alt), this.currentFileUri),
        });
        this.link(falsePreds, cId, 'false');
        const armFrontier = this.block(alt.childForFieldName('consequence')!, [cId]);
        this.edges.filter(e => e.from === cId && armFrontier.includes(e.to)).forEach(e => (e.kind = 'true'));
        elseFrontier.push(...armFrontier);
        falsePreds = [cId];
      } else if (alt.type === N.ELSE) {
        sawElse = true;
        elseFrontier.push(...this.block(alt.childForFieldName('body')!, falsePreds));
      }
    }

    if (!sawElse) this.link(falsePreds, condId, 'false');
    const falseExit = sawElse ? elseFrontier : [...falsePreds, ...elseFrontier];
    return [...trueFrontier, ...falseExit];
  }

  private forStmt(node: Parser.SyntaxNode, preds: string[]): string[] {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    const headerId = this.add({
      id: this.id(), kind: 'loop',
      label: `for ${this.text(left)} in ${this.text(right)}`,
      range: withUri(this.range(node), this.currentFileUri),
    });
    this.link(preds, headerId);

    const afterId = this.add({ id: this.id(), kind: 'merge', label: '' });
    this.loops.push({ continueTo: headerId, breakTo: afterId });

    const body = node.childForFieldName('body')!;
    const bodyFrontier = this.block(body, [headerId]);
    this.edges.filter(e => e.from === headerId && bodyFrontier.includes(e.to)).forEach(e => (e.kind = 'true'));
    this.link(bodyFrontier, headerId, 'loop-back');
    this.loops.pop();

    const elseClause = node.childForFieldName('alternative');
    if (elseClause) {
      const elseFrontier = this.block(elseClause.childForFieldName('body')!, [headerId]);
      this.edges.filter(e => e.from === headerId && elseFrontier.includes(e.to)).forEach(e => (e.kind = 'false'));
      this.link(elseFrontier, afterId);
    } else {
      this.link([headerId], afterId, 'false');
    }
    return [afterId];
  }

  private whileStmt(node: Parser.SyntaxNode, preds: string[]): string[] {
    const condition = node.childForFieldName('condition');
    const headerId = this.add({
      id: this.id(), kind: 'loop',
      label: `while ${this.text(condition)}`,
      range: withUri(this.range(node), this.currentFileUri),
    });
    this.link(preds, headerId);
    const afterId = this.add({ id: this.id(), kind: 'merge', label: '' });
    this.loops.push({ continueTo: headerId, breakTo: afterId });
    const body = node.childForFieldName('body')!;
    const bodyFrontier = this.block(body, [headerId]);
    this.edges.filter(e => e.from === headerId && bodyFrontier.includes(e.to)).forEach(e => (e.kind = 'true'));
    this.link(bodyFrontier, headerId, 'loop-back');
    this.loops.pop();
    const elseClause = node.childForFieldName('alternative');
    if (elseClause) {
      const elseFrontier = this.block(elseClause.childForFieldName('body')!, [headerId]);
      this.edges.filter(e => e.from === headerId && elseFrontier.includes(e.to)).forEach(e => (e.kind = 'false'));
      this.link(elseFrontier, afterId);
    } else {
      this.link([headerId], afterId, 'false');
    }
    return [afterId];
  }

  private terminator(node: Parser.SyntaxNode, preds: string[], kind: 'return' | 'raise'): string[] {
    const id = this.add({
      id: this.id(), kind,
      label: this.text(node),
      range: withUri(this.range(node), this.currentFileUri),
    });
    this.link(preds, id);
    this.link([id], this.exitStack[this.exitStack.length - 1] ?? this.exitId);
    return [];
  }

  private tryStmt(node: Parser.SyntaxNode, preds: string[]): string[] {
    const body = node.childForFieldName('body')!;
    const bodyFrontier = this.block(body, preds);
    const handlerFrontiers: string[] = [];
    for (const ex of node.childrenForFieldName('handler')) {
      const excType = ex.firstNamedChild;
      const excLabel = excType ? this.text(excType) : '';
      const hId = this.add({
        id: this.id(), kind: 'statement',
        label: excLabel || 'except',
        range: withUri(this.range(ex), this.currentFileUri),
      });
      const source = bodyFrontier[0] ?? preds[0];
      this.link([source], hId, 'exception', excLabel || 'exception');
      const handlerBody = ex.childForFieldName('consequence') ?? ex;
      handlerFrontiers.push(...this.block(handlerBody, [hId]));
    }
    const finallyBody = node.childForFieldName('finally_body');
    if (finallyBody) {
      const finalPreds = bodyFrontier.length ? bodyFrontier : preds;
      const allPreds = [...finalPreds, ...handlerFrontiers];
      return this.block(finallyBody, allPreds);
    }
    return [...bodyFrontier, ...handlerFrontiers];
  }

  private matchStmt(node: Parser.SyntaxNode, preds: string[]): string[] {
    const subject = node.childForFieldName('subject');
    const subjId = this.add({
      id: this.id(), kind: 'branch',
      label: `match ${this.text(subject)}`,
      range: withUri(this.range(node), this.currentFileUri),
    });
    this.link(preds, subjId);
    const out: string[] = [];
    for (const c of node.namedChildren.filter(n => n.type === N.CASE)) {
      const caseFrontier = this.block(c, [subjId]);
      this.edges.filter(e => e.from === subjId && e.to === c.firstNamedChild?.id).forEach(e => (e.kind = 'case'));
      out.push(...caseFrontier);
    }
    return out;
  }

  private text(n: Parser.SyntaxNode | null): string {
    if (!n) return '';
    const t = n.text;
    return t.split('\n')[0].length > 80 ? t.split('\n')[0].slice(0, 77) + '...' : t.split('\n')[0];
  }

  private range(n: Parser.SyntaxNode): SrcRange {
    return { startLine: n.startPosition.row, startCol: n.startPosition.column, endLine: n.endPosition.row, endCol: n.endPosition.column };
  }
}

function findCallExpression(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type === 'call') return node;
  for (const child of node.namedChildren) {
    const found = findCallExpression(child);
    if (found) return found;
  }
  return null;
}

function isDocstring(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'expression_statement') return false;
  const expr = node.firstNamedChild;
  return expr?.type === 'string';
}

function withUri(range: SrcRange, uri?: string): SrcRange {
  return uri ? { ...range, uri } : range;
}

function uriFromString(s: string): vscode.Uri {
  return vscode.Uri.parse(s);
}

export function buildCfg(
  fn: Parser.SyntaxNode,
  doc: TextDocLike,
  index?: WorkspaceIndex,
  currentUri?: string,
  classIndex?: ClassIndex,
): Cfg {
  const b = new Builder(doc, index, currentUri, classIndex);
  const body = fn.childForFieldName('body')!;
  const frontier = b.block(body, ['entry']);
  b.link(frontier, b.exitId);
  return { nodes: b.nodes, edges: b.edges, regions: b.regions, entryId: 'entry', exitId: b.exitId };
}
