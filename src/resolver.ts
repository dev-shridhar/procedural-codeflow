import Parser from 'web-tree-sitter';
import * as vscode from 'vscode';
import { WorkspaceIndex, IndexEntry } from './indexer';
import { ClassIndex } from './class-indexer';
import { TypeEnv } from './type-env';

export interface ResolvedCall {
  entry: IndexEntry;
}

export function resolveCall(
  callNode: Parser.SyntaxNode,
  currentFile: vscode.Uri | undefined,
  index: WorkspaceIndex,
  classIndex?: ClassIndex,
  typeEnv?: TypeEnv,
): ResolvedCall | undefined {
  const func = callNode.childForFieldName('function');
  if (!func) return undefined;

  if (func.type === 'identifier') {
    const name = func.text;
    const entry = index.resolve(name, currentFile);
    return entry ? { entry } : undefined;
  }

  if (func.type === 'attribute') {
    const obj = func.childForFieldName('object');
    const attr = func.childForFieldName('attribute');
    if (!obj || !attr) return undefined;

    const objName = obj.text;
    const methodName = attr.text;

    // Try type-aware resolution via class index + type env
    if (classIndex && typeEnv) {
      const resolvedType = resolveObjectType(obj, objName, typeEnv, index, classIndex, currentFile);
      if (resolvedType) {
        const entry = classIndex.resolveMethod(resolvedType, methodName);
        if (entry) return { entry };
      }
    }

    // Fallback: module-qualified resolution
    if (objName === 'self' || objName === 'cls') return undefined;
    const entry = index.resolveByModule(objName, methodName, currentFile);
    return entry ? { entry } : undefined;
  }

  return undefined;
}

function resolveObjectType(
  obj: Parser.SyntaxNode,
  objName: string,
  typeEnv: TypeEnv,
  index: WorkspaceIndex,
  classIndex: ClassIndex,
  currentFile: vscode.Uri | undefined,
): string | undefined {
  // 1. Check TypeEnv (tracked from assignments like svc = ServiceImpl())
  const tracked = typeEnv.get(objName);
  if (tracked) return tracked;

  // 2. Check if obj is a call expression (factory chain) — get return type
  if (obj.type === 'call') {
    const callee = obj.childForFieldName('function');
    if (callee && callee.type === 'identifier') {
      const retType = index.resolveReturnType(callee.text, currentFile);
      return retType;
    }
  }

  // 3. Check if obj has an explicit type annotation in the source
  const typeAnnotation = obj.parent?.childForFieldName('type');
  if (typeAnnotation) return typeAnnotation.text;

  return undefined;
}
