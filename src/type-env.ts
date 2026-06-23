import Parser from 'web-tree-sitter';

export class TypeEnv {
  private scopes: Map<string, string>[] = [new Map()];

  push(): void {
    this.scopes.push(new Map());
  }

  pop(): void {
    this.scopes.pop();
  }

  set(name: string, type: string): void {
    this.scopes[this.scopes.length - 1].set(name, type);
  }

  get(name: string): string | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) return this.scopes[i].get(name);
    }
    return undefined;
  }

  trackAssignment(node: Parser.SyntaxNode): void {
    if (node.type !== 'expression_statement') return;
    const assignment = node.firstNamedChild;
    if (!assignment || assignment.type !== 'assignment') return;
    const left = assignment.childForFieldName('left');
    const right = assignment.childForFieldName('right');
    if (!left || !right) return;

    // x = Foo() → x : Foo
    if (left.type === 'identifier' && right.type === 'call') {
      const callee = right.childForFieldName('function');
      if (callee && callee.type === 'identifier') {
        this.set(left.text, callee.text);
      }
      // x = obj.method() → x : ReturnType (can't infer easily, skip)
    }

    // x: SomeClass = ... → x : SomeClass
    if (left.type === 'identifier') {
      const typeNode = left.nextNamedSibling;
      if (typeNode && typeNode.type === 'type') {
        this.set(left.text, typeNode.text);
      }
    }
  }
}
