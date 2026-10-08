// Facilities / POI — §2.9 / §7.2 #11: types (icon, color, show in home ≤ 6) + POIs per floor; add by clicking the map.
import { h, ic, btn, badge, pageHead, field, input, select, toggle, segmented, toast, dialog, confirmDlg, clear, card, svgEl, tabs, table, showFieldErrors, langPair, readForm } from '../ui.js';
import { api, lookups, invalidate } from '../api.js';
import { can, floorName, BUILDING_LABEL } from '../state.js';
import { floorOptions } from '../widgets.js';
import { MapCanvas, nearestNode } from '../mapcanvas.js';
import { icon as iconSvg, iconBody } from '../icons.js';
import { pickIcon } from './categories.js';

const GENDER = { all: 'Semua', male: 'Pria', female: 'Wanita', family: 'Keluarga' };

export default async function amenities(ctx) {
  ctx.setTitle('Fasilitas');
  const canEdit = can('amenities.edit');
  let tab = ctx.query.get('tab') || 'poi';
  ctx.root.append(pageHead('Fasilitas', 'Toilet, musholla, ATM, information desk, dsb. Ditampilkan di peta kiosk & tombol "terdekat" di beranda.'));
  const bar = tabs([{ key: 'poi', label: 'Lokasi fasilitas', icon: 'map-pin' }, { key: 'types', label: 'Tipe fasilitas', icon: 'tags' }], tab, k => { tab = k; show(); });
  const body = h('div');
  ctx.root.append(bar, body);
  let mc = null; ctx.onLeave(() => mc && mc.destroy());
  const [floors, schedules] = await Promise.all([lookups.floors(), lookups.schedules().catch(() => [])]);
  const flBy = Object.fromEntries(floors.map(f => [f.id, f]));
  let types = await lookups.amenityTypes(); let typeBy = Object.fromEntries(types.map(t => [t.id, t]));
  let items = (await api.get('/amenities')).data;

  function show() { if (mc) { mc.destroy(); mc = null; } clear(body); history.replaceState(null, '', '#/amenities?tab=' + tab); tab === 'types' ? renderTypes() : renderPoi(); }

  function renderTypes() {
    const homeCount = types.filter(t => t.showInHome).length;
    const tbl = table({ rows: types.slice().sort((a, b) => a.sortOrder - b.sortOrder), keyFn: r => r.id, onRow: canEdit ? editType : null, columns: [
      { key: 'icon', label: '', width: '52px', render: t => h('span.cat-ic', { style: { background: t.color + '1A', color: t.color }, html: iconSvg(t.icon) }) },
      { key: 'nameId', label: 'Nama', render: t => h('div', h('div.t-name', t.nameId), h('div.t-sub', t.nameEn + ' · ', h('span.mono', t.id))) },
      { key: 'color', label: 'Warna', render: t => h('span.row', h('span.swatch', { style: { background: t.color } }), h('span.mono.small', t.color)) },
      { key: 'count', label: 'Jumlah', cls: 'num', render: t => String(items.filter(a => a.typeId === t.id).length) },
      { key: 'showInHome', label: 'Di beranda', render: t => t.showInHome ? badge('Ya', 'ok', 'check') : h('span.muted', '—') },
      { key: 'sortOrder', label: 'Urutan', cls: 'num' }] });
    body.append(homeCount > 6 ? h('div.callout.warn', { style: { marginBottom: '12px' } }, ic('triangle-alert'), `${homeCount} tipe ditandai "di beranda" — kiosk hanya menampilkan maks 6 (urutan teratas).`) : null,
      h('div.card', tbl), canEdit ? h('div', { style: { marginTop: '12px' } }, btn('Tipe baru', { icon: 'plus', onClick: () => editType(null) })) : null);
  }
  async function editType(t) {
    const isNew = !t; const v = Object.assign({ id: '', nameEn: '', nameId: '', icon: 'info', color: '#2F5BEA', showInHome: false, sortOrder: types.length + 1 }, t || {});
    const icBtn = h('button.btn', { type: 'button', onclick: async () => { const n = await pickIcon(v.icon); if (n) { v.icon = n; icBtn.innerHTML = iconSvg(n) + ' ' + n; } }, html: iconSvg(v.icon) + ' ' + v.icon });
    const b = h('div.form.cols-2', field('ID', input({ name: 'id', value: v.id, disabled: !isNew, class: 'inp mono' }), { name: 'id', required: true }), field('Ikon', icBtn),
      field('Nama (Indonesia)', input({ name: 'nameId', value: v.nameId }), { name: 'nameId', required: true }), field('Nama (English)', input({ name: 'nameEn', value: v.nameEn }), { name: 'nameEn', required: true }),
      field('Warna', input({ type: 'color', name: 'color', value: v.color, style: { width: '64px', padding: '3px' } })), field('Urutan', input({ type: 'number', name: 'sortOrder', value: v.sortOrder })),
      field('', toggle(v.showInHome, 'Tampilkan tombol "terdekat" di beranda kiosk', { name: 'showInHome' }), { span: 'span-2' }));
    const ok = await dialog({ title: isNew ? 'Tipe fasilitas baru' : 'Ubah tipe fasilitas', body: b, actions: [{ label: 'Batal', value: null }, { label: 'Simpan', kind: 'primary', value: true, validate: async () => {
      const o = Object.assign(readForm(b), { icon: v.icon }); if (!o.id || !o.nameId || !o.nameEn) { showFieldErrors(b, { id: o.id ? undefined : 'required', nameId: o.nameId ? undefined : 'required', nameEn: o.nameEn ? undefined : 'required' }); return false; }
      try { isNew ? await api.post('/amenity-types', o) : await api.put('/amenity-types/' + t.id, o, t.etag); return true; } catch (e) { if (e.fields) showFieldErrors(b, e.fields); return false; }
    } }] });
    if (ok) { invalidate('amenity-types'); types = await lookups.amenityTypes(); typeBy = Object.fromEntries(types.map(x => [x.id, x])); toast('Tipe disimpan'); ctx.refreshStatus(); show(); }
  }

  let sel = null, mode = 'view', graph = null;
  function renderPoi() {
    const floorId = ctx.query.get('floor') || 'gf';
    const listEl = h('div.card', { style: { maxHeight: '620px', overflow: 'auto' } });
    const side = h('div.stack');
    const modeSeg = segmented([{ value: 'view', label: 'Pilih', icon: 'mouse-pointer-2' }, { value: 'add', label: 'Tambah di peta', icon: 'plus' }], mode, v => setMode(v));
    if (!canEdit) [...modeSeg.children][1].disabled = true;
    const mapHost = h('div', { style: { height: '620px', position: 'relative' } });
    body.append(h('div.row', { style: { marginBottom: '12px' } }, modeSeg, h('span.grow'), h('span.small.muted', 'Node POI tidak boleh sama dengan node eskalator/lift (W_POI_NODE).')),
      h('div.grid', { style: { gridTemplateColumns: '260px minmax(0,1fr) 340px', gap: '16px', alignItems: 'start' } }, listEl, mapHost, side));
    mc = new MapCanvas(mapHost, { floors, floorId, height: '100%', onRender: draw, layers: {} });
    mc.on('floor', async f => { graph = (await api.get('/graph', { floor: f.id })).data; graph.nodeBy = Object.fromEntries(graph.nodes.map(n => [n.id, n])); renderList(); draw(); });
    mc.on('click', pt => {
      if (!graph) return;
      if (mode === 'add' || mode === 'move') {
        const nn = nearestNode(pt, graph.nodes, new Set(graph.attachments.stops.map(s => s.nodeId)));
        const f = mc.floor;
        if (mode === 'add') { sel = { id: '', typeId: types[0].id, floorId: f.id, building: f.building === 'both' ? 'pentacity' : f.building, x: +pt.x.toFixed(2), y: +pt.y.toFixed(2), nodeId: nn ? nn.node.id : null, nameEn: null, nameId: null, detailEn: null, detailId: null, isWheelchair: false, gender: 'all', scheduleId: null, isPublished: true, _new: true }; }
        else Object.assign(sel, { x: +pt.x.toFixed(2), y: +pt.y.toFixed(2), nodeId: nn ? nn.node.id : null, _moved: true });
        setMode('view'); renderSide(); draw();
      }
    });
    function setMode(v) { mode = v; modeSeg.setValue(v === 'move' ? 'view' : v); mc.capture = v !== 'view'; mc.setCursor(v !== 'view' ? 'crosshair' : null); mc.hint(v === 'add' ? 'Klik lokasi fasilitas — di-snap ke node koridor terdekat.' : v === 'move' ? 'Klik lokasi baru untuk ' + (sel && (sel.nameId || typeBy[sel.typeId]?.nameId)) : ''); }
    function renderList() {
      clear(listEl);
      const here = items.filter(a => a.floorId === mc.floor.id);
      listEl.append(h('div.card-h', h('h3', floorName(mc.floor)), h('span.badge', String(here.length))));
      if (!here.length) listEl.append(h('div.empty', 'Belum ada fasilitas di lantai ini.'));
      here.forEach(a => { const t = typeBy[a.typeId] || {}; listEl.append(h('div.row', { tabIndex: 0, style: { padding: '9px 14px', borderTop: '1px solid var(--line)', cursor: 'pointer', background: sel && sel.id === a.id ? 'var(--accent-soft)' : null }, onclick: () => { sel = JSON.parse(JSON.stringify(a)); renderSide(); renderList(); draw(); mc.centerOn(a.x, a.y, 500); } },
        h('span.cat-ic', { style: { background: (t.color || '#888') + '1A', color: t.color, width: '28px', height: '28px', fontSize: '15px' }, html: iconSvg(t.icon) }),
        h('div.grow', h('div', { style: { fontWeight: 650 } }, a.nameId || t.nameId), h('div.small.muted.mono', a.id)), a.isPublished ? null : badge('Draft', 'warn'))); });
    }
    function draw() {
      if (!graph || !mc) return;
      const g = mc.layer('graph'), p = mc.layer('pois');
      for (const e of graph.edges) { const a = graph.nodeBy[e.a], b = graph.nodeBy[e.b]; if (a && b) g.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'ov-edge', style: 'opacity:.35' })); }
      for (const s of graph.attachments.stops) p.append(svgEl('rect', { x: s.x - mc.px(6), y: s.y - mc.px(6), width: mc.px(12), height: mc.px(12), rx: mc.px(3), fill: '#1D1A17', opacity: .5 }, svgEl('title', { text: s.publicId })));
      const list = items.filter(a => a.floorId === mc.floor.id && (!sel || a.id !== sel.id)).concat(sel && sel.floorId === mc.floor.id ? [sel] : []);
      for (const a of list) {
        const t = typeBy[a.typeId] || { color: '#888', icon: 'info' }; const me = sel && a === sel; const r = mc.px(me ? 14 : 11);
        const nd = a.nodeId && graph.nodeBy[a.nodeId];
        if (me && nd) p.append(svgEl('line', { x1: a.x, y1: a.y, x2: nd.x, y2: nd.y, class: 'ov-link' }));
        const gEl = svgEl('g', { 'data-hit': '1', style: 'cursor:pointer', onclick: () => { sel = JSON.parse(JSON.stringify(items.find(x => x.id === a.id) || a)); renderSide(); renderList(); draw(); } });
        gEl.append(svgEl('circle', { cx: a.x, cy: a.y, r, fill: t.color, class: 'ov-poi', 'stroke-width': me ? 3 : 1.6 }));
        const icn = svgEl('svg', { x: a.x - r * .6, y: a.y - r * .6, width: r * 1.2, height: r * 1.2, viewBox: '0 0 24 24', fill: 'none', stroke: '#fff', 'stroke-width': 2.4, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', style: 'pointer-events:none' });
        icn.innerHTML = iconBody(t.icon);
        gEl.append(icn, svgEl('title', { text: (a.nameId || t.nameId) + ' · ' + (a.id || 'baru') }));
        p.append(gEl);
      }
    }
    function renderSide() {
      clear(side);
      if (!sel) { side.append(card('Detail', h('div.empty', ic('map-pin'), 'Pilih fasilitas di daftar/peta, atau "Tambah di peta".'))); return; }
      const a = sel; const isNew = !!a._new;
      const stopClash = graph && graph.attachments.stops.some(s => s.nodeId === a.nodeId);
      const f = h('div.form',
        field('ID', input({ name: 'id', value: a.id, disabled: !isNew || !canEdit, class: 'inp mono', placeholder: `${a.typeId}-${a.floorId}-1` }), { name: 'id', required: true }),
        field('Tipe', select(types.map(t => [t.id, t.nameId]), a.typeId, { name: 'typeId', disabled: !canEdit }), { name: 'typeId' }),
        langPair('nameEn', 'nameId', a, { label: 'Nama (opsional)', placeholder: typeBy[a.typeId]?.nameId }),
        langPair('detailEn', 'detailId', a, { label: 'Detail', placeholder: 'Pria & wanita, ada difabel' }),
        h('div.form.cols-2', field('Gedung', select([['pentacity', 'Pentacity'], ['ewalk', 'E-Walk']], a.building, { name: 'building', disabled: !canEdit || flBy[a.floorId].building !== 'both' })),
          field('Gender', select(Object.entries(GENDER), a.gender, { name: 'gender', disabled: !canEdit }))),
        field('Jadwal buka', select([['', 'Ikut jam mall'], ...schedules.map(s => [s.id, s.name])], a.scheduleId ?? '', { name: 'scheduleId', disabled: !canEdit })),
        toggle(a.isWheelchair, 'Ramah kursi roda', { name: 'isWheelchair', disabled: !canEdit }),
        toggle(a.isPublished, 'Terpublish', { name: 'isPublished', disabled: !canEdit }),
        h('div.small.muted', `${floorName(flBy[a.floorId])} · x ${(+a.x).toFixed(1)}, y ${(+a.y).toFixed(1)} · node ${a.nodeId ? 'n' + a.nodeId : '—'}`),
        stopClash ? h('div.callout.warn', ic('triangle-alert'), 'Node sama dengan node stop eskalator/lift (W_POI_NODE) — pindahkan sedikit.') : null);
      f.addEventListener('change', e => { if (e.target.name === 'typeId') { a.typeId = e.target.value; draw(); } });
      side.append(card(isNew ? 'Fasilitas baru' : (a.nameId || typeBy[a.typeId]?.nameId), h('div.stack', f,
        canEdit ? h('div.row.wrap', btn('Simpan', { icon: 'save', kind: 'primary', onClick: async () => {
          const o = Object.assign({}, a, readForm(f)); delete o._new; delete o._moved; o.scheduleId = o.scheduleId ? +o.scheduleId : null;
          if (!o.id) return showFieldErrors(f, { id: 'required' });
          try {
            const r = isNew ? await api.post('/amenities', o) : await api.put('/amenities/' + a.id, o, a.etag);
            items = (await api.get('/amenities')).data; sel = JSON.parse(JSON.stringify(r.data)); toast('Fasilitas disimpan'); ctx.refreshStatus(); renderList(); renderSide(); draw();
          } catch (e) { if (e.fields) showFieldErrors(f, e.fields); }
        } }), btn('Pindahkan', { icon: 'map-pin', onClick: () => setMode('move') }), h('span.grow'),
          !isNew ? btn('', { icon: 'trash-2', kind: 'danger', title: 'Hapus', onClick: async () => { if (!(await confirmDlg(`Hapus ${a.id}?`, { danger: true, ok: 'Hapus' }))) return; await api.del('/amenities/' + a.id); items = items.filter(x => x.id !== a.id); sel = null; toast('Fasilitas dihapus'); renderList(); renderSide(); draw(); } }) : btn('Batal', { kind: 'ghost', onClick: () => { sel = null; renderSide(); draw(); } })) : null)));
    }
    renderSide();
  }
  show();
}
