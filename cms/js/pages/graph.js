// Graph editor — §2.5 / §7.4 (desktop ≥ 1280 px). Tools: V select/move · N node (click edge = split) · C connect (Shift = chain)
// · X delete · M merge · K mark connector stop · T attach tenant/kiosk/POI · R route test. Undo/redo as local snapshots,
// save = one transactional POST /graph/ops batch (autosave 30 s). Local mini-validation: orphan nodes, islands, cross-floor.
import { h, ic, btn, badge, field, input, select, toggle, toast, dialog, confirmDlg, clear, svgEl, segmented, fmtNum, relTime, dirtyTracker } from '../ui.js';
import { api, lookups, invalidate } from '../api.js';
import { can, floorName, BANK_TYPE } from '../state.js';
import { MapCanvas, nearestOnEdges } from '../mapcanvas.js';
import { closureDialog, endClosure } from '../widgets.js';

const TOOLS = [
  { k: 'V', id: 'select', icon: 'mouse-pointer-2', label: 'Pilih / geser', hint: 'Klik node/edge untuk memilih · seret node untuk menggeser · seret area kosong untuk box-select · Spasi+seret = geser peta' },
  { k: 'N', id: 'node', icon: 'circle-dot', label: 'Tambah node', hint: 'Klik area kosong = node baru · klik pada edge = pecah edge' },
  { k: 'C', id: 'connect', icon: 'spline', label: 'Sambung', hint: 'Klik node A lalu node B · tahan Shift untuk rantai' },
  { k: 'X', id: 'delete', icon: 'trash-2', label: 'Hapus', hint: 'Klik node/edge untuk menghapus (atau pilih lalu tekan Delete)' },
  { k: 'M', id: 'merge', icon: 'merge', label: 'Gabung node', hint: 'Klik node yang dipertahankan, lalu node yang digabungkan' },
  { k: 'K', id: 'stop', icon: 'arrow-up-down', label: 'Tandai stop konektor', hint: 'Klik node → pilih bank eskalator/lift' },
  { k: 'T', id: 'attach', icon: 'link', label: 'Lampirkan', hint: 'Klik tenant/kiosk/fasilitas, lalu klik node pintu masuknya' },
  { k: 'R', id: 'route', icon: 'route', label: 'Uji rute', hint: 'Klik node asal lalu node tujuan' },
];
const STOP_COLOR = { escalator: '#2F5BEA', lift: '#1D1A17', stairs: '#B4531B', bridge: '#B8893B', travelator: '#0B8A8A' };

export default async function graphPage(ctx) {
  ctx.setTitle('Editor graph');
  const canEdit = can('graph.edit');
  const [floors, schedules, cats] = await Promise.all([lookups.floors(), lookups.schedules().catch(() => []), lookups.categories()]);
  const flBy = Object.fromEntries(floors.map(f => [f.id, f])); const catBy = Object.fromEntries(cats.map(c => [c.id, c]));
  const schedBy = Object.fromEntries(schedules.map(s => [s.id, s]));
  let floorId = ctx.query.get('floor') || 'gf';
  let G = null;            // {revision, floor, nodes: Map, edges: Map, att}
  let ops = [], undo = [], redo = [], seq = 1, tool = 'select', sel = { nodes: new Set(), edges: new Set() }, pendingA = null, attachSrc = null;
  let routeRes = null, lastSaved = null, accessibleRoute = false;

  // ---------- layout ----------
  const toolsEl = h('div.ge-tools', { role: 'toolbar', 'aria-label': 'Alat editor graph' });
  const titleEl = h('span.title'); const statusEl = h('span.small.muted'); const opsEl = h('span');
  const saveBtn = btn('Simpan', { icon: 'save', kind: 'primary', size: 'sm', disabled: true, onClick: () => save(), kbd: 'Ctrl S' });
  const undoBtn = btn('', { icon: 'undo-2', size: 'sm', title: 'Undo (Ctrl+Z)', disabled: true, onClick: doUndo });
  const redoBtn = btn('', { icon: 'redo-2', size: 'sm', title: 'Redo (Ctrl+Shift+Z)', disabled: true, onClick: doRedo });
  const auto = h('input', { type: 'checkbox', checked: true });
  const bar = h('div.ge-bar', titleEl, statusEl, h('span.grow'), opsEl, h('label.check.small', auto, 'Autosave 30 dtk'), undoBtn, redoBtn, saveBtn);
  const mapWrap = h('div.ge-map');
  const side = h('aside.ge-side');
  const narrow = h('div.callout.warn', { style: { margin: '16px' }, hidden: true }, ic('monitor'), 'Editor graph butuh layar ≥ 1280 px. Gunakan PC.');
  ctx.root.append(h('div.ge', toolsEl, h('div.ge-stage', bar, narrow, mapWrap), side));
  TOOLS.forEach((t, i) => { toolsEl.append(h('button', { type: 'button', title: `${t.label} (${t.k})`, 'aria-label': t.label, dataset: { t: t.id }, disabled: !canEdit && !['select', 'route'].includes(t.id), onclick: () => setTool(t.id) }, ic(t.icon), h('kbd', t.k))); if (i === 4) toolsEl.append(h('hr')); });
  toolsEl.append(h('hr'), h('button', { type: 'button', title: 'Pas layar (0)', onclick: () => mc.fit() }, ic('maximize')));

  const mc = new MapCanvas(mapWrap, { floors, floorId, height: '100%', layerToggle: true, leftPan: false, onRender: draw, coords: true, layers: { labels: false } });
  mc.capture = true;
  ctx.onLeave(() => { mc.destroy(); clearInterval(autoTimer); document.removeEventListener('keydown', onKey); });
  mc.on('floor', async (f, user) => {
    if (user && ops.length) {
      const v = await dialog({ title: 'Perubahan belum disimpan', body: h('p', `${ops.length} operasi di ${floorName(flBy[floorId])} belum disimpan.`), actions: [{ label: 'Batal', value: null }, { label: 'Buang', kind: 'danger', value: 'drop' }, { label: 'Simpan dulu', kind: 'primary', value: 'save' }] });
      if (!v) { mc.setFloor(floorId); return; }
      if (v === 'save' && !(await save())) { mc.setFloor(floorId); return; }
    }
    floorId = f.id; history.replaceState(null, '', '#/graph?floor=' + f.id); await load();
  });

  // ---------- data ----------
  async function load() {
    const d = (await api.get('/graph', { floor: floorId })).data;
    G = { revision: d.revision, floor: d.floor, nodes: new Map(d.nodes.map(n => [n.id, Object.assign({}, n)])), edges: new Map(d.edges.map(e => [e.id, Object.assign({}, e)])), att: d.attachments };
    ops = []; undo = []; redo = []; sel = { nodes: new Set(), edges: new Set() }; pendingA = null; attachSrc = null; routeRes = null;
    const closures = await api.get('/closures', { active: 1 }, { silent: true }).then(r => r.data).catch(() => []);
    G.edgeClosures = closures.filter(c => c.target.type === 'edge');
    titleEl.textContent = floorName(flBy[floorId]);
    refreshUi(); draw(); renderSide();
  }
  const isTmp = id => typeof id === 'string';
  const unitScale = () => (flBy[floorId] && flBy[floorId].unitScale) || 1;
  const edgeLen = e => { const a = G.nodes.get(e.a), b = G.nodes.get(e.b); return a && b ? Math.hypot(a.x - b.x, a.y - b.y) * unitScale() : 0; };
  const findEdge = (a, b) => [...G.edges.values()].find(e => (e.a === a && e.b === b) || (e.a === b && e.b === a));
  const stopNodes = () => new Map(G.att.stops.map(s => [s.nodeId, s]));
  const attOf = id => [...G.att.tenants.filter(t => t.nodeId === id).map(t => ({ type: 'tenant', id: t.id, label: t.name })), ...G.att.kiosks.filter(k => k.nodeId === id).map(k => ({ type: 'kiosk', id: k.id, label: k.name || k.id })),
    ...G.att.amenities.filter(a => a.nodeId === id).map(a => ({ type: 'amenity', id: a.id, label: a.id })), ...G.att.stops.filter(s => s.nodeId === id).map(s => ({ type: 'stop', id: s.publicId, label: s.publicId }))];

  // ---------- local ops (folding so tmp ids are only used where the spec allows) ----------
  function snapshot() {
    undo.push(JSON.stringify({ nodes: [...G.nodes.values()], edges: [...G.edges.values()], ops, att: G.att, seq }));
    if (undo.length > 200) undo.shift(); redo = [];
  }
  function restore(s) { const o = JSON.parse(s); G.nodes = new Map(o.nodes.map(n => [n.id, n])); G.edges = new Map(o.edges.map(e => [e.id, e])); ops = o.ops; G.att = o.att; seq = o.seq; sel = { nodes: new Set(), edges: new Set() }; }
  function current() { return JSON.stringify({ nodes: [...G.nodes.values()], edges: [...G.edges.values()], ops, att: G.att, seq }); }
  function doUndo() { if (!undo.length) return; redo.push(current()); restore(undo.pop()); changed(); }
  function doRedo() { if (!redo.length) return; undo.push(current()); restore(redo.pop()); changed(); }

  function addNode(x, y) { const id = 't' + seq++; G.nodes.set(id, { id, x: +x.toFixed(2), y: +y.toFixed(2), label: null }); ops.push({ op: 'addNode', tmp: id, floor: floorId, x: +x.toFixed(2), y: +y.toFixed(2) }); return id; }
  function moveNode(id, x, y) {
    const n = G.nodes.get(id); n.x = +x.toFixed(2); n.y = +y.toFixed(2);
    if (isTmp(id)) { const o = ops.find(o => o.op === 'addNode' && o.tmp === id); o.x = n.x; o.y = n.y; }
    else { const o = ops.find(o => o.op === 'moveNode' && o.id === id); if (o) { o.x = n.x; o.y = n.y; } else ops.push({ op: 'moveNode', id, x: n.x, y: n.y }); }
  }
  function addEdge(a, b, props = {}) {
    if (a === b || findEdge(a, b)) return null;
    const id = 'e' + seq++; const e = Object.assign({ id, a, b, enabled: true, costOverride: null, scheduleId: null, label: null }, props);
    G.edges.set(id, e); const op = { op: 'addEdge', tmp: id, a, b }; for (const k of ['enabled', 'costOverride', 'scheduleId', 'label']) if (k in props && props[k] != null && !(k === 'enabled' && props[k] === true)) op[k] = props[k];
    ops.push(op); return id;
  }
  function updateEdge(id, patch) {
    Object.assign(G.edges.get(id), patch);
    if (isTmp(id)) Object.assign(ops.find(o => o.op === 'addEdge' && o.tmp === id), patch);
    else { const o = ops.find(o => o.op === 'updateEdge' && o.id === id); if (o) Object.assign(o, patch); else ops.push(Object.assign({ op: 'updateEdge', id }, patch)); }
  }
  function deleteEdge(id) {
    G.edges.delete(id);
    if (isTmp(id)) ops = ops.filter(o => !(o.op === 'addEdge' && o.tmp === id));
    else { ops = ops.filter(o => !(o.op === 'updateEdge' && o.id === id)); ops.push({ op: 'deleteEdge', id }); }
  }
  function deleteNode(id, force) {
    for (const e of [...G.edges.values()]) if (e.a === id || e.b === id) { G.edges.delete(e.id); if (isTmp(e.id)) ops = ops.filter(o => !(o.op === 'addEdge' && o.tmp === e.id)); }
    G.nodes.delete(id);
    if (isTmp(id)) ops = ops.filter(o => !((o.op === 'addNode' && o.tmp === id) || (o.op === 'attach' && o.node === id)));
    else { ops = ops.filter(o => !(o.op === 'moveNode' && o.id === id)); ops.push(force ? { op: 'deleteNode', id, force: true } : { op: 'deleteNode', id }); }
    for (const k of ['tenants', 'amenities']) G.att[k].forEach(x => { if (x.nodeId === id) x.nodeId = null; });
  }
  function splitEdge(e, x, y) {
    const n = addNode(x, y); const props = { enabled: e.enabled, scheduleId: e.scheduleId, label: e.label };
    const a = e.a, b = e.b; deleteEdge(e.id); addEdge(a, n, props); addEdge(n, b, props); return n;
  }
  function merge(keep, rem) {
    if (isTmp(keep) && !isTmp(rem)) [keep, rem] = [rem, keep];
    for (const e of [...G.edges.values()]) {
      if (e.a !== rem && e.b !== rem) continue;
      const other = e.a === rem ? e.b : e.a;
      if (isTmp(rem)) { deleteEdge(e.id); if (other !== keep) addEdge(keep, other, { enabled: e.enabled, scheduleId: e.scheduleId, label: e.label }); }
      else { G.edges.delete(e.id); if (other !== keep && !findEdge(keep, other)) G.edges.set(e.id, Object.assign(e, { a: keep, b: other })); }
    }
    if (isTmp(rem)) { G.nodes.delete(rem); ops = ops.filter(o => !(o.op === 'addNode' && o.tmp === rem)); ops.forEach(o => { if (o.op === 'attach' && o.node === rem) o.node = keep; }); }
    else { G.nodes.delete(rem); ops.push({ op: 'mergeNodes', keep, remove: rem }); }
    for (const k of ['tenants', 'kiosks', 'amenities']) G.att[k].forEach(x => { if (x.nodeId === rem) x.nodeId = keep; });
  }
  function changed() { refreshUi(); draw(); renderSide(); }
  function refreshUi() {
    const n = ops.length; saveBtn.disabled = !n || !canEdit; undoBtn.disabled = !undo.length; redoBtn.disabled = !redo.length;
    clear(opsEl).append(n ? badge(`${n} perubahan belum disimpan`, 'warn', 'pencil') : badge(lastSaved ? 'Tersimpan ' + relTime(lastSaved) : 'Tidak ada perubahan', 'ok', 'check'));
    statusEl.textContent = G ? `rev ${G.revision} · ${G.nodes.size} node · ${G.edges.size} edge` : '';
  }

  // ---------- save ----------
  let saving = false;
  async function save() {
    if (!ops.length || saving) return true;
    // client-side guard: edges must stay within the floor (all local nodes are this floor) — and nodes w/o edges warning
    saving = true;
    try {
      const r = await api.post('/graph/ops', { revision: G.revision, ops });
      lastSaved = new Date().toISOString(); toast(`Graph disimpan (${ops.length} operasi) — revisi ${r.data.revision}`);
      ctx.refreshStatus(); invalidate('tenants-lite');
      await load(); return true;
    } catch (e) {
      if (e.code === 'conflict' && e.details && e.details.refs) {
        const refs = e.details.refs.map(r => `${r.type} ${r.id}`).join(', ');
        toast(`Node masih dipakai: ${refs}. Lepaskan dulu (stop dihapus lewat halaman Konektor).`, 'err', 8000);
      } else if (e.code === 'conflict') {
        await dialog({ title: 'Graph diubah orang lain', body: h('p', 'Revisi graph di server sudah berubah. Perubahan Anda dibatalkan dan graph dimuat ulang.'), actions: [{ label: 'Muat ulang', kind: 'primary', value: true }] });
        await load();
      } else if (e.code === 'validation') toast(e.message, 'err');
      return false;
    } finally { saving = false; }
  }
  const autoTimer = setInterval(() => { if (auto.checked && ops.length && canEdit && !dragging) save(); }, 30000);

  // ---------- drawing ----------
  function islands() {
    const adj = new Map(); for (const n of G.nodes.keys()) adj.set(n, []);
    for (const e of G.edges.values()) if (e.enabled) { adj.get(e.a)?.push(e.b); adj.get(e.b)?.push(e.a); }
    const anchors = new Set([...G.att.stops.map(s => s.nodeId), ...G.att.kiosks.map(k => k.nodeId)]);
    const seen = new Set(), bad = new Set();
    for (const n of G.nodes.keys()) {
      if (seen.has(n)) continue; const comp = [n]; seen.add(n);
      for (let i = 0; i < comp.length; i++) for (const m of adj.get(comp[i]) || []) if (!seen.has(m)) { seen.add(m); comp.push(m); }
      if (!comp.some(c => anchors.has(c)) && comp.length > 1) comp.forEach(c => bad.add(c));
    }
    return bad;
  }
  function draw() {
    if (!G || !mc.floor || mc.floor.id !== floorId) return;
    const lg = mc.layer('graph'), lc = mc.layer('connectors'), lt = mc.layer('tenants'), lk = mc.layer('kiosks'), lp = mc.layer('pois'), ll = mc.layer('labels'), top = mc.layer('top');
    const deg = new Map(); for (const e of G.edges.values()) { deg.set(e.a, (deg.get(e.a) || 0) + 1); deg.set(e.b, (deg.get(e.b) || 0) + 1); }
    const isl = islands(); const stops = stopNodes();
    const closedEdges = new Set(G.edgeClosures.map(c => +c.target.id));
    for (const e of G.edges.values()) {
      const a = G.nodes.get(e.a), b = G.nodes.get(e.b); if (!a || !b) continue;
      const cls = 'ov-edge' + (!e.enabled || closedEdges.has(e.id) ? ' off' : e.scheduleId ? ' sched' : '') + (sel.edges.has(e.id) ? ' sel' : '') + (isTmp(e.id) ? ' new' : '');
      lg.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: cls }), svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'ov-edge-hit', 'data-hit': 1, 'data-edge': e.id }));
    }
    const r = mc.px(4.6);
    for (const n of G.nodes.values()) {
      const d = deg.get(n.id) || 0;
      const cls = 'ov-node' + (sel.nodes.has(n.id) ? ' sel' : d === 0 && !stops.has(n.id) ? ' orphan' : isl.has(n.id) ? ' island' : '') + (isTmp(n.id) ? ' new' : '') + (pendingA === n.id ? ' hl' : '');
      lg.append(svgEl('circle', { cx: n.x, cy: n.y, r: sel.nodes.has(n.id) || pendingA === n.id ? r * 1.35 : r, class: cls, 'data-hit': 1, 'data-node': n.id }));
      if (n.label && !String(n.label).startsWith('spur:')) ll.append(svgEl('text', { x: n.x + mc.px(7), y: n.y - mc.px(6), 'font-size': mc.px(11), class: 'ov-label', text: n.label }));
    }
    // connector stops
    for (const s of G.att.stops) {
      const n = G.nodes.get(s.nodeId); const x = n ? n.x : s.x, y = n ? n.y : s.y; const R = mc.px(11);
      const col = STOP_COLOR[s.type] || '#1D1A17'; const live = s.legs.some(l => l.enabled);
      const g = svgEl('g', { 'data-hit': 1, 'data-stop': s.id, style: 'cursor:pointer' });
      g.append(svgEl('circle', { cx: x, cy: y, r: R, fill: live ? col : '#fff', stroke: live ? '#fff' : col, 'stroke-width': 2.5, 'stroke-dasharray': live ? null : '3 2', class: 'ov-stop' }));
      const code = s.legs.map(l => l.direction === 'up' ? '↑' : l.direction === 'down' ? '↓' : '↕').join('') || '∅';
      g.append(svgEl('text', { x, y: y + mc.px(.5), 'font-size': mc.px(s.legs.length > 1 ? 9 : 11), class: 'ov-stop-t', fill: live ? '#fff' : col, text: code }));
      g.append(svgEl('title', { text: `${s.publicId} — ${s.legs.map(l => `L${l.id} → ${floorName(flBy[l.toFloor])} ${l.direction}${l.enabled ? '' : ' (nonaktif)'}`).join(', ') || 'tanpa leg aktif'}` }));
      lc.append(g);
      ll.append(svgEl('text', { x: x + R + mc.px(3), y: y + mc.px(4), 'font-size': mc.px(10.5), class: 'ov-label', text: s.publicId }));
    }
    // attachments
    const showLinks = tool === 'attach' || sel.nodes.size;
    const att = (list, layer, color, r0, kind) => list.forEach(o => {
      if (o.x == null) return;
      const n = o.nodeId != null && G.nodes.get(o.nodeId);
      if (n && (showLinks || attachSrc && attachSrc.id === o.id)) layer.append(svgEl('line', { x1: o.x, y1: o.y, x2: n.x, y2: n.y, class: 'ov-link' }));
      const c = svgEl('circle', { cx: o.x, cy: o.y, r: mc.px(r0), fill: typeof color === 'function' ? color(o) : color, class: kind === 'kiosk' ? 'ov-kiosk' : 'ov-tenant' + (attachSrc && attachSrc.id === o.id ? ' sel' : ''), 'data-hit': 1, 'data-att': kind + ':' + o.id, style: tool === 'attach' ? 'cursor:pointer' : 'pointer-events:' + (tool === 'attach' ? 'auto' : 'none') });
      c.append(svgEl('title', { text: (o.name || o.id) + (o.nodeId ? ' → n' + o.nodeId : ' (tanpa node)') }));
      layer.append(c);
      if (mc.layersOn.labels && kind === 'tenant') ll.append(svgEl('text', { x: o.x + mc.px(6), y: o.y + mc.px(3.5), 'font-size': mc.px(10), class: 'ov-label', text: o.name }));
    });
    att(G.att.tenants, lt, o => (catBy[o.categoryId] || {}).color || '#857B70', 4.2, 'tenant');
    att(G.att.amenities, lp, '#0B8A8A', 5, 'amenity');
    att(G.att.kiosks, lk, '#2F5BEA', 7, 'kiosk');
    // route result
    if (routeRes && routeRes.ok) {
      const pts = routeRes.path.filter(p => p.floor === floorId);
      // split into contiguous runs on this floor
      let run = [];
      const flush = () => { if (run.length > 1) top.append(svgEl('polyline', { points: run.map(p => `${p.x},${p.y}`).join(' '), class: 'ov-route' })); run = []; };
      routeRes.path.forEach(p => { if (p.floor === floorId) run.push(p); else flush(); }); flush();
      pts.forEach((p, i) => { if (i === 0 || i === pts.length - 1) top.append(svgEl('circle', { cx: p.x, cy: p.y, r: mc.px(6), class: 'ov-snap' })); });
    }
    if (box) top.append(svgEl('rect', { x: Math.min(box.x0, box.x1), y: Math.min(box.y0, box.y1), width: Math.abs(box.x1 - box.x0), height: Math.abs(box.y1 - box.y0), class: 'ov-box' }));
    if (ghost) top.append(svgEl('line', Object.assign({ class: 'ov-ghost' }, ghost)));
  }

  // ---------- interaction ----------
  let dragging = null, box = null, ghost = null;
  const nodeAt = e => { const t = e.target.closest('[data-node]'); if (t) { const v = t.dataset.node; return /^\d+$/.test(v) ? +v : v; } return null; };
  const edgeAt = e => { const t = e.target.closest('[data-edge]'); if (t) { const v = t.dataset.edge; return /^\d+$/.test(v) ? +v : v; } return null; };
  const snapNode = p => { let best = null; const lim = mc.px(6); for (const n of G.nodes.values()) { const d = Math.hypot(n.x - p.x, n.y - p.y); if (d <= lim && (!best || d < best.d)) best = { id: n.id, d }; } return best && best.id; };

  mc.svg.addEventListener('pointerdown', e => {
    if (e.button !== 0 || mc.el.classList.contains('space') || !G) return;
    const p = mc.toSvg(e); const nid = nodeAt(e) ?? snapNode(p); const eid = nid == null ? edgeAt(e) : null;
    if (tool === 'select') {
      if (nid != null && canEdit) {
        if (!sel.nodes.has(nid)) { if (!e.shiftKey) sel = { nodes: new Set(), edges: new Set() }; sel.nodes.add(nid); }
        dragging = { start: p, orig: new Map([...sel.nodes].map(id => [id, { x: G.nodes.get(id).x, y: G.nodes.get(id).y }])), moved: false, snap: current() };
        mc.svg.setPointerCapture(e.pointerId); renderSide(); draw(); e.preventDefault();
      } else if (nid != null) { sel = { nodes: new Set([nid]), edges: new Set() }; renderSide(); draw(); }
      else if (eid != null) { if (!e.shiftKey) sel = { nodes: new Set(), edges: new Set() }; sel.edges.add(eid); renderSide(); draw(); }
      else { box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, add: e.shiftKey }; mc.svg.setPointerCapture(e.pointerId); }
    }
  });
  mc.svg.addEventListener('pointermove', e => {
    if (!G) return;
    const p = mc.toSvg(e);
    if (dragging) {
      const dx = p.x - dragging.start.x, dy = p.y - dragging.start.y;
      if (!dragging.moved && Math.hypot(dx, dy) < mc.px(3)) return;
      dragging.moved = true;
      for (const [id, o] of dragging.orig) { const n = G.nodes.get(id); n.x = o.x + dx; n.y = o.y + dy; }
      draw(); return;
    }
    if (box) { box.x1 = p.x; box.y1 = p.y; draw(); return; }
    if ((tool === 'connect' || tool === 'merge' || tool === 'route') && pendingA != null) { const a = G.nodes.get(pendingA); if (a) { ghost = { x1: a.x, y1: a.y, x2: p.x, y2: p.y }; draw(); } }
    else if (tool === 'attach' && attachSrc) { ghost = { x1: attachSrc.x, y1: attachSrc.y, x2: p.x, y2: p.y }; draw(); }
  });
  mc.svg.addEventListener('pointerup', e => {
    if (dragging) {
      if (dragging.moved) {
        undo.push(dragging.snap); redo = [];
        for (const id of dragging.orig.keys()) { const n = G.nodes.get(id); moveNode(id, n.x, n.y); }
        changed();
      }
      dragging = null; return;
    }
    if (box) {
      const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1), y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
      if (x1 - x0 > mc.px(4) || y1 - y0 > mc.px(4)) {
        if (!box.add) sel = { nodes: new Set(), edges: new Set() };
        for (const n of G.nodes.values()) if (n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1) sel.nodes.add(n.id);
      } else sel = { nodes: new Set(), edges: new Set() };
      box = null; renderSide(); draw();
    }
  });
  mc.svg.addEventListener('click', async e => {
    if (!G || e.button !== 0 || tool === 'select' || mc.el.classList.contains('space')) return;
    const p = mc.toSvg(e); const nid = nodeAt(e) ?? snapNode(p); const eid = nid == null ? edgeAt(e) : null;
    const attEl = e.target.closest('[data-att]');
    if (tool === 'node' && canEdit) {
      snapshot();
      if (nid != null) { toast('Sudah ada node di sini', 'warn'); undo.pop(); return; }
      if (eid != null) { const ed = G.edges.get(eid); const a = G.nodes.get(ed.a), b = G.nodes.get(ed.b); const pr = nearestOnEdges(p, [ed], { [ed.a]: a, [ed.b]: b }); const n = splitEdge(ed, pr.x, pr.y); sel = { nodes: new Set([n]), edges: new Set() }; }
      else { const n = addNode(p.x, p.y); sel = { nodes: new Set([n]), edges: new Set() }; }
      changed();
    } else if (tool === 'connect' && canEdit) {
      if (nid == null) { pendingA = null; ghost = null; draw(); return; }
      if (pendingA == null) { pendingA = nid; draw(); return; }
      if (nid === pendingA) return;
      snapshot(); const id = addEdge(pendingA, nid);
      if (!id) { undo.pop(); toast('Edge sudah ada', 'warn'); }
      pendingA = e.shiftKey ? nid : null; ghost = null; changed();
    } else if (tool === 'delete' && canEdit) {
      if (nid != null) await delNodes([nid]); else if (eid != null) { snapshot(); deleteEdge(eid); sel.edges.delete(eid); changed(); }
    } else if (tool === 'merge' && canEdit) {
      if (nid == null) { pendingA = null; ghost = null; draw(); return; }
      if (pendingA == null) { pendingA = nid; draw(); return; }
      if (nid === pendingA) return;
      if (stopNodes().has(nid) && stopNodes().has(pendingA)) { toast('Dua stop konektor tidak bisa digabung', 'err'); return; }
      snapshot(); merge(pendingA, nid); pendingA = null; ghost = null; changed();
    } else if (tool === 'stop' && canEdit) {
      if (nid == null) return;
      if (isTmp(nid) || ops.length) { if (!(await confirmDlg('Simpan perubahan graph dulu sebelum menandai stop?', { ok: 'Simpan & lanjut' }))) return; if (!(await save())) return; }
      markStop(typeof nid === 'number' ? nid : null);
    } else if (tool === 'attach' && canEdit) {
      if (attEl) { const [kind, id] = attEl.dataset.att.split(':'); const list = kind === 'tenant' ? G.att.tenants : kind === 'kiosk' ? G.att.kiosks : G.att.amenities; attachSrc = Object.assign({ kind }, list.find(x => x.id === id)); draw(); renderSide(); return; }
      if (attachSrc && nid != null) {
        if (stopNodes().has(nid) && attachSrc.kind === 'amenity') { toast('Node POI tidak boleh sama dengan node stop konektor (W_POI_NODE)', 'warn'); return; }
        snapshot(); ops.push({ op: 'attach', entity: attachSrc.kind, id: attachSrc.id, node: nid });
        const list = attachSrc.kind === 'tenant' ? G.att.tenants : attachSrc.kind === 'kiosk' ? G.att.kiosks : G.att.amenities; list.find(x => x.id === attachSrc.id).nodeId = nid;
        toast(`${attachSrc.name || attachSrc.id} → node ${isTmp(nid) ? 'baru' : 'n' + nid}`); attachSrc = null; ghost = null; changed();
      }
    } else if (tool === 'route') {
      if (nid == null || isTmp(nid)) { if (nid != null) toast('Simpan dulu node baru sebelum uji rute', 'warn'); return; }
      if (pendingA == null) { pendingA = nid; routeRes = null; draw(); renderSide(); return; }
      const from = pendingA; pendingA = null; ghost = null;
      try { routeRes = Object.assign({ from, to: nid }, (await api.post('/validate/route', { from, to: nid, accessible: accessibleRoute, now: true })).data); }
      catch (err) { routeRes = null; }
      draw(); renderSide();
    }
  });

  async function delNodes(ids) {
    const stops = stopNodes();
    if (ids.some(id => stops.has(id))) { toast('Node stop konektor tidak bisa dihapus di sini — hapus stop lewat halaman Eskalator & lift.', 'err', 6000); return; }
    const refs = ids.flatMap(id => attOf(id));
    if (refs.some(r => r.type === 'kiosk')) { toast('Node dipakai kiosk — pindahkan kiosk dulu.', 'err'); return; }
    let force = false;
    if (refs.length) { if (!(await confirmDlg(h('div', h('p', 'Node dipakai oleh:'), h('ul', refs.map(r => h('li', `${r.type} · ${r.label}`))), h('p', 'Hapus dan lepaskan referensinya (tenant/fasilitas jadi "belum ditempatkan")?')), { danger: true, ok: 'Hapus & lepaskan' }))) return; force = true; }
    snapshot(); ids.forEach(id => { deleteNode(id, force); sel.nodes.delete(id); }); changed();
  }
  async function markStop(nodeId) {
    const banks = await lookups.connectors();
    const fl = flBy[floorId];
    const opts = banks.filter(b => b.building === 'both' || fl.building === 'both' || b.building === fl.building);
    const sb = select(opts.map(b => [b.id, `${b.nameId} (${BANK_TYPE[b.type]})`]), opts[0] && opts[0].id);
    const v = await dialog({ title: 'Tandai stop konektor', body: h('div.stack', h('p', `Node n${nodeId} di ${floorName(fl)} menjadi titik naik/turun bank:`), sb, h('p.small.muted', 'Leg (ruas antar lantai) diatur di halaman Eskalator & lift.')), actions: [{ label: 'Batal', value: null }, { label: 'Tandai', kind: 'primary', value: () => sb.value }] });
    if (!v) return;
    await api.post(`/connectors/${v}/stops`, { floorId, nodeId }); invalidate('connectors'); toast('Stop ditambahkan'); ctx.refreshStatus(); await load();
  }

  function setTool(t) {
    tool = t; pendingA = null; attachSrc = null; ghost = null;
    [...toolsEl.querySelectorAll('[data-t]')].forEach(b => b.classList.toggle('on', b.dataset.t === t));
    const T = TOOLS.find(x => x.id === t); mc.hint(T.hint + (t === 'select' ? '' : ' · Esc = batal'));
    mc.setCursor(t === 'select' ? null : 'crosshair'); draw(); renderSide();
  }
  function onKey(e) {
    if (e.target.closest('input,textarea,select,dialog')) return;
    const k = e.key.toUpperCase();
    if ((e.ctrlKey || e.metaKey) && k === 'Z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'Y') { e.preventDefault(); doRedo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'S') { e.preventDefault(); e.stopImmediatePropagation(); save(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const T = TOOLS.find(x => x.k === k); if (T && (canEdit || ['select', 'route'].includes(T.id))) { setTool(T.id); return; }
    if (e.key === 'Escape') { pendingA = null; attachSrc = null; ghost = null; sel = { nodes: new Set(), edges: new Set() }; draw(); renderSide(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && canEdit) {
      if (sel.nodes.size) delNodes([...sel.nodes]);
      else if (sel.edges.size) { snapshot(); [...sel.edges].forEach(id => deleteEdge(id)); sel.edges.clear(); changed(); }
    }
  }
  document.addEventListener('keydown', onKey, true);

  // ---------- side panel ----------
  function renderSide() {
    clear(side);
    if (!G) return;
    if (tool === 'route') {
      const acc = toggle(accessibleRoute, 'Mode kursi roda (tanpa eskalator/tangga)', { onchange: e => { accessibleRoute = e.target.checked; } });
      side.append(h('h4', ic('route'), 'Uji rute'), acc, h('p.small.muted', pendingA != null ? `Asal: n${pendingA}. Klik node tujuan (bisa pindah lantai dulu).` : 'Klik node asal di peta.'));
      if (routeRes) {
        if (!routeRes.ok) side.append(h('div.callout.danger', ic('circle-x'), h('div', h('b', 'Tidak ada rute. '), routeRes.reason === 'closed' ? 'Jalur tertutup (closure/jadwal).' : 'Graph terputus untuk mode ini.')));
        else {
          const seqF = []; routeRes.path.forEach(p => { if (seqF[seqF.length - 1] !== p.floor) seqF.push(p.floor); });
          side.append(h('div.callout.ok', ic('circle-check'), h('div', h('b', `Biaya ${routeRes.cost}`), ` · ${routeRes.path.length} node · ${seqF.length} lantai`)),
            h('ol', { style: { margin: 0, paddingLeft: '18px', display: 'grid', gap: '4px' } }, seqF.map(f => h('li', h('a', { href: '#', onclick: ev => { ev.preventDefault(); mc.setFloor(f, true); } }, floorName(flBy[f])), f === floorId ? ' (sedang dilihat)' : ''))));
        }
      }
      legend(); return;
    }
    if (tool === 'attach') {
      side.append(h('h4', ic('link'), 'Lampirkan ke node'), h('p.small', attachSrc ? h('span', h('b', attachSrc.name || attachSrc.id), ` (${attachSrc.kind}) — klik node pintu masuknya.`) : 'Klik pin tenant/kiosk/fasilitas di peta.'));
    }
    if (sel.nodes.size === 1) {
      const id = [...sel.nodes][0]; const n = G.nodes.get(id); if (!n) return;
      const refs = attOf(id); const deg = [...G.edges.values()].filter(e => e.a === id || e.b === id).length;
      const xIn = input({ type: 'number', step: '0.1', value: n.x, sm: true, disabled: !canEdit }), yIn = input({ type: 'number', step: '0.1', value: n.y, sm: true, disabled: !canEdit });
      const upd = () => { snapshot(); moveNode(id, +xIn.value, +yIn.value); changed(); };
      xIn.addEventListener('change', upd); yIn.addEventListener('change', upd);
      const lblIn = input({ value: n.label || '', sm: true, disabled: !canEdit, placeholder: 'opsional, mis. "Pintu lobi"' });
      lblIn.addEventListener('change', () => { snapshot(); n.label = lblIn.value || null; if (isTmp(id)) ops.find(o => o.op === 'addNode' && o.tmp === id).label = n.label; else { const o = ops.find(o => o.op === 'updateNode' && o.id === id); if (o) o.label = n.label; else ops.push({ op: 'updateNode', id, label: n.label }); } changed(); });
      side.append(h('h4', ic('circle-dot'), isTmp(id) ? 'Node baru (belum disimpan)' : `Node n${id}`),
        h('div.form.cols-2', field('x', xIn), field('y', yIn), field('Label', lblIn, { span: 'span-2' })),
        h('dl.kv', { style: { gridTemplateColumns: '90px 1fr' } }, h('dt', 'Derajat'), h('dd', deg ? deg + ' edge' : h('b', { style: { color: 'var(--danger)' } }, '0 — node yatim')),
          h('dt', 'Lampiran'), h('dd', refs.length ? h('div.stack', { style: { gap: '4px' } }, refs.map(r => h('div', badge(r.type), ' ', r.type === 'tenant' ? h('a', { href: '#/tenants/' + r.id }, r.label) : r.type === 'stop' ? h('a', { href: '#/connectors' }, r.label) : r.label))) : '—')),
        canEdit ? h('div.row.wrap', btn('Hapus node', { icon: 'trash-2', size: 'sm', kind: 'danger', onClick: () => delNodes([id]) })) : null);
    } else if (sel.nodes.size > 1) {
      side.append(h('h4', ic('circle-dot'), `${sel.nodes.size} node dipilih`), h('p.small.muted', 'Seret salah satu untuk menggeser semuanya.'), canEdit ? btn('Hapus semua', { icon: 'trash-2', size: 'sm', kind: 'danger', onClick: () => delNodes([...sel.nodes]) }) : null);
    } else if (sel.edges.size === 1) {
      const id = [...sel.edges][0]; const e = G.edges.get(id); if (!e) return;
      const len = edgeLen(e); const cl = G.edgeClosures.filter(c => +c.target.id === id);
      const en = toggle(e.enabled, 'Edge aktif', { disabled: !canEdit, onchange: ev => { snapshot(); updateEdge(id, { enabled: ev.target.checked }); changed(); } });
      const co = input({ type: 'number', step: '0.01', value: e.costOverride ?? '', placeholder: len.toFixed(2), sm: true, disabled: !canEdit });
      co.addEventListener('change', () => { snapshot(); updateEdge(id, { costOverride: co.value === '' ? null : +co.value }); changed(); });
      const sc = select([['', 'Selalu buka'], ...schedules.map(s => [s.id, s.name])], e.scheduleId ?? '', { sm: true, disabled: !canEdit });
      sc.addEventListener('change', () => { snapshot(); updateEdge(id, { scheduleId: sc.value ? +sc.value : null }); changed(); });
      const lb = input({ value: e.label || '', sm: true, disabled: !canEdit, placeholder: 'mis. Akses hotel' });
      lb.addEventListener('change', () => { snapshot(); updateEdge(id, { label: lb.value || null }); changed(); });
      side.append(h('h4', ic('spline'), isTmp(id) ? 'Edge baru' : `Edge E${id}`),
        h('dl.kv', { style: { gridTemplateColumns: '110px 1fr' } }, h('dt', 'Node'), h('dd.mono', `${isTmp(e.a) ? 'baru' : 'n' + e.a} ↔ ${isTmp(e.b) ? 'baru' : 'n' + e.b}`), h('dt', 'Panjang × skala'), h('dd', `${len.toFixed(2)} (skala ${unitScale()})`), h('dt', 'Biaya efektif'), h('dd', h('b', (e.costOverride ?? len).toFixed(2)))),
        en, field('Override biaya', co, { hint: 'Kosong = otomatis panjang × skala.' }), field('Jadwal', sc, { hint: 'Koridor yang tutup malam (mis. akses hotel).' }), field('Label', lb),
        cl.length ? h('div.stack', { style: { gap: '6px' } }, cl.map(c => h('div.closure-pill', ic('wrench'), `${c.reasonId || 'Ditutup'}`, h('button.btn.sm.ghost', { onclick: async () => { await endClosure(c, 'Koridor'); await load(); } }, 'Buka')))) : null,
        !isTmp(id) && can('status.closures') ? btn('Tutup sementara (live)', { icon: 'wrench', size: 'sm', onClick: async () => { const r = await closureDialog({ type: 'edge', id, label: `Koridor E${id} · ${floorName(flBy[floorId])}` }, { dirs: ['both'] }); if (r) load(); } }) : null,
        canEdit ? btn('Hapus edge', { icon: 'trash-2', size: 'sm', kind: 'danger', onClick: () => { snapshot(); deleteEdge(id); sel.edges.clear(); changed(); } }) : null);
    } else if (tool !== 'attach') {
      const isl = islands(); const orphans = [...G.nodes.keys()].filter(id => ![...G.edges.values()].some(e => e.a === id || e.b === id) && !stopNodes().has(id));
      side.append(h('h4', ic('layers'), floorName(flBy[floorId])),
        h('dl.kv', { style: { gridTemplateColumns: '130px 1fr' } }, h('dt', 'Node / edge'), h('dd', `${fmtNum(G.nodes.size)} / ${fmtNum(G.edges.size)}`), h('dt', 'Stop konektor'), h('dd', String(G.att.stops.length)),
          h('dt', 'Tenant terlampir'), h('dd', `${G.att.tenants.filter(t => t.nodeId).length} / ${G.att.tenants.length}`), h('dt', 'Skala unit'), h('dd', String(unitScale()))),
        orphans.length ? h('div.callout.danger', ic('circle-alert'), `${orphans.length} node yatim (tanpa edge).`) : null,
        isl.size ? h('div.callout.warn', ic('triangle-alert'), `${isl.size} node di komponen terpisah — tidak tersambung ke kiosk/konektor di lantai ini.`) : h('div.callout.ok', ic('circle-check'), 'Semua komponen tersambung ke kiosk/konektor.'),
        h('p.small.muted', 'Tips: Box-select dengan menyeret area kosong (V). Ctrl+Z untuk undo. Penghubung antar-lantai diatur di halaman Eskalator & lift, bukan sebagai edge.'));
    }
    legend();
  }
  function legend() {
    const L = (svg, t) => [h('span', { html: svg }), h('span', t)];
    side.append(h('div', h('div.kicker', { style: { margin: '6px 0 8px' } }, 'Legenda'), h('div.legend',
      ...L('<svg viewBox="0 0 22 14"><line x1="1" y1="7" x2="21" y2="7" stroke="#8C8377" stroke-width="2.4"/></svg>', 'Koridor jalan kaki'),
      ...L('<svg viewBox="0 0 22 14"><line x1="1" y1="7" x2="21" y2="7" stroke="#C0392B" stroke-width="2.4" stroke-dasharray="5 4"/></svg>', 'Nonaktif / ditutup'),
      ...L('<svg viewBox="0 0 22 14"><line x1="1" y1="7" x2="21" y2="7" stroke="#E08A1E" stroke-width="2.4"/></svg>', 'Berjadwal'),
      ...L('<svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="6" fill="#2F5BEA"/><text x="11" y="10" font-size="8" fill="#fff" text-anchor="middle" font-weight="800">↕</text></svg>', 'Stop eskalator (↕ ↑ ↓)'),
      ...L('<svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="6" fill="#1D1A17"/></svg>', 'Stop lift · jembatan emas'),
      ...L('<svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="4" fill="#C0392B"/></svg>', 'Node yatim'),
      ...L('<svg viewBox="0 0 22 14"><circle cx="11" cy="7" r="4" fill="#F2C230" stroke="#8E6D00"/></svg>', 'Komponen terputus'))));
  }

  // integrate with global Ctrl+S / unsaved-leave guard
  const reg = dirtyTracker(h('div'), { onSave: save, bar: false });
  Object.defineProperty(reg, 'dirty', { get: () => ops.length > 0 });
  reg.el = mapWrap;

  const ro = new ResizeObserver(() => { narrow.hidden = window.innerWidth >= 1280; });
  ro.observe(document.body); ctx.onLeave(() => ro.disconnect());
  setTool('select');
  await mc.ready;
}
