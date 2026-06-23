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

async function render(cfg: Cfg) {
  const elk = new ELK();
  const root = document.getElementById('root')!;
  root.innerHTML = `
    <div class="canvas" id="canvas">
      <div class="toolbar" id="toolbar">
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
        edgesG.appendChild(el);
      }

      const lbl = LABEL[info?.kind ?? ''] ?? '';
      if (lbl) {
        const mp = midPoint(e.sections[e.sections.length - 1]);
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', String(mp.x));
        t.setAttribute('y', String(mp.y - 6));
        t.setAttribute('fill', st.color);
        t.setAttribute('font-size', '11');
        t.setAttribute('font-weight', '600');
        t.setAttribute('text-anchor', 'middle');
        t.textContent = lbl;
        t.classList.add('edge-label');
        edgesG.appendChild(t);
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
      roughEl.dataset.id = node.id;
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

      if (node.range) {
        div.style.cursor = 'pointer';
        div.addEventListener('click', () => vscode.postMessage({ type: 'reveal', range: node.range }));
      }

      nodesDiv.appendChild(div);
    }

    applyTransform();
    setupInteraction(canvas);
  } catch (err) {
    root.innerHTML = `<div class="error">Failed to render: ${err}</div>`;
  }
}

function showTooltip(e: MouseEvent, node: CfgNode) {
  if (!tooltipEl) return;
  const s = SHAPES[node.kind] ?? SHAPES.statement;
  tooltipEl.innerHTML = `
    <div class="tt-header" style="color:${s.stroke}">${node.kind.toUpperCase()}</div>
    <div class="tt-body">${node.label ?? ''}</div>
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
