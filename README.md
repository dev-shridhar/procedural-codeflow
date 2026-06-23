# Procedural CodeFlow

Render the control flow of any Python function as an interactive, hand-drawn style graph directly in VS Code.

## Features

- **One-click CFG** — right-click any Python function and select "CodeFlow: Show procedural flow"
- **Hand-drawn aesthetic** — graphs are rendered with RoughJS for a sketchy, hand-drawn look
- **Interactive** — pan, zoom, hover for tooltips, collapse/expand regions (if/for/while/try/match)
- **Paths view** — click a node to highlight all paths from entry to that node
- **Call resolution** — cursor on a function call shows the callee's CFG (including cross-file, class methods, factory chains)
- **Type-aware** — resolves `self.method()`, `obj.method()`, return type annotations, class MRO
- **Edge labels** — "Yes"/"No" on branches, exception types on try/except edges

## Usage

1. Open a Python file
2. Right-click inside any function → **CodeFlow: Show procedural flow for function at cursor**
3. Alternatively, run the command palette (`Cmd+Shift+P`) and search for "CodeFlow"

### Graph Controls

| Action | Control |
|--------|---------|
| Pan | Click and drag empty space |
| Zoom | Scroll wheel or +/- buttons |
| Fit | Click ⊡ button |
| Paths mode | Click 🔀, then click any node |
| Collapse/Expand | Double-click loop/if/for/while headers |
| Tooltip | Hover over any node |
| Reveal source | Click a node with source range |

## Requirements

- VS Code 1.90+
- Python files only

## Extension Settings

This extension contributes one command:

- `codeflow.showProcedural` — Show the procedural control flow graph for the function at the cursor

## Known Limitations

- Only Python is supported
- Dynamic dispatch and external library calls may not resolve
- Graph layout is automatic (ELK layered) — no manual rearrangement

## License

MIT
