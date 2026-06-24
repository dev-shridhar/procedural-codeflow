import * as vscode from 'vscode';
import Parser from 'web-tree-sitter';
import { Erd, ErdEntity, ErdRelation } from './model';
import { Cfg, CfgNode, CfgEdge } from '../cfg/model';

interface ClassRef {
  name: string;
  node: Parser.SyntaxNode;
  source: string;
  uri: vscode.Uri;
}

function withUri(r: { startLine: number; startCol: number; endLine: number; endCol: number }, uri?: string) {
  return uri ? { ...r, uri } : r;
}

export async function buildErd(
  parser: Parser,
  index?: Map<string, { uri: vscode.Uri; source: string; node: Parser.SyntaxNode }[]>,
): Promise<Erd> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders) return { entities: [], relations: [] };

  const classes: ClassRef[] = [];
  const nameIndex = new Map<string, ClassRef[]>();
  const pyFiles = await vscode.workspace.findFiles('**/*.py', '**/node_modules/**');

  for (const uri of pyFiles) {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const src = doc.getText();
      const tree = parser.parse(src);
      collectClasses(tree.rootNode, uri, src, classes, nameIndex);
    } catch { }
  }

  const entities: ErdEntity[] = [];
  const relations: ErdRelation[] = [];
  const entityNames = new Set<string>();
  const fieldRefs: Array<{ from: string; field: string }> = [];

  for (const cls of classes) {
    if (entityNames.has(cls.name)) continue;
    entityNames.add(cls.name);

    const fields = extractFields(cls.node, cls.source);
    entities.push({
      name: cls.name,
      fields,
      range: withUri(
        { startLine: cls.node.startPosition.row, startCol: cls.node.startPosition.column, endLine: cls.node.endPosition.row, endCol: cls.node.endPosition.column },
        cls.uri.toString(),
      ),
    });

    for (const field of fields) {
      const ref = extractTypeRef(field);
      if (ref && nameIndex.has(ref)) {
        fieldRefs.push({ from: cls.name, field });
      }
    }
  }

  for (const cls of classes) {
    if (!entityNames.has(cls.name)) continue;
    const bases = cls.node.childForFieldName('superclasses');
    if (bases) {
      for (const base of bases.namedChildren) {
        const baseName = base.type === 'identifier' ? base.text : undefined;
        if (baseName && nameIndex.has(baseName) && entityNames.has(baseName)) {
          relations.push({ from: cls.name, to: baseName, kind: 'extends', label: 'extends' });
        }
      }
    }
  }

  for (const fr of fieldRefs) {
    const ref = extractTypeRef(fr.field);
    if (ref && entityNames.has(ref)) {
      relations.push({ from: fr.from, to: ref, kind: 'ref', fromField: fr.field, label: ref });
    }
  }

  return { entities, relations };
}

function collectClasses(
  root: Parser.SyntaxNode,
  uri: vscode.Uri,
  source: string,
  classes: ClassRef[],
  nameIndex: Map<string, ClassRef[]>,
) {
  const visit = (node: Parser.SyntaxNode) => {
    if (node.type === 'class_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const cr: ClassRef = { name: nameNode.text, node, source, uri };
        classes.push(cr);
        const entries = nameIndex.get(cr.name) ?? [];
        entries.push(cr);
        nameIndex.set(cr.name, entries);
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
}

function extractFields(cls: Parser.SyntaxNode, source: string): string[] {
  const fields: string[] = [];
  const body = cls.childForFieldName('body');
  if (!body) return fields;

  for (const stmt of body.namedChildren) {

    if (stmt.type === 'expression_statement') {
      const assign = stmt.firstNamedChild;
      if (assign?.type === 'assignment' && assign.childForFieldName('type')) {
        const name = assign.childForFieldName('left')?.text;
        const type = assign.childForFieldName('type')?.text;
        if (name && type && !fields.some(f => f.startsWith(name + ':'))) {
          fields.push(`${name}: ${type}`);
        }
        continue;
      }
      continue;
    }

    // Look at __init__ method for self.field assignments
    if (stmt.type === 'function_definition' && stmt.childForFieldName('name')?.text === '__init__') {
      // Build parameter name → type map
      const paramMap = new Map<string, string>();
      const params = stmt.childForFieldName('parameters');
      if (params) {
        for (const p of params.namedChildren) {
          if (p.type === 'typed_parameter' || p.type === 'default_parameter') {
            const pName = p.child(0)?.type === 'identifier' ? p.child(0).text : undefined;
            const pType = p.childForFieldName('type')?.text;
            if (pName && pType) paramMap.set(pName, pType);
          }
        }
      }

      const initBody = stmt.childForFieldName('body');
      if (initBody) {
        for (const initStmt of initBody.namedChildren) {
          if (initStmt.type === 'expression_statement') {
            const assign = initStmt.firstNamedChild;
            if (assign?.type === 'assignment') {
              const left = assign.childForFieldName('left');
              if (left?.type === 'attribute' && left.childForFieldName('object')?.text === 'self') {
                const fieldName = left.childForFieldName('attribute')?.text;
                if (fieldName && !fields.some(f => f.startsWith(fieldName + ':'))) {
                  const inlineType = assign.childForFieldName('type')?.text;
                  if (inlineType) {
                    fields.push(`${fieldName}: ${inlineType}`);
                  } else {
                    // Try to infer type from parameter
                    const right = assign.childForFieldName('right');
                    const inferred = right && paramMap.get(right.text);
                    fields.push(`${fieldName}: ${inferred ?? 'Any'}`);
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  return [...new Set(fields)];
}

function extractTypeRef(field: string): string | null {
  const match = field.match(/:\s*(\w+)/);
  if (!match) return null;
  const typeName = match[1];
  const GENERIC_TYPES = new Set(['Optional','list','List','Set','Dict','dict','tuple','Callable']);
  const PRIMITIVE_TYPES = new Set(['str','int','float','bool','None','Any','bytes','bytearray']);
  if (GENERIC_TYPES.has(typeName)) {
    // Extract the LAST word inside brackets: dict[str, Order] → Order, list[LineItem] → LineItem
    const inner = field.match(/\[([\w\s,]+)\]/);
    if (!inner) return null;
    const innerTypes = inner[1].split(',').map(s => s.trim()).filter(Boolean);
    const lastType = innerTypes[innerTypes.length - 1];
    if (lastType && !PRIMITIVE_TYPES.has(lastType) && !GENERIC_TYPES.has(lastType)) return lastType;
    return null;
  }
  if (PRIMITIVE_TYPES.has(typeName)) return null;
  return typeName;
}

export function erdToCfg(erd: Erd): Cfg {
  const nodes: CfgNode[] = [];
  const edges: CfgEdge[] = [];
  let firstId = '';
  let lastId = '';

  for (const ent of erd.entities) {
    const label = ent.fields.length > 0
      ? `${ent.name}\n${ent.fields.map(f => `  ${f}`).join('\n')}`
      : ent.name;
    const id = `ent_${ent.name}`;
    if (!firstId) firstId = id;
    lastId = id;
    nodes.push({
      id,
      kind: 'entity',
      label,
      range: ent.range,
      drillable: true,
    });
  }

  for (const rel of erd.relations) {
    const fromId = `ent_${rel.from}`;
    const toId = `ent_${rel.to}`;
    if (nodes.some(n => n.id === fromId) && nodes.some(n => n.id === toId)) {
      edges.push({ from: fromId, to: toId, kind: rel.kind === 'extends' ? 'true' : 'case', label: rel.kind === 'extends' ? 'extends' : rel.label });
    }
  }

  return { nodes, edges, regions: [], entryId: firstId, exitId: lastId, layout: 'erd' };
}
