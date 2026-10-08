// Shared admin map viewer (CMS_SPEC §7.3). Inlines the floor SVG (so unit shapes are clickable), keeps one overlay
// <g> per layer in the same viewBox coordinates, pans/zooms by animating the root viewBox.
// Independent from the kiosk's js/map.js on purpose.
import { h, ic, svgEl, clear, assetUrl } from './ui.js';
import { BUILDING_LABEL } from './state.js';

const svgCache = new Map();
async function loadSvg(url) {
  if (!svgCache.has(url)) svgCache.set(url, fetch(assetUrl(url), { cache: 'force-cache' }).then(r => { if (!r.ok) throw new Error('SVG ' + r.status); return r.text(); }));
  return svgCache.get(url);
}
function sanitize(svg) {
  // defence in depth — server sanitizes on upload (§8.2); strip anything executable before inlining
  svg.querySelectorAll('script,foreignObject,iframe,image').forEach(n => n.remove());
  const walker = document.createTreeWalker(svg, NodeFilter.SHOW_ELEMENT);
  for (let n = svg; n; n = walker.nextNode()) for (const a of [...n.attributes]) {
    if (/^on/i.test(a.name) || /javascript:/i.test(a.value) || ((a.name === 'href' || a.name === 'xlink:href') && !a.value.startsWith('#'))) n.removeAttribute(a.name);
  }
  return svg;
}
export const LAYERS = { units: 'Unit (sorot)', graph: 'Graph', connectors: 'Konektor', tenants: 'Pin tenant', labels: 'Nama tenant', kiosks: 'Kiosk', pois: 'Fasilitas' };

export class MapCanvas {
  /**
   * @param {HTMLElement} host
   * @param {{floors:Array, floorId?:string, picker?:boolean, layers?:object, layerToggle?:boolean, onFloor?:Function, onRender?:Function, height?:string}} o
   */
  constructor(host, o = {}) {
    this.o = o; this.floors = o.floors || []; this.floor = null; this.vb = { x: 0, y: 0, w: 1920, h: 1080 };
    this.layersOn = Object.assign({ units: true, graph: true, connectors: true, tenants: true, labels: false, kiosks: true, pois: true }, o.layers || {});
    this.leftPan = o.leftPan !== false;
    this.handlers = {};
    this.el = h('div.mc', { style: o.height ? { height: o.height } : null });
    this.svg = svgEl('svg', { class: 'mc-root', preserveAspectRatio: 'xMidYMid meet' });
    this.floorG = svgEl('g', { class: 'mc-floor' });
    this.ovG = svgEl('g', { class: 'mc-overlay' });
    this.layerG = {};
    for (const k of ['focus', 'units', 'graph', 'connectors', 'tenants', 'labels', 'kiosks', 'pois', 'top']) { this.layerG[k] = svgEl('g', { class: 'ly-' + k }); this.ovG.append(this.layerG[k]); }
    this.svg.append(this.floorG, this.ovG);
    this.loadingEl = h('div.mc-loading', h('span.spinner'));
    this.hintEl = h('div.mc-hint', { hidden: true });
    this.coordEl = h('div.mc-coord', { hidden: !o.coords });
    this.ctrls = h('div.mc-ctrls',
      h('button', { type: 'button', title: 'Perbesar (+)', 'aria-label': 'Perbesar', onclick: () => this.zoomBy(1 / 1.4) }, ic('plus')),
      h('button', { type: 'button', title: 'Perkecil (−)', 'aria-label': 'Perkecil', onclick: () => this.zoomBy(1.4) }, ic('minus')),
      h('button', { type: 'button', title: 'Pas layar (0)', 'aria-label': 'Pas layar', onclick: () => this.fit() }, ic('maximize')));
    this.el.append(this.svg, this.loadingEl, this.hintEl, this.coordEl, this.ctrls);
    if (o.picker !== false) { this.pickerEl = h('div.mc-floors'); this.el.append(this.pickerEl); }
    if (o.layerToggle) this.el.append(this.buildLayerToggle());
    host.append(this.el);
    this.bind();
    this.ro = new ResizeObserver(() => this.apply());
    this.ro.observe(this.el);
    this.ready = o.floorId ? this.setFloor(o.floorId) : Promise.resolve();
  }
  on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
  emit(evt, ...a) { (this.handlers[evt] || []).forEach(fn => fn(...a)); }
  destroy() { this.ro.disconnect(); this.el.remove(); this.destroyed = true; }

  buildLayerToggle() {
    const pop = h('div.pop', { hidden: true });
    for (const k in LAYERS) {
      const cb = h('input', { type: 'checkbox', checked: this.layersOn[k], onchange: () => { this.layersOn[k] = cb.checked; this.applyLayerVis(); this.redraw(); } });
      pop.append(h('label.check', cb, LAYERS[k]));
    }
    const wrap = h('div.mc-layers', h('button.btn.sm', { type: 'button', onclick: () => pop.hidden = !pop.hidden }, ic('layers'), 'Layer'), pop);
    return wrap;
  }
  applyLayerVis() { for (const k in this.layerG) if (k in this.layersOn) this.layerG[k].style.display = this.layersOn[k] ? '' : 'none'; }

  renderPicker() {
    if (!this.pickerEl) return;
    clear(this.pickerEl);
    const levels = [...new Set(this.floors.map(f => f.level))].sort((a, b) => b - a);
    for (const lv of levels) {
      const fl = this.floors.filter(f => f.level === lv);
      this.pickerEl.append(h('span.lv', fl[0].short));
      const both = fl.find(f => f.building === 'both');
      if (both) this.pickerEl.append(this.floorBtn(both, 'Gabungan', true));
      else for (const b of ['pentacity', 'ewalk']) {
        const f = fl.find(x => x.building === b);
        this.pickerEl.append(f ? this.floorBtn(f, BUILDING_LABEL[b]) : h('span'));
      }
    }
  }
  floorBtn(f, label, span) {
    return h('button', { type: 'button', class: (span ? 'span2 ' : '') + (this.floor && this.floor.id === f.id ? 'on' : ''), title: f.nameId || f.nameEn, onclick: () => this.setFloor(f.id, true) }, label);
  }

  async setFloor(id, user) {
    const f = this.floors.find(x => x.id === id); if (!f) return;
    const changed = !this.floor || this.floor.id !== id;
    this.floor = f; this.renderPicker();
    this.loadingEl.hidden = false;
    const tok = this._tok = Symbol();
    try {
      const txt = await loadSvg(f.svgUrl);
      if (tok !== this._tok || this.destroyed) return;
      const doc = new DOMParser().parseFromString(txt, 'image/svg+xml');
      const src = doc.documentElement;
      if (src.nodeName !== 'svg') throw new Error('SVG tidak valid');
      const node = sanitize(document.importNode(src, true));
      const [vx, vy, vw, vh] = f.viewBox;
      node.setAttribute('x', vx); node.setAttribute('y', vy); node.setAttribute('width', vw); node.setAttribute('height', vh);
      node.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
      node.removeAttribute('class'); node.setAttribute('class', 'mc-floor-svg');
      clear(this.floorG).append(node);
      this.floorSvg = node;
    } catch (e) {
      clear(this.floorG).append(svgEl('text', { x: f.viewBox[2] / 2, y: f.viewBox[3] / 2, 'text-anchor': 'middle', 'font-size': 28, fill: '#B4531B', text: 'SVG lantai gagal dimuat: ' + e.message }));
    }
    this.loadingEl.hidden = true;
    if (changed) this.fit();
    this.applyLayerVis();
    this.redraw();
    this.emit('floor', f, !!user);
  }

  // ---------- camera ----------
  /** Fit to the floor's focus boxes (union, padded) when known, else the whole viewBox. full=true → whole viewBox. */
  fit(full) {
    if (!this.floor) return;
    const fb = this.floor.focus && Object.values(this.floor.focus).filter(Boolean);
    if (!full && fb && fb.length) {
      const x0 = Math.min(...fb.map(r => r[0])), y0 = Math.min(...fb.map(r => r[1])), x1 = Math.max(...fb.map(r => r[0] + r[2])), y1 = Math.max(...fb.map(r => r[1] + r[3]));
      this.zoomToBox([x0, y0, x1 - x0, y1 - y0], .12); return;
    }
    const [x, y, w, hh] = this.floor.viewBox;
    this.vb = { x, y, w, h: hh }; this.apply();
  }
  zoomToBox([x, y, w, hh], pad = .15) {
    this.vb = { x: x - w * pad, y: y - hh * pad, w: w * (1 + 2 * pad), h: hh * (1 + 2 * pad) }; this.apply();
  }
  centerOn(x, y, w = 360) {
    const r = this.el.clientHeight / Math.max(1, this.el.clientWidth) || .56;
    this.vb = { x: x - w / 2, y: y - w * r / 2, w, h: w * r }; this.apply();
  }
  zoomBy(f, cx, cy) {
    const v = this.vb; if (cx == null) { cx = v.x + v.w / 2; cy = v.y + v.h / 2; }
    const fw = this.floor ? this.floor.viewBox[2] : 1920;
    const nw = Math.max(fw / 40, Math.min(fw * 2.5, v.w * f)); const k = nw / v.w;
    this.vb = { x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k, w: v.w * k, h: v.h * k }; this.apply();
  }
  apply() {
    const v = this.vb; this.svg.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    const s = this.scale();
    if (Math.abs(s - (this._lastScale || 0)) / (s || 1) > .02) { this._lastScale = s; this.scheduleRedraw(); }
  }
  /** screen pixels per SVG unit */
  scale() { const m = this.svg.getScreenCTM(); return m ? m.a : 1; }
  /** n screen px → svg units */
  px(n) { return n / (this.scale() || 1); }
  toSvg(e) {
    const m = this.svg.getScreenCTM(); if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse()); return { x: p.x, y: p.y };
  }
  scheduleRedraw() { if (this._raf) return; this._raf = requestAnimationFrame(() => { this._raf = null; this.redraw(); }); }
  redraw() { if (this.floor && this.o.onRender) this.o.onRender(this); this.emit('render', this); }
  layer(name) { return clear(this.layerG[name]); }
  hint(text) { this.hintEl.hidden = !text; this.hintEl.textContent = text || ''; }
  setCursor(mode) { this.el.classList.toggle('mode-crosshair', mode === 'crosshair'); }

  // ---------- interaction ----------
  bind() {
    const el = this.el, svg = this.svg;
    let pan = null, space = false;
    svg.addEventListener('wheel', e => {
      e.preventDefault();
      const p = this.toSvg(e); const f = Math.exp((e.ctrlKey ? e.deltaY * 3 : e.deltaY) * 0.0015);
      this.zoomBy(f, p.x, p.y);
    }, { passive: false });
    const onKeyDown = e => { if (e.code === 'Space' && !e.target.closest('input,textarea,select') && el.matches(':hover')) { space = true; el.classList.add('space'); e.preventDefault(); } };
    const onKeyUp = e => { if (e.code === 'Space') { space = false; el.classList.remove('space'); } };
    document.addEventListener('keydown', onKeyDown); document.addEventListener('keyup', onKeyUp);
    this._unbind = () => { document.removeEventListener('keydown', onKeyDown); document.removeEventListener('keyup', onKeyUp); };
    svg.addEventListener('pointerdown', e => {
      const onBg = !e.target.closest('.mc-overlay [data-hit]');
      const wantPan = e.button === 1 || space || (e.button === 0 && this.leftPan && onBg && !this.capture);
      if (!wantPan) return;
      e.preventDefault();
      pan = { sx: e.clientX, sy: e.clientY, vb: Object.assign({}, this.vb), moved: false, id: e.pointerId, btn: e.button };
      svg.setPointerCapture(e.pointerId);
      el.classList.add('panning');
    });
    svg.addEventListener('pointermove', e => {
      if (this.coordEl && !this.coordEl.hidden) { const p = this.toSvg(e); this.coordEl.textContent = `${p.x.toFixed(1)}, ${p.y.toFixed(1)}`; }
      if (!pan) return;
      const dx = e.clientX - pan.sx, dy = e.clientY - pan.sy;
      if (!pan.moved && Math.hypot(dx, dy) < 4) return;
      pan.moved = true; el.classList.add('dragging');
      const s = this.scale();
      this.vb = Object.assign({}, pan.vb, { x: pan.vb.x - dx / s, y: pan.vb.y - dy / s }); this.apply();
    });
    const end = e => {
      if (!pan) return;
      const wasClick = !pan.moved && pan.btn === 0 && !space;
      pan = null; el.classList.remove('panning', 'dragging');
      if (wasClick) this.emit('click', this.toSvg(e), e);
    };
    svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', () => { pan = null; el.classList.remove('panning', 'dragging'); });
    // clicks on overlay items / when leftPan is off go through 'click'
    svg.addEventListener('click', e => {
      if (e.target.closest('.mc-overlay [data-hit]')) return; // handled by item
      if (this.leftPan && !this.capture) return; // handled via pointerup
      this.emit('click', this.toSvg(e), e);
    });
    // unit shape hover/pick
    this.floorG.addEventListener('mouseover', e => {
      if (!this.unitPick) return;
      const s = e.target.closest('path[id],rect[id],polygon[id],ellipse[id],polyline[id]');
      if (this._hov && this._hov !== s) this._hov.classList.remove('ov-unit-hover');
      if (s && this.floorSvg && this.floorSvg.contains(s)) { s.classList.add('ov-unit-hover'); this._hov = s; this.unitPick.hover && this.unitPick.hover(s.id); }
    });
    this.floorG.addEventListener('mouseout', e => { if (this._hov && !this.floorG.contains(e.relatedTarget)) { this._hov.classList.remove('ov-unit-hover'); this._hov = null; } });
    this.floorG.addEventListener('click', e => {
      if (!this.unitPick) return;
      const s = e.target.closest('path[id],rect[id],polygon[id],ellipse[id],polyline[id]');
      if (s) { e.stopPropagation(); this.unitPick.pick(s.id, s); }
    }, true);
    el.addEventListener('keydown', e => { if (e.key === '0') this.fit(); if (e.key === '+' || e.key === '=') this.zoomBy(1 / 1.4); if (e.key === '-') this.zoomBy(1.4); });
    el.tabIndex = 0;
  }
  /** Enable "Pilih unit" mode: cb.pick(shapeId). capture=true so left click doesn't pan. */
  setUnitPick(cb) {
    this.unitPick = cb; this.capture = !!cb; this.el.classList.toggle('mode-crosshair', !!cb);
    if (!cb && this._hov) { this._hov.classList.remove('ov-unit-hover'); this._hov = null; }
  }
  /** Highlight shapes: map of shapeId → class */
  markUnits(map) {
    if (!this.floorSvg) return;
    this.floorSvg.querySelectorAll('.ov-unit-linked,.ov-unit-taken').forEach(n => n.classList.remove('ov-unit-linked', 'ov-unit-taken'));
    for (const id in map) { const n = this.floorSvg.getElementById ? this.floorSvg.querySelector('#' + CSS.escape(id)) : null; if (n) n.classList.add(map[id]); }
  }
  hasShape(id) { return !!(this.floorSvg && id && this.floorSvg.querySelector('#' + CSS.escape(id))); }
}

// ---------- overlay helpers ----------
export function pinPath(x, y, r) {
  // teardrop pin with tip at (x,y)
  const cy = y - r * 2.1;
  return `M${x},${y} C${x - r * .35},${y - r * .9} ${x - r},${cy + r * .7} ${x - r},${cy} A${r},${r} 0 1 1 ${x + r},${cy} C${x + r},${cy + r * .7} ${x + r * .35},${y - r * .9} ${x},${y}Z`;
}
export function facingWedge(x, y, deg, len, spread = 28) {
  const a1 = (deg - spread - 90) * Math.PI / 180, a2 = (deg + spread - 90) * Math.PI / 180;
  return `M${x},${y} L${x + Math.cos(a1) * len},${y + Math.sin(a1) * len} A${len},${len} 0 0 1 ${x + Math.cos(a2) * len},${y + Math.sin(a2) * len}Z`;
}
/** nearest projection of p onto walk edges: returns {edge, x, y, d, t} */
export function nearestOnEdges(p, edges, nodeById) {
  let best = null;
  for (const e of edges) {
    const a = nodeById[e.a], b = nodeById[e.b]; if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy || 1;
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L; t = Math.max(0, Math.min(1, t));
    const x = a.x + t * dx, y = a.y + t * dy, d = Math.hypot(p.x - x, p.y - y);
    if (!best || d < best.d) best = { edge: e, x, y, d, t };
  }
  return best;
}
export function nearestNode(p, nodes, exclude) {
  let best = null;
  for (const n of nodes) { if (exclude && exclude.has(n.id)) continue; const d = Math.hypot(n.x - p.x, n.y - p.y); if (!best || d < best.d) best = { node: n, d }; }
  return best;
}
export const CAT_FALLBACK = '#857B70';
