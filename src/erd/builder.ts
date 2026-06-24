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
    // Annotated assignment: x: Type or x: Type = value
    if (stmt.type === 'expression_statement') {
      const expr = stmt.firstNamedChild;
      if (expr?.type === 'assignment' || expr?.type === 'augmented_assignment') continue;
    }
    if (stmt.type === 'expression_statement' || stmt.type === 'assignment') {
      const typed = stmt.descendantsOfType('typed_parameter');
      for (const tp of typed) {
        const nameNode = tp.childForFieldName('name');
        const typeNode = tp.childForFieldName('type');
        if (nameNode && typeNode) {
          fields.push(`${nameNode.text}: ${typeNode.text}`);
        }
      }
    }

    // Handle `x: int` and `x: int = 5` patterns
    if (stmt.type === 'expression_statement') {
      const first = stmt.firstNamedChild;
      if (first?.type === 'assignment' || first?.type === 'augmented_assignment') {
        // skip assignments that aren't type-annotated
      }
    }

    // Simple annotated assignment: x: Type, x: Type = value
    // These appear as children of block with type annotation
    for (const child of stmt.namedChildren) {
      if (child.type === 'typed_parameter' || child.type === 'default_parameter') {
        const nameNode = child.childForFieldName('name');
        if (nameNode) {
          const text = child.text;
          if (text.includes(':')) {
            const parts = text.split(':', 2);
            fields.push(`${parts[0].trim()}: ${parts[1].trim()}`);
          } else {
            fields.push(text);
          }
        }
      }
    }
  }

  // Also look at __init__ method for self.field assignments
  const init = body.namedChildren.find(
    c => c.type === 'function_definition' && c.childForFieldName('name')?.text === '__init__'
  );
  if (init) {
    const initBody = init.childForFieldName('body');
    if (initBody) {
      for (const stmt of initBody.namedChildren) {
        if (stmt.type === 'expression_statement') {
          const assign = stmt.firstNamedChild;
          if (assign?.type === 'assignment') {
            const left = assign.childForFieldName('left');
            if (left?.type === 'attribute' && left.childForFieldName('object')?.text === 'self') {
              const fieldName = left.childForFieldName('attribute')?.text;
              if (fieldName && !fields.some(f => f.startsWith(fieldName + ':'))) {
                fields.push(`${fieldName}: Any`);
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
  // Extract the type name from a field string like "name: TypeName" or "name: Optional[TypeName]"
  const match = field.match(/:\s*(\w+)/);
  if (!match) return null;
  const typeName = match[1];
  if (typeName === 'Optional' || typeName === 'list' || typeName === 'List' || typeName === 'Set' || typeName === 'Dict' || typeName === 'tuple') {
    // Extract inner type: Optional[TypeName], list[TypeName]
    const inner = field.match(/\[(\w+)\]/);
    return inner ? inner[1] : null;
  }
  if (typeName === 'str' || typeName === 'int' || typeName === 'float' || typeName === 'bool' || typeName === 'None' || typeName === 'Any') {
    return null;
  }
  return typeName;
}

export function erdToCfg(erd: Erd): Cfg {
  const nodes: CfgNode[] = [
    { id: 'entry', kind: 'entry', label: 'entry' },
    { id: 'exit', kind: 'exit', label: 'exit' },
  ];
  const edges: CfgEdge[] = [];

  for (const ent of erd.entities) {
    const label = ent.fields.length > 0
      ? `${ent.name}\n${ent.fields.map(f => `  ${f}`).join('\n')}`
      : ent.name;
    nodes.push({
      id: `ent_${ent.name}`,
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

  return { nodes, edges, regions: [], entryId: 'entry', exitId: 'exit' };
}
