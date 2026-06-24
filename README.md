# CodeDetective

Interactive control-flow graphs and entity-relationship diagrams for Python code, rendered in a hand-drawn style directly in VS Code.

## Features

- **One-click CFG** — right-click any Python function and select "CodeDetective: Show code flow"
- **ERD** — visualize entity-relationship diagrams from your classes
- **Hand-drawn aesthetic** — RoughJS sketchy style
- **Interactive** — pan, zoom, hover for tooltips, collapse/expand regions
- **Call resolution** — cursor on a function call shows the callee's CFG
- **Type-aware** — resolves `self.method()`, `obj.method()`, return type annotations, class MRO
- **Edge labels** — "Yes"/"No" on branches, exception types on try/except edges

## Usage

1. Open a Python file
2. Right-click inside any function → **CodeDetective: Show code flow**
3. Or run from command palette (`Cmd+Shift+P`): **CodeDetective: Show code flow** / **CodeDetective: Show ERD**

### Graph Controls

| Action | Control |
|--------|---------|
| Pan | Click and drag empty space |
| Zoom | Scroll wheel or +/- buttons |
| Fit | Click ⊡ button |
| Collapse/Expand | Double-click loop/if/for/while headers |
| Tooltip | Hover over any node |
| Reveal source | Click a node with source range |

## Requirements

- VS Code 1.90+
- Python files only

## License

MIT
