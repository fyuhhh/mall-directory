// Connector banks — §2.6 / §7.5 "tumpukan lantai": each escalator/lift/bridge bank as a vertical stack of floors with
// per-leg enable toggle, direction (both / up only / down only), schedule, cost override, field note, verified flag,
// live closures; lifts get "stops at this floor" checkboxes + regenerate legs; mini map jumps to a stop / adds stops.
import { h, ic, btn, badge, pageHead, field, input, select, toggle, checkbox, segmented, toast, dialog, confirmDlg, clear, card, svgEl,
  showFieldErrors, readForm, fmtDate, relTime, emptyState, dirtyTracker } from '../ui.js';
import { api, lookups, invalidate } from '../api.js';
import { can, floorName, BUILDING_LABEL, BANK_TYPE, BANK_ICON, DIR_LABEL } from '../state.js';
import { closureDialog, endClosure, closureText } from '../widgets.js';
import { MapCanvas, nearestNode } from '../mapcanvas.js';

const DIR_OPTS = [{ value: 'both', label: 'Dua arah', icon: 'arrow-up-down', title: 'Sepasang unit naik + turun' }, { value: 'up', label: 'Naik saja', icon: 'arrow-up' }, { value: 'down', label: 'Turun saja', icon: 'arrow-down' }];
const isEsc = b => b.type === 'escalator' || b.type === 'travelator';

export default async function connectors(ctx) {
  ctx.setTitle('Eskalator & lift');
  const canEdit = can('connectors.edit'), canClose = can('status.closures');
  invalidate('connectors');
  let [banks, floors, schedules, settings, validation] = await Promise.all([
    lookups.connectors(), lookups.floors(), lookups.schedules().catch(() => []),
    api.get('/settings', null, { silent: true }).then(r => r.data).catch(() => ({})),
    api.get('/validate/last', null, { silent: true }).then(r => r.data).catch(() => null)]);
  const flBy = Object.fromEntries(floors.map(f => [f.id, f]));
  let cur = banks.find(b => b.id === ctx.params.id) || banks[0];
  const dirtyLegs = new Map(); let dirtyBank = null;

  ctx.root.append(pageHead('Eskalator, lift & jembatan', 'Setiap bank = tumpukan lantai. Leg nonaktif tidak diekspor; eskalator satu arah diekspor sebagai satu edge berarah.', [
    h('a.btn', { href: '#/ops' }, ic('wrench'), 'Status Ops (live)'), canEdit ? btn('Bank baru', { icon: 'plus', onClick: newBank }) : null]));
  const listEl = h('div.cn-list');
  const panel = h('div.card');
  const mapCol = h('div.cn-map.sticky.stack');
  ctx.root.append(listEl, h('div.cn', panel, mapCol));

  // ---------- mini map ----------
  const mapHost = h('div', { style: { height: '430px', position: 'relative' } });
  const mapInfo = h('div.small.muted');
  mapCol.append(card(h('div.row', h('h3', 'Peta'), h('span.grow'), h('span#mapmode')), h('div.stack', mapHost, mapInfo)));
  const mc = new MapCanvas(mapHost, { floors, floorId: 'gf', height: '100%', onRender: drawMap });
  ctx.onLeave(() => mc.destroy());
  let mapGraph = null, focusStop = null, addStopFloor = null;
  mc.on('floor', async f => { mapGraph = (await api.get('/graph', { floor: f.id })).data; mapGraph.nodeBy = Object.fromEntries(mapGraph.nodes.map(n => [n.id, n])); drawMap(); });
  mc.on('click', async pt => {
    if (!addStopFloor || !mapGraph) return;
    if (mc.floor.id !== addStopFloor) { toast('Pilih lantai ' + floorName(flBy[addStopFloor]) + ' dulu', 'warn'); return; }
    const nn = nearestNode(pt, mapGraph.nodes, new Set(mapGraph.attachments.stops.map(s => s.nodeId)));
    const useNode = nn && nn.d * mc.scale() <= 10;
    const body = useNode ? { floorId: addStopFloor, nodeId: nn.node.id } : { floorId: addStopFloor, x: +pt.x.toFixed(2), y: +pt.y.toFixed(2) };
    try {
      const r = await api.post(`/connectors/${cur.id}/stops`, body);
      toast(`Stop ${r.data.publicId} ditambahkan${useNode ? ' pada node n' + nn.node.id : ' — node baru disambung ke koridor terdekat'}`);
      setAddStop(null); await reload(); ctx.refreshStatus();
    } catch (e) { }
  });
  function setAddStop(fid) {
    addStopFloor = fid; mc.capture = !!fid; mc.setCursor(fid ? 'crosshair' : null);
    mc.hint(fid ? `Klik titik naik/turun ${cur.nameId} di ${floorName(flBy[fid])} (dekat node = pakai node itu)` : '');
    if (fid) mc.setFloor(fid);
  }
  function drawMap() {
    if (!mapGraph || !mc.floor) return;
    const g = mc.layer('graph'), c = mc.layer('connectors');
    for (const e of mapGraph.edges) { const a = mapGraph.nodeBy[e.a], b = mapGraph.nodeBy[e.b]; if (a && b) g.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'ov-edge', style: 'opacity:.4' })); }
    for (const s of mapGraph.attachments.stops) {
      const mine = cur && s.bankId === cur.id; const foc = focusStop && focusStop.id === s.id;
      const R = mc.px(foc ? 13 : mine ? 10 : 6);
      c.append(svgEl('circle', { cx: s.x, cy: s.y, r: R, fill: mine ? (s.legs.some(l => l.enabled) ? '#2F5BEA' : '#fff') : '#1D1A17', stroke: mine ? '#2F5BEA' : '#fff', 'stroke-width': 2.5, opacity: mine ? 1 : .35, class: 'ov-stop' }, svgEl('title', { text: s.publicId })));
      if (mine) c.append(svgEl('text', { x: s.x + R + mc.px(4), y: s.y + mc.px(4), 'font-size': mc.px(11), class: 'ov-label', text: s.publicId }));
    }
  }
  function jumpTo(stop) {
    focusStop = stop; setAddStop(null);
    mc.setFloor(stop.floorId).then(() => { mc.centerOn(stop.x, stop.y, 300); drawMap(); });
    clear(mapInfo).append(h('b.mono', stop.publicId), ` · ${floorName(flBy[stop.floorId])} · node n${stop.nodeId}`);
  }

  // ---------- bank list ----------
  function renderList() {
    clear(listEl);
    const groups = [['pentacity', 'Pentacity'], ['ewalk', 'E-Walk'], ['both', 'Penghubung gedung']];
    for (const [bk, label] of groups) {
      const TO = { escalator: 0, travelator: 1, stairs: 2, lift: 3, bridge: 4 };
      const items = banks.filter(b => b.building === bk).sort((a, b) => TO[a.type] - TO[b.type] || String(a.code || '').localeCompare(String(b.code || '')) || a.id.localeCompare(b.id)); if (!items.length) continue;
      const grp = h('div.cn-grp', h('div.kicker', label)); const row = h('div.cn-row'); grp.append(row); listEl.append(grp);
      items.forEach(b => {
        const dangling = b.stops.filter(s => !b.legs.some(l => l.isEnabled && (l.lowerStopId === s.id || l.upperStopId === s.id))).length;
        const legsSorted = b.legs.slice().sort((x, y) => (flBy[y.upperFloor]?.level ?? 0) - (flBy[x.upperFloor]?.level ?? 0));
        row.append(h('a', { class: 'bank-item' + (cur && b.id === cur.id ? ' on' : ''), href: '#/connectors/' + b.id, onclick: e => { e.preventDefault(); if (!leaveOk()) return; cur = b; history.replaceState(null, '', '#/connectors/' + b.id); renderList(); renderPanel(); } },
          h('span.b-ic', ic(BANK_ICON[b.type])),
          h('div', { style: { fontWeight: 700, fontSize: '13.5px', whiteSpace: 'nowrap' }, title: `${b.legs.filter(l => l.isEnabled).length} leg aktif${dangling ? ` · ${dangling} stop buntu` : ''}${b.isEnabled ? '' : ' · bank nonaktif'}` }, b.nameId.replace(' · Pentacity', '').replace(' · E-Walk', '')),
          dangling ? h('span', { class: 'dot warn', title: dangling + ' stop buntu (W_STOP_DANGLING)' }) : null,
          h('span.b-legs', { title: 'Leg dari atas ke bawah' }, legsSorted.map(l => h('i', { class: !l.isEnabled || !b.isEnabled ? 'off' : (l.activeClosures || []).length ? 'cl' : '' }))),
        ));
      });
    }
  }
  function leaveOk() { if (!dirtyLegs.size && !dirtyBank) return true; if (confirm('Buang perubahan yang belum disimpan pada bank ini?')) { dirtyLegs.clear(); dirtyBank = null; tracker.set(false); return true; } return false; }

  // ---------- panel ----------
  const tracker = dirtyTracker(h('div'), { onSave: saveAll, label: 'Perubahan leg/bank belum disimpan' });
  tracker.reset = () => { dirtyLegs.clear(); dirtyBank = null; renderPanel(); };
  const markDirty = () => tracker.set(dirtyLegs.size > 0 || !!dirtyBank);

  function rowsFor(b) {
    let fl;
    if (b.type === 'bridge') fl = floors.filter(f => b.stops.some(s => s.floorId === f.id));
    else fl = floors.filter(f => f.building === 'both' || f.building === b.building || (b.building === 'both'));
    return fl.sort((a, c) => c.level - a.level || (a.building === 'pentacity' ? -1 : 1));
  }
  function legsBetween(b, upper, lower) {
    return b.legs.filter(l => l.upperFloor === upper.id && (l.lowerFloor === lower.id || (flBy[l.lowerFloor] && flBy[l.lowerFloor].level < lower.level)));
  }
  function renderPanel() {
    clear(panel);
    if (!cur) { panel.append(emptyState('Belum ada bank konektor')); return; }
    const b = cur; const draftBank = Object.assign({}, b, dirtyBank || {});
    const bankEn = toggle(draftBank.isEnabled, draftBank.isEnabled ? 'Bank aktif' : 'Bank nonaktif', { disabled: !canEdit, onchange: e => { dirtyBank = Object.assign(dirtyBank || {}, { isEnabled: e.target.checked }); markDirty(); renderPanel(); } });
    const bankSch = select([['', 'Jadwal: jam mall'], ...schedules.map(s => [s.id, 'Jadwal: ' + s.name])], draftBank.scheduleId ?? '', { sm: true, disabled: !canEdit, 'aria-label': 'Jadwal bank', style: { width: 'auto' } });
    bankSch.addEventListener('change', () => { dirtyBank = Object.assign(dirtyBank || {}, { scheduleId: bankSch.value ? +bankSch.value : null }); markDirty(); });
    panel.append(h('div.stack-head',
      h('span.t-ic', ic(BANK_ICON[b.type])),
      h('div.grow', h('h2', b.nameId, b.landmarkId ? h('span', { style: { fontWeight: 500, color: 'var(--muted)', fontSize: '15px' } }, `  (${b.landmarkId})`) : null),
        h('div.row.wrap', { style: { gap: '6px', marginTop: '6px' } }, badge(BANK_TYPE[b.type], 'ink'), badge(BUILDING_LABEL[b.building], 'outline'), h('span.mono.small.muted', b.id),
          canEdit ? h('button.btn.sm.ghost', { type: 'button', onclick: editBank }, ic('pencil'), 'Ubah info') : null)),
      h('div.stack', { style: { gap: '8px', alignItems: 'flex-end' } }, bankEn, bankSch,
        canClose ? h('button.btn.sm', { type: 'button', onclick: async () => { const r = await closureDialog({ type: 'bank', id: b.id, label: b.nameId + ' (semua leg)' }, { dirs: isEsc(b) ? ['both', 'up', 'down'] : ['both'], settings }); if (r) reload(); } }, ic('wrench'), 'Tutup semua leg') : null)));

    // summary / notes
    const summ = h('div.stack', { style: { padding: '12px 18px 0', gap: '8px' } });
    if (b.notes) summ.append(h('div.callout.muted', ic('info'), h('div', h('b', 'Catatan: '), b.notes)));
    const rows = rowsFor(b);
    for (const f of rows) {
      if (b.type === 'bridge') break;
      if (!b.stops.some(s => s.floorId === f.id)) {
        const alt = banks.filter(o => o.id !== b.id && o.isEnabled && o.stops.some(s => s.floorId === f.id && o.legs.some(l => l.isEnabled && (l.lowerStopId === s.id || l.upperStopId === s.id))));
        summ.append(h('div', { class: 'callout ' + (alt.length ? 'ok' : 'warn') }, ic(alt.length ? 'circle-check' : 'triangle-alert'),
          h('div', h('b', `Tidak ada leg ke ${f.short}${f.building !== 'both' ? ' ' + BUILDING_LABEL[f.building] : ''}`), alt.length ? ` — lantai ini tetap terjangkau via ${alt.map(o => o.nameId.replace(/ · (Pentacity|E-Walk)$/, '')).join(' & ')}.` : ' — tidak ada konektor lain ke lantai ini!')));
      }
    }
    const vw = validation ? validation.warnings.filter(w => w.ref && w.ref.bankId === b.id) : [];
    vw.forEach(w => summ.append(h('div.callout.warn', ic('triangle-alert'), h('div', h('b.mono', w.code + ' '), w.msg))));
    panel.append(summ);

    // floor stack
    const stack = h('div.fstack');
    rows.forEach((f, i) => {
      const stops = b.stops.filter(s => s.floorId === f.id);
      const served = b.type !== 'lift' || stops.some(s => s.isServed);
      const rowCls = 'fl-row' + (!stops.length ? ' nostop' : !served ? ' notserved' : '');
      const body = h('div.fl-body');
      if (stops.length) stops.forEach(s => {
        const dangling = !b.legs.some(l => l.isEnabled && (l.lowerStopId === s.id || l.upperStopId === s.id));
        body.append(h('button', { type: 'button', class: 'stop-chip' + (dangling ? ' dangling' : '') + (focusStop && focusStop.id === s.id ? ' on' : ''), title: dangling ? 'Stop tanpa leg aktif (W_STOP_DANGLING) — klik untuk lihat di peta' : 'Lihat di peta', onclick: () => { jumpTo(s); renderPanel(); } },
          h('span.dot'), h('span.mono', s.publicId), dangling ? h('span', { style: { color: 'var(--warn)' } }, '· buntu') : null));
        if (b.type === 'lift') body.append(h('label.check.small', { style: { marginLeft: '4px' } }, h('input', { type: 'checkbox', checked: s.isServed, disabled: !canEdit, onchange: e => setServed(s, e.target.checked) }), 'Berhenti di lantai ini'));
        if (canEdit) body.append(h('button.btn.sm.ghost.icon', { type: 'button', title: 'Hapus stop ' + s.publicId, onclick: () => delStop(s) }, ic('x')));
      });
      else body.append(h('span.muted.small', '○ belum ada stop'), b.type === 'lift' ? h('label.check.small', { title: 'Tambahkan stop dulu' }, h('input', { type: 'checkbox', disabled: true }), 'Berhenti di lantai ini') : null);
      if (canEdit) body.append(h('span.grow'), h('button.btn.sm', { type: 'button', onclick: () => setAddStop(f.id) }, ic('plus'), stops.length ? 'Stop' : 'Tambah stop di peta'));
      stack.append(h('div', { class: rowCls }, h('div.fl-badge', h('b', f.short), h('span', f.building === 'both' ? 'gabungan' : BUILDING_LABEL[f.building])), body));
      // gap to next lower row
      const lower = rows[i + 1]; if (!lower) return;
      const legs = legsBetween(b, f, lower);
      stack.append(gapEl(b, f, lower, legs));
    });
    panel.append(stack);
    if (b.type === 'lift' && canEdit) panel.append(h('div.row', { style: { padding: '0 18px 16px' } }, btn('Regenerate legs', { icon: 'refresh-cw', onClick: regen }), h('span.small.muted', 'Membuat ulang leg antar stop yang dilayani (berurutan per level). Leg lift selalu dua arah.')));
    panel.append(tracker.el);
  }

  function gapEl(b, upper, lower, legs) {
    const wrap = h('div.leg-gap');
    const rail = h('div.rail');
    const content = h('div');
    if (!legs.length) {
      rail.classList.add('none'); rail.append(h('span.arw.x', { title: 'Tidak ada leg' }, ic('x')));
      const lowStops = b.stops.filter(s => s.floorId === lower.id), upStops = b.stops.filter(s => s.floorId === upper.id);
      const canMake = canEdit && lowStops.length && upStops.length;
      const note = b.notes && !lowStops.length ? 'lihat catatan bank di atas' : null;
      content.append(h('div.leg-none', h('b', `Tidak ada leg ${lower.short}↔${upper.short}`), note ? h('span', '— ' + note) : h('span', lowStops.length && upStops.length ? '— kedua stop ada, leg belum dibuat' : `— ${!lowStops.length ? 'belum ada stop di ' + lower.short : 'belum ada stop di ' + upper.short}`),
        h('span.grow'), canMake ? btn('Buat leg', { icon: 'plus', size: 'sm', onClick: () => makeLeg(b, lowStops, upStops) }) : null));
    } else {
      const eff = legs.map(l => Object.assign({}, l, dirtyLegs.get(l.id) || {}));
      const anyOn = eff.some(l => l.isEnabled) && b.isEnabled;
      const up = eff.some(l => l.isEnabled && (l.direction === 'both' || l.direction === 'up' || !isEsc(b)));
      const down = eff.some(l => l.isEnabled && (l.direction === 'both' || l.direction === 'down' || !isEsc(b)));
      const clUp = eff.some(l => (l.activeClosures || []).some(c => c.direction !== 'down'));
      const clDown = eff.some(l => (l.activeClosures || []).some(c => c.direction !== 'up'));
      if (!anyOn) rail.classList.add('off');
      else if ((!up || clUp) && (!down || clDown)) rail.classList.add('closed');
      rail.title = anyOn ? eff.map(l => `L${l.id}: ${DIR_LABEL[isEsc(b) ? l.direction : 'both']}`).join(', ') : 'Nonaktif — tidak diekspor';
      if (anyOn && up) rail.append(h('span', { class: 'arw' + (clUp ? ' cl' : ''), title: clUp ? 'Arah naik ditutup sementara' : 'Naik beroperasi' }, ic(clUp ? 'wrench' : 'arrow-up')));
      if (anyOn && down) rail.append(h('span', { class: 'arw' + (clDown ? ' cl' : ''), title: clDown ? 'Arah turun ditutup sementara' : 'Turun beroperasi' }, ic(clDown ? 'wrench' : 'arrow-down')));
      if (!anyOn) rail.append(h('span.arw', ic('ban')));
      legs.forEach(l => content.append(legCard(b, l, upper, lower)));
    }
    wrap.append(rail, content);
    return wrap;
  }

  function legCard(b, leg, upper, lower) {
    const d = Object.assign({}, leg, dirtyLegs.get(leg.id) || {});
    const patch = p => { const cur0 = dirtyLegs.get(leg.id) || {}; Object.assign(cur0, p); dirtyLegs.set(leg.id, cur0); markDirty(); };
    const span = (flBy[leg.upperFloor]?.level ?? 0) - (flBy[leg.lowerFloor]?.level ?? 0);
    const en = toggle(d.isEnabled, d.isEnabled ? 'Aktif' : 'Nonaktif', { disabled: !canEdit, onchange: e => { patch({ isEnabled: e.target.checked }); renderPanel(); } });
    const dir = isEsc(b) ? segmented(DIR_OPTS, d.direction, v => { patch({ direction: v }); renderPanel(); }) : h('span.badge.outline', ic('arrow-up-down'), b.type === 'lift' ? 'Lift · selalu dua arah' : 'Dua arah');
    if (isEsc(b) && !canEdit) [...dir.children].forEach(x => x.disabled = true);
    const sch = select([['', 'Ikut bank'], ...schedules.map(s => [s.id, s.name])], d.scheduleId ?? '', { sm: true, disabled: !canEdit, 'aria-label': 'Jadwal leg' });
    sch.addEventListener('change', () => patch({ scheduleId: sch.value ? +sch.value : null }));
    const cost = input({ type: 'number', step: '0.1', value: d.costOverride ?? '', placeholder: String(leg.cost), sm: true, disabled: !canEdit, style: { width: '84px' }, 'aria-label': 'Override biaya' });
    cost.addEventListener('change', () => patch({ costOverride: cost.value === '' ? null : +cost.value }));
    const note = input({ value: d.fieldNote || '', sm: true, disabled: !canEdit, placeholder: 'Catatan lapangan…', style: { flex: '1 1 200px' }, 'aria-label': 'Catatan lapangan' });
    note.addEventListener('change', () => patch({ fieldNote: note.value || null }));
    const verifiedNow = 'verified' in (dirtyLegs.get(leg.id) || {}) ? dirtyLegs.get(leg.id).verified : !!leg.verifiedAt;
    const ver = checkbox(verifiedNow, 'Sudah dicek di lapangan', { disabled: !canEdit, onchange: e => patch({ verified: e.target.checked }) });
    const cls = (leg.activeClosures || []);
    const c = h('div', { class: 'leg-card' + (!d.isEnabled ? ' off' : '') + (dirtyLegs.has(leg.id) ? ' dirty' : '') },
      h('div.l1', h('span.badge.ink.mono', 'L' + leg.id), h('span.lt', `${flBy[leg.lowerFloor]?.short}↔${flBy[leg.upperFloor]?.short}`), en, dir, h('span.grow'),
        canEdit ? h('button.btn.sm.ghost.icon', { type: 'button', title: 'Hapus leg', 'aria-label': 'Hapus leg', onclick: () => delLeg(leg) }, ic('trash-2')) : null),
      h('div.l2', h('span.row', { style: { gap: '6px' } }, h('span.muted', 'Jadwal'), sch),
        h('span.row', { style: { gap: '6px' } }, h('span.muted', 'Biaya'), cost, h('span.small.muted', d.costOverride != null ? `(auto ${leg.cost})` : 'auto')),
        ver, leg.verifiedAt ? h('span.small', { style: { color: 'var(--ok)', fontWeight: 650 } }, `✔ dicek ${fmtDate(leg.verifiedAt, { time: false })}${leg.verifiedBy ? ' · ' + leg.verifiedBy : ''}`) : null),
      h('div.l2', note, leg.srcKey ? h('span.mono.small.muted', { title: 'Endpoint Mapplic (src_key)' }, leg.srcKey) : null),
      span > 1 && b.type === 'escalator' ? h('div.callout.warn', ic('triangle-alert'), `Leg eskalator melompati ${span} level (W_ESC_SPAN).`) : null,
      !d.isEnabled ? h('div.small.muted', 'Leg nonaktif tidak diekspor ke kiosk — rute tidak akan lewat sini.') : null,
      (cls.length || canClose) ? h('div.row.wrap', { style: { gap: '6px' } },
        cls.map(cl => h('span.closure-pill', ic('wrench'), closureText(cl) + (cl.scope === 'bank' ? ' (bank)' : ''), canClose ? h('button.btn.sm.ghost', { type: 'button', style: { height: '22px', padding: '0 6px' }, onclick: async () => { await endClosure(cl, `L${leg.id}`); reload(); ctx.refreshStatus(); } }, 'Buka') : null)),
        canClose && d.isEnabled ? h('button.btn.sm.ghost', { type: 'button', onclick: async () => {
          const allowed = isEsc(b) ? (leg.direction === 'both' ? ['both', 'up', 'down'] : [leg.direction]) : ['both'];
          const r = await closureDialog({ type: 'leg', id: leg.id, label: `${b.nameId} ${flBy[leg.lowerFloor]?.short}↔${flBy[leg.upperFloor]?.short}` }, { dirs: allowed, dir: allowed[0], settings });
          if (r) { reload(); ctx.refreshStatus(); }
        } }, ic('wrench'), 'Tutup sementara') : null) : null);
    return c;
  }

  // ---------- actions ----------
  async function saveAll() {
    try {
      if (dirtyBank) { const r = await api.put('/connectors/' + cur.id, dirtyBank, cur.etag); Object.assign(cur, r.data); }
      for (const [id, p] of dirtyLegs) { const lg = cur.legs.find(l => l.id === id); await api.put('/connector-legs/' + id, p, lg && lg.etag); }
      const n = dirtyLegs.size + (dirtyBank ? 1 : 0);
      dirtyLegs.clear(); dirtyBank = null; toast(`${n} perubahan disimpan — publish directory untuk mengirim ke kiosk`);
      await reload(); ctx.refreshStatus(); return true;
    } catch (e) { return false; }
  }
  async function reload() {
    invalidate('connectors'); banks = await lookups.connectors(); cur = banks.find(b => b.id === (cur && cur.id)) || banks[0];
    if (mc.floor) { mapGraph = (await api.get('/graph', { floor: mc.floor.id })).data; mapGraph.nodeBy = Object.fromEntries(mapGraph.nodes.map(n => [n.id, n])); }
    renderList(); renderPanel(); drawMap();
  }
  async function setServed(s, v) {
    await api.put('/connector-stops/' + s.id, { isServed: v });
    toast(v ? `Lift berhenti di ${floorName(flBy[s.floorId])}` : `Lift tidak berhenti di ${floorName(flBy[s.floorId])}`);
    if (await confirmDlg('Regenerate leg lift sekarang agar sesuai lantai yang dilayani?', { ok: 'Regenerate' })) await regen(true); else reload();
  }
  async function regen(skipConfirm) {
    if (skipConfirm !== true && !(await confirmDlg('Buat ulang leg lift dari stop yang dilayani? Leg lama yang tidak cocok dihapus.', { ok: 'Regenerate' }))) return;
    await api.post(`/connectors/${cur.id}/regenerate-lift-legs`); toast('Leg lift dibuat ulang'); ctx.refreshStatus(); reload();
  }
  async function makeLeg(b, lows, ups) {
    let lo = lows[0].id, up = ups[0].id, dir = 'both';
    const body = h('div.form', lows.length > 1 ? field('Stop bawah', select(lows.map(s => [s.id, s.publicId]), lo, { onchange: e => lo = +e.target.value })) : h('div', 'Bawah: ', h('b.mono', lows[0].publicId)),
      ups.length > 1 ? field('Stop atas', select(ups.map(s => [s.id, s.publicId]), up, { onchange: e => up = +e.target.value })) : h('div', 'Atas: ', h('b.mono', ups[0].publicId)),
      isEsc(b) ? field('Arah', segmented(DIR_OPTS, dir, v => dir = v)) : null);
    if (!(await dialog({ title: 'Buat leg', body, actions: [{ label: 'Batal', value: null }, { label: 'Buat', kind: 'primary', value: true }] }))) return;
    await api.post(`/connectors/${b.id}/legs`, { lowerStopId: lo, upperStopId: up, direction: dir }); toast('Leg dibuat'); ctx.refreshStatus(); reload();
  }
  async function delLeg(leg) {
    if (!(await confirmDlg(`Hapus leg L${leg.id}? Untuk menonaktifkan sementara cukup matikan toggle "Aktif".`, { danger: true, ok: 'Hapus leg' }))) return;
    await api.del('/connector-legs/' + leg.id); dirtyLegs.delete(leg.id); toast('Leg dihapus'); ctx.refreshStatus(); reload();
  }
  async function delStop(s) {
    const n = cur.legs.filter(l => l.lowerStopId === s.id || l.upperStopId === s.id).length;
    if (!(await confirmDlg(`Hapus stop ${s.publicId}${n ? ` beserta ${n} leg` : ''}? Node graph-nya tetap ada.`, { danger: true, ok: 'Hapus stop' }))) return;
    await api.del('/connector-stops/' + s.id); toast('Stop dihapus'); ctx.refreshStatus(); reload();
  }
  async function editBank() {
    const b = cur;
    const body = h('div.form.cols-2',
      field('Nama (Indonesia)', input({ name: 'nameId', value: b.nameId }), { name: 'nameId', required: true }), field('Nama (English)', input({ name: 'nameEn', value: b.nameEn }), { name: 'nameEn', required: true }),
      field('Patokan (Indonesia)', input({ name: 'landmarkId', value: b.landmarkId || '', placeholder: 'depan Sociolla' })), field('Patokan (English)', input({ name: 'landmarkEn', value: b.landmarkEn || '', placeholder: 'in front of Sociolla' })),
      field('Kode', input({ name: 'code', value: b.code || '', class: 'inp mono' })), field('Urutan', input({ name: 'sortOrder', type: 'number', value: b.sortOrder || 0 })),
      field('Catatan', h('textarea', { class: 'inp', name: 'notes', rows: 3 }, b.notes || ''), { span: 'span-2' }));
    const ok = await dialog({ title: 'Ubah info bank', body, actions: [{ label: 'Batal', value: null }, { label: 'Simpan', kind: 'primary', value: true, validate: async () => {
      try { await api.put('/connectors/' + b.id, readForm(body), b.etag); return true; } catch (e) { if (e.fields) showFieldErrors(body, e.fields); return false; }
    } }] });
    if (ok) { toast('Bank disimpan'); ctx.refreshStatus(); reload(); }
  }
  async function newBank() {
    const body = h('div.form.cols-2',
      field('ID', input({ name: 'id', class: 'inp mono', placeholder: 'esc-d-penta' }), { name: 'id', required: true }),
      field('Jenis', select(Object.entries(BANK_TYPE), 'escalator', { name: 'type' })),
      field('Gedung', select([['pentacity', 'Pentacity'], ['ewalk', 'E-Walk'], ['both', 'Gabungan / penghubung']], 'pentacity', { name: 'building' })),
      field('Kode', input({ name: 'code', class: 'inp mono', placeholder: 'D' })),
      field('Nama (Indonesia)', input({ name: 'nameId', placeholder: 'Eskalator D · Pentacity' }), { name: 'nameId', required: true }),
      field('Nama (English)', input({ name: 'nameEn', placeholder: 'Escalator D · Pentacity' }), { name: 'nameEn', required: true }));
    const ok = await dialog({ title: 'Bank konektor baru', body, actions: [{ label: 'Batal', value: null }, { label: 'Buat', kind: 'primary', value: true, validate: async () => {
      const o = readForm(body); if (!o.id || !o.nameId || !o.nameEn) { showFieldErrors(body, { id: o.id ? undefined : 'required', nameId: o.nameId ? undefined : 'required', nameEn: o.nameEn ? undefined : 'required' }); return false; }
      try { const r = await api.post('/connectors', o); cur = r.data; return true; } catch (e) { if (e.fields) showFieldErrors(body, e.fields); return false; }
    } }] });
    if (ok) { toast('Bank dibuat — tambahkan stop per lantai'); history.replaceState(null, '', '#/connectors/' + cur.id); reload(); }
  }

  renderList(); renderPanel();
  await mc.ready;
  const first = cur && cur.stops.slice().sort((a, b) => a.level - b.level)[0];
  if (first) jumpTo(first);
}
