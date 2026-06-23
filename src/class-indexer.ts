import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';
import { IndexEntry } from './indexer';

export interface ClassInfo {
  name: string;
  node: Parser.SyntaxNode;
  uri: vscode.Uri;
  source: string;
  superclassNames: string[];
  methods: Map<string, IndexEntry>;
}

export class ClassIndex {
  private byName = new Map<string, ClassInfo[]>();
  private loadedFiles = new Set<string>();

  build(uri: vscode.Uri, source: string, root: Parser.SyntaxNode): void {
    const key = uri.fsPath;
    if (this.loadedFiles.has(key)) return;
    this.loadedFiles.add(key);

    const visit = (node: Parser.SyntaxNode) => {
      if (node.type === 'class_definition') {
        this.indexClass(uri, source, node);
      }
      for (const child of node.namedChildren) {
        visit(child);
      }
    };
    visit(root);
  }

  private indexClass(uri: vscode.Uri, source: string, node: Parser.SyntaxNode): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const name = nameNode.text;

    const superclassNames: string[] = [];
    const bases = node.childForFieldName('superclasses');
    if (bases) {
      for (const arg of bases.namedChildren) {
        if (arg.type === 'identifier' || arg.type === 'attribute') {
          superclassNames.push(arg.text);
        }
      }
    }

    const methods = new Map<string, IndexEntry>();
    const body = node.childForFieldName('body');
    if (body) {
      for (const child of body.namedChildren) {
        if (child.type === 'function_definition' || child.type === 'method_definition') {
          const mName = child.childForFieldName('name');
          if (mName) {
            methods.set(mName.text, {
              name: mName.text,
              uri,
              source,
              node: child,
            });
          }
        }
      }
    }

    const ci: ClassInfo = { name, node, uri, source, superclassNames, methods };
    const entries = this.byName.get(name) ?? [];
    entries.push(ci);
    this.byName.set(name, entries);
  }

  resolve(name: string, currentFile?: vscode.Uri): ClassInfo | undefined {
    const entries = this.byName.get(name);
    if (!entries?.length) return undefined;
    if (currentFile) {
      const dir = currentFile.fsPath.replace(/\/[^/]+$/, '');
      const sameDir = entries.find(e => e.uri.fsPath.startsWith(dir));
      if (sameDir) return sameDir;
    }
    return entries[0];
  }

  getMro(className: string, visited = new Set<string>()): ClassInfo[] {
    if (visited.has(className)) return [];
    visited.add(className);

    const ci = this.resolve(className);
    if (!ci) return [];

    const result: ClassInfo[] = [ci];
    for (const sup of ci.superclassNames) {
      result.push(...this.getMro(sup, visited));
    }
    return result;
  }

  resolveMethod(className: string, methodName: string): IndexEntry | undefined {
    const mro = this.getMro(className);
    for (const cls of mro) {
      const m = cls.methods.get(methodName);
      if (m) return m;
    }
    return undefined;
  }

  resolveReturnType(calleeName: string): string | undefined {
    const entries = this.byName.get(calleeName);
    if (!entries?.length) return undefined;
    // Check function definitions for return type annotations
    const visit = (node: Parser.SyntaxNode): string | undefined => {
      if (node.type === 'function_definition') {
        const nameNode = node.childForFieldName('name');
        if (nameNode && nameNode.text === calleeName) {
          const retType = node.childForFieldName('return_type');
          if (retType) {
            return retType.text;
          }
        }
      }
      for (const child of node.namedChildren) {
        const found = visit(child);
        if (found) return found;
      }
      return undefined;
    };

    for (const entry of entries) {
      const result = visit(entry.node);
      if (result) return result;
    }
    return undefined;
  }
}
