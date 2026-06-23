import ELK from 'elkjs/lib/elk.bundled.js';
import rough from 'roughjs';
import { Cfg, CfgNode, CfgEdge } from '../src/cfg/model';

declare const __CFG__: Cfg;
const vscode = acquireVsCodeApi();

const SHAPES = {
  entry:     { fill: '#1b5e20', stroke: '#4caf50', icon: '▶', shape: 'oval' },
  exit:      { fill: '#b71c1c', stroke: '#f44336', icon: '■', shape: 'oval' },
  statement: { fill: '#0d47a1', stroke: '#42a5f5', icon: '', shape: 'rect' },
  branch:    { fill: '#e65100', stroke: '#ff9800', icon: '◇', shape: 'diamond' },
  loop:      { fill: '#4a148c', stroke: '#ab47bc', icon: '↻', shape: 'hexagon' },
  merge:     { fill: '#37474f', stroke: '#78909c', icon: '', shape: 'circle' },
  return:    { fill: '#b71c1c', stroke: '#ef5350', icon: '⇦', shape: 'rect' },
  raise:     { fill: '#880e4f', stroke: '#ec407a', icon: '⚠', shape: 'rect' },
};

const EDGE_STYLES: Record<string, { color: string; dash: string }> = {
  normal:     { color: '#78909c', dash: '' },
  true:       { color: '#4caf50', dash: '' },
  false:      { color: '#ef5350', dash: '' },
  'loop-back': { color: '#ab47bc', dash: '6,4' },
  exception:  { color: '#ff7043', dash: '8,4' },
  case:       { color: '#42a5f5', dash: '' },
};

const LABEL: Record<string, string> = {
  true: 'Yes', false: 'No', 'loop-back': 'Loop', exception: 'Error', case: 'Case',
};

interface ElkNode { id: string; width: number; height: number; x?: number; y?: number }
interface ElkEdge { id: string; sources: string[]; targets: string[]; sections?: Array<{ startPoint: {x:number,y:number}; endPoint: {x:number,y:number}; bendPoints?: Array<{x:number,y:number}> }> }

function measure(n: CfgNode): { w: number; h: number } {
  const s = n.label?.split('\n')[0] ?? '';
  const maxW = n.kind === 'entry' || n.kind === 'exit' ? 80 : 200;
  return { w: maxW, h: n.kind === 'merge' ? 24 : 40 };
}

function buildEdgeD(sec: ElkEdge['sections'][0]): string {
  let d = `M ${sec.startPoint.x} ${sec.startPoint.y}`;
  if (sec.bendPoints?.length) {
    for (const bp of sec.bendPoints) d += ` L ${bp.x} ${bp.y}`;
  }
  d += ` L ${sec.endPoint.x} ${sec.endPoint.y}`;
  return d;
}

function midPoint(sec: ElkEdge['sections'][0]): { x: number; y: number } {
  if (sec.bendPoints?.length) {
    const bp = sec.bendPoints;
    const last = bp[bp.length - 1];
    return { x: (last.x + sec.endPoint.x) / 2, y: (last.y + sec.endPoint.y) / 2 };
  }
  return { x: (sec.startPoint.x + sec.endPoint.x) / 2, y: (sec.startPoint.y + sec.endPoint.y) / 2 };
}

const collapsedRegions = new Set<string>();
let zoom = 1, panX = 0, panY = 0;
let tooltipEl: HTMLDivElement | null = null;
let viewportEl: HTMLDivElement | null = null;
let gW = 400, gH = 300;
let pathCounts = new Map<string, number>();
let cfgEdges: CfgEdge[] = [];
let cfgNodes: CfgNode[] = [];
let pathsMode = false;
let currentCfg: Cfg | null = null;

async function render(cfg: Cfg) {
  const elk = new ELK();
  const root = document.getElementById('root')!;
  root.innerHTML = `
    <div class="canvas" id="canvas">
      <div class="toolbar" id="toolbar">
        <button class="tb-btn" id="paths-btn" title="Toggle Paths View">🔀</button>
        <span class="tb-sep"></span>
        <button class="tb-btn" id="zoom-in" title="Zoom In">+</button>
        <span class="zoom-lvl" id="zoom-lvl">100%</span>
        <button class="tb-btn" id="zoom-out" title="Zoom Out">−</button>
        <button class="tb-btn" id="fit" title="Fit to View">⊡</button>
      </div>
      <div class="tooltip" id="tooltip"></div>
      <div class="viewport" id="viewport">
        <svg class="shapes-svg" id="shapes-svg">
          <defs></defs>
          <g id="edges-g"></g>
          <g id="shapes-g"></g>
        </svg>
        <div class="nodes" id="nodes"></div>
      </div>
    </div>
  `;

  const shapesSvg = document.getElementById('shapes-svg') as unknown as SVGSVGElement;
  const edgesG = document.getElementById('edges-g') as unknown as SVGGElement;
  const shapesG = document.getElementById('shapes-g') as unknown as SVGGElement;
  const nodesDiv = document.getElementById('nodes') as HTMLDivElement;
  const canvas = document.getElementById('canvas')!;
  viewportEl = document.getElementById('viewport') as HTMLDivElement;
  const tooltip = document.getElementById('tooltip') as HTMLDivElement;
  tooltipEl = tooltip;

  const rc = rough.svg(shapesSvg);

  try {
    currentCfg = cfg;
    const { nodes: active, edges: raw } = filterActive(cfg);
    const egs = reroute(cfg, raw);

    const elkGraph = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'DOWN',
        'elk.layered.spacing.nodeNodeBetweenLayers': '48',
        'elk.spacing.nodeNode': '32',
        'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      },
      children: active.map(n => { const {w,h} = measure(n); return {id:n.id,width:w,height:h}; }),
      edges: egs.map((_,i) => ({id:`e${i}`,sources:[_.from],targets:[_.to]})),
    };

    const layout = await elk.layout(elkGraph);
    const cMap = new Map(active.map(n => [n.id, n]));
    const eMap = new Map(egs.map((e,i) => [`e${i}`, e]));
    const lc = (layout.children ?? []) as ElkNode[];
    const le = (layout.edges ?? []) as ElkEdge[];

    gW = 400; gH = 300;
    for (const c of lc) {
      if (c.x && c.y) {
        gW = Math.max(gW, c.x + (c.width ?? 200) + 100);
        gH = Math.max(gH, c.y + (c.height ?? 40) + 100);
      }
    }

    cfgNodes = active;
    cfgEdges = egs;
    pathCounts = computePathCounts(active, egs);

    const collapsibleIds = new Set(cfg.regions.map(r => r.headerId));

    shapesSvg.setAttribute('viewBox', `0 0 ${gW} ${gH}`);
    shapesSvg.style.width = gW + 'px';
    shapesSvg.style.height = gH + 'px';

    for (const e of le) {
      if (!e.sections?.length) continue;
      const info = eMap.get(e.id);
      const st = EDGE_STYLES[info?.kind ?? 'normal'] ?? EDGE_STYLES.normal;

      for (const sec of e.sections) {
        const d = buildEdgeD(sec);
        const el = rc.path(d, {
          stroke: st.color,
          strokeWidth: 2,
          roughness: 1,
          bowing: 0.8,
        });
          el.classList.add('edge');
          try { el.dataset.from = info?.from ?? ''; el.dataset.to = info?.to ?? ''; } catch (_) {}
          edgesG.appendChild(el);
      }

      const lbl = LABEL[info?.kind ?? ''] ?? '';
      if (lbl) {
        try {
          const mp = midPoint(e.sections[e.sections.length - 1]);
          if (mp.x == null || mp.y == null) continue;
          const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          bg.setAttribute('x', String(mp.x - 18));
          bg.setAttribute('y', String(mp.y - 18));
          bg.setAttribute('width', '36');
          bg.setAttribute('height', '18');
          bg.setAttribute('rx', '4');
          bg.setAttribute('fill', '#252526');
          bg.setAttribute('opacity', '0.85');
          bg.classList.add('edge-label-bg');
          edgesG.appendChild(bg);

          const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          t.setAttribute('x', String(mp.x));
          t.setAttribute('y', String(mp.y - 4));
          t.setAttribute('fill', st.color);
          t.setAttribute('font-size', '11');
          t.setAttribute('font-weight', '700');
          t.setAttribute('text-anchor', 'middle');
          t.textContent = lbl;
          t.classList.add('edge-label');
          edgesG.appendChild(t);
        } catch (_) {
          console.warn('edge label render error', _);
        }
      }
    }

    const ns = 'http://www.w3.org/2000/svg';

    for (const c of lc) {
      if (!c.x || !c.y) continue;
      const node = cMap.get(c.id);
      if (!node) continue;
      const st = SHAPES[node.kind] ?? SHAPES.statement;
      const cw = c.width ?? 200, ch = c.height ?? 40;
      const cx = c.x, cy = c.y;

      let roughEl: SVGElement;
      const opts = { fill: st.fill, fillStyle: 'solid' as const, stroke: st.stroke, strokeWidth: 2, roughness: 1.6, bowing: 1.2 };

      if (st.shape === 'oval') {
        roughEl = rc.ellipse(cx + cw / 2, cy + ch / 2, cw * 0.85, ch * 0.8, opts) as SVGElement;
      } else if (st.shape === 'diamond') {
        const pts = [[cx + cw / 2, cy], [cx + cw, cy + ch / 2], [cx + cw / 2, cy + ch], [cx, cy + ch / 2]];
        roughEl = rc.polygon(pts, opts) as SVGElement;
      } else if (st.shape === 'hexagon') {
        const qw = cw / 6;
        const pts = [[cx + qw, cy], [cx + cw - qw, cy], [cx + cw, cy + ch / 2], [cx + cw - qw, cy + ch], [cx + qw, cy + ch], [cx, cy + ch / 2]];
        roughEl = rc.polygon(pts, opts) as SVGElement;
      } else if (st.shape === 'circle') {
        const d = Math.min(cw, ch) * 0.9;
        roughEl = rc.circle(cx + cw / 2, cy + ch / 2, d, opts) as SVGElement;
      } else {
        roughEl = rc.rectangle(cx, cy, cw, ch, opts) as SVGElement;
      }

      roughEl.classList.add('rough-shape');
      try { roughEl.dataset.id = node.id; } catch (_) {}
      shapesG.appendChild(roughEl);

      const div = document.createElement('div');
      div.className = `node node-${st.shape}`;
      div.dataset.id = node.id;
      div.style.left = cx + 'px';
      div.style.top = cy + 'px';
      div.style.width = cw + 'px';
      div.style.height = ch + 'px';

      const label = document.createElement('span');
      label.className = 'node-label';
      label.textContent = node.label?.split('\n')[0] ?? '';
      div.appendChild(label);

      div.addEventListener('mouseenter', (e) => {
        roughEl.style.filter = 'brightness(1.2) contrast(1.1)';
        if (node.range) showTooltip(e, node);
      });
      div.addEventListener('mousemove', (e) => moveTooltip(e));
      div.addEventListener('mouseleave', () => {
        roughEl.style.filter = '';
        hideTooltip();
      });

      if (collapsibleIds.has(node.id)) {
        div.classList.add('node-collapsible');
        if (collapsedRegions.has(node.regionId ?? '')) {
          div.classList.add('node-collapsed');
        }
        div.title = 'Double-click to expand/collapse';
        div.addEventListener('dblclick', () => {
          const region = cfg.regions.find(r => r.headerId === node.id);
          if (!region) return;
          if (collapsedRegions.has(region.id)) {
            collapsedRegions.delete(region.id);
          } else {
            collapsedRegions.add(region.id);
          }
          if (currentCfg) render(currentCfg);
        });
      } else if (node.range) {
        div.style.cursor = 'pointer';
        div.addEventListener('click', () => vscode.postMessage({ type: 'reveal', range: node.range }));
      }

      nodesDiv.appendChild(div);
    }

    applyTransform();
    setupInteraction(canvas);
    setupPathsMode(canvas);
  } catch (err) {
    root.innerHTML = `<div class="error">Failed to render: ${err}</div>`;
  }
}

function showTooltip(e: MouseEvent, node: CfgNode) {
  if (!tooltipEl) return;
  const s = SHAPES[node.kind] ?? SHAPES.statement;
  const pc = pathCounts.get(node.id);
  const pathInfo = pc !== undefined ? `<div class="tt-paths">${pc} path${pc !== 1 ? 's' : ''} from entry</div>` : '';
  tooltipEl.innerHTML = `
    <div class="tt-header" style="color:${s.stroke}">${node.kind.toUpperCase()}</div>
    <div class="tt-body">${node.label ?? ''}</div>
    ${pathInfo}
    ${node.range ? `<div class="tt-src">Line ${node.range.startLine + 1}</div>` : ''}
  `;
  tooltipEl.style.display = 'block';
  moveTooltip(e);
}

function moveTooltip(e: MouseEvent) {
  if (!tooltipEl) return;
  const pad = 12;
  let x = e.clientX + pad, y = e.clientY + pad;
  const r = tooltipEl.getBoundingClientRect();
  if (x + r.width > window.innerWidth - pad) x = e.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - pad) y = e.clientY - r.height - pad;
  tooltipEl.style.left = x + 'px';
  tooltipEl.style.top = y + 'px';
}

function hideTooltip() {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

function applyTransform() {
  if (!viewportEl) return;
  viewportEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  const lvl = document.getElementById('zoom-lvl');
  if (lvl) lvl.textContent = Math.round(zoom * 100) + '%';
}

function setupInteraction(canvas: HTMLElement) {
  let dragging = false, lastX = 0, lastY = 0;
  const zoomIn = document.getElementById('zoom-in')!;
  const zoomOut = document.getElementById('zoom-out')!;
  const fit = document.getElementById('fit')!;

  canvas.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('.tb-btn, .toolbar, .node')) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panX += (e.clientX - lastX);
    panY += (e.clientY - lastY);
    lastX = e.clientX;
    lastY = e.clientY;
    applyTransform();
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
    canvas.style.cursor = 'grab';
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newZ = Math.max(0.1, Math.min(5, zoom * delta));
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    panX = mx - (mx - panX) * (newZ / zoom);
    panY = my - (my - panY) * (newZ / zoom);
    zoom = newZ;
    applyTransform();
  }, { passive: false });

  zoomIn.addEventListener('click', () => {
    zoom = Math.min(5, zoom * 1.3);
    applyTransform();
  });

  zoomOut.addEventListener('click', () => {
    zoom = Math.max(0.1, zoom / 1.3);
    applyTransform();
  });

  fit.addEventListener('click', () => {
    zoom = 1; panX = 0; panY = 0;
    applyTransform();
  });
}

function computePathCounts(nodes: CfgNode[], edges: CfgEdge[]): Map<string, number> {
  const adj = new Map<string, string[]>();
  const isBackEdge = new Map<string, boolean>();
  const entryIds = nodes.filter(n => n.kind === 'entry').map(n => n.id);

  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    adj.get(e.from)?.push(e.to);
    isBackEdge.set(e.from + '→' + e.to, e.kind === 'loop-back');
  }

  const memo = new Map<string, number>();
  const visited = new Set<string>();

  function dfs(id: string): number {
    if (memo.has(id)) return memo.get(id)!;
    if (entryIds.includes(id)) { memo.set(id, 1); return 1; }
    let total = 0;
    for (const [from, tos] of adj) {
      for (const to of tos) {
        if (to !== id || isBackEdge.get(from + '→' + to)) continue;
        if (visited.has(from)) continue;
        visited.add(from);
        total += dfs(from);
        visited.delete(from);
      }
    }
    memo.set(id, Math.max(total, 1));
    return memo.get(id)!;
  }

  const result = new Map<string, number>();
  for (const n of nodes) {
    visited.clear();
    result.set(n.id, dfs(n.id));
  }
  return result;
}

function highlightPathsTo(targetId: string) {
  const edgesG = document.getElementById('edges-g');
  if (!edgesG) return;
  const allEdges = edgesG.querySelectorAll('.edge');
  const allShapes = document.querySelectorAll('.rough-shape');

  if (!pathsMode || !targetId) {
    allEdges.forEach(e => e.classList.remove('edge-dim'));
    allShapes.forEach(s => s.classList.remove('shape-dim'));
    return;
  }

  const adj = new Map<string, string[]>();
  for (const e of cfgEdges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }

  const onPath = new Set<string>();
  const onEdge = new Set<string>();
  const visited = new Set<string>();

  function collect(nodes: string[]) {
    for (const id of nodes) {
      const adjE = cfgEdges.filter(e => e.from === id);
      for (const e of adjE) {
        onEdge.add(e.from + '→' + e.to);
      }
    }
  }

  function mark(id: string, stack: string[]) {
    if (visited.has(id)) return;
    visited.add(id);
    stack.push(id);
    if (id === targetId) {
      for (const s of stack) onPath.add(s);
      collect(stack);
      stack.pop();
      visited.delete(id);
      return;
    }
    const tos = adj.get(id) ?? [];
    for (const to of tos) {
      if (stack.includes(to)) continue;
      mark(to, stack);
    }
    stack.pop();
    visited.delete(id);
  }

  const entryIds = cfgNodes.filter(n => n.kind === 'entry').map(n => n.id);
  for (const eid of entryIds) mark(eid, []);

  allEdges.forEach((el) => {
    const from = el.dataset.from;
    const to = el.dataset.to;
    const key = from + '→' + to;
    if (!onEdge.has(key)) el.classList.add('edge-dim');
  });

  allShapes.forEach((s) => {
    const id = (s as SVGElement).dataset.id;
    if (id && !onPath.has(id)) s.classList.add('shape-dim');
  });
}

function setupPathsMode(canvas: HTMLElement) {
  const btn = document.getElementById('paths-btn')!;
  btn.addEventListener('click', () => {
    pathsMode = !pathsMode;
    btn.classList.toggle('tb-active', pathsMode);
    if (!pathsMode) highlightPathsTo('');
  });

  canvas.addEventListener('click', (e) => {
    if (!pathsMode) return;
    const nodeDiv = (e.target as HTMLElement).closest('.node') as HTMLElement | null;
    if (nodeDiv) highlightPathsTo(nodeDiv.dataset.id ?? '');
  });
}

function filterActive(cfg: Cfg) {
  const hidden = new Set<string>();
  for (const r of cfg.regions) {
    if (collapsedRegions.has(r.id)) for (const m of r.memberIds) hidden.add(m);
  }
  const nodes = cfg.nodes.filter(n => !hidden.has(n.id));
  const ids = new Set(nodes.map(n => n.id));
  return { nodes, edges: cfg.edges.filter(e => ids.has(e.from) && ids.has(e.to)) };
}

function reroute(cfg: Cfg, edges: CfgEdge[]) {
  const header = new Map<string, string>();
  for (const r of cfg.regions) {
    if (collapsedRegions.has(r.id)) for (const m of r.memberIds) header.set(m, r.headerId);
  }
  return edges.map(e => ({ ...e, from: header.get(e.from) ?? e.from, to: header.get(e.to) ?? e.to }));
}

document.addEventListener('DOMContentLoaded', () => {
  if (typeof __CFG__ !== 'undefined') render(__CFG__);
});
