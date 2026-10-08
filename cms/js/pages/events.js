// Events — §2.11 / §7.2 #13: list + edit (location tenant / facility / map point / text), show on attract, publish flag.
import { h, ic, btn, badge, pageHead, field, input, textarea, select, toggle, segmented, table, toast, dialog, confirmDlg, clear, card,
  showFieldErrors, fmtDate, assetUrl, isoToLocal, localToIso, emptyState, svgEl } from '../ui.js';
import { api, lookups } from '../api.js';
import { can, floorName } from '../state.js';
import { mediaPicker } from './media.js';
import { MapCanvas, nearestNode, pinPath } from '../mapcanvas.js';

const LOC = { text: 'Teks bebas', tenant: 'Tenant', amenity: 'Fasilitas', point: 'Titik di peta' };

export default async function events(ctx) {
  ctx.setTitle('Event');
  const canEdit = can('events.edit');
  ctx.root.append(pageHead('Event', 'Event dengan lokasi bisa dirutekan dari kiosk. "Tampil di atraksi" = dirender sebagai kartu promo.', [canEdit ? btn('Event baru', { icon: 'plus', kind: 'primary', onClick: () => edit(null) }) : null]));
  const [tenants, amenities, floors] = await Promise.all([lookups.tenantsLite().catch(() => []), api.get('/amenities').then(r => r.data).catch(() => []), lookups.floors()]);
  const tBy = Object.fromEntries(tenants.map(t => [t.id, t])); const flBy = Object.fromEntries(floors.map(f => [f.id, f]));
  let list = [];
  const tbl = table({ rows: [], onRow: canEdit ? edit : null, empty: 'Belum ada event', columns: [
    { key: 'titleId', label: 'Event', render: e => h('div', h('div.t-name', e.titleId), h('div.t-sub', e.titleEn)) },
    { key: 'when', label: 'Waktu', sort: e => e.startsAt, render: e => h('span.nowrap', `${fmtDate(e.startsAt)} – ${fmtDate(e.endsAt, { time: true })}`) },
    { key: 'loc', label: 'Lokasi', render: e => locText(e) },
    { key: 'attract', label: 'Atraksi', render: e => e.showOnAttract ? badge('Ya', 'info') : h('span.muted', '—') },
    { key: 'pub', label: 'Status', render: e => e.isPublished ? (new Date(e.endsAt) < new Date() ? badge('Selesai', '') : badge('Terpublish', 'ok')) : badge('Draft', 'warn') }] });
  ctx.root.append(h('div.card', tbl));
  const locText = e => e.locationType === 'tenant' ? (tBy[e.tenantId] || {}).displayName || e.tenantId : e.locationType === 'amenity' ? e.amenityId : e.locationType === 'point' ? `Titik di ${floorName(flBy[e.floorId])}` : (e.locationTextId || '—');
  async function load() { list = (await api.get('/events')).data; tbl.setRows(list.sort((a, b) => b.startsAt.localeCompare(a.startsAt))); }

  async function edit(e0) {
    const isNew = !e0; const e = Object.assign({ titleEn: '', titleId: '', descEn: null, descId: null, media: null, startsAt: null, endsAt: null, locationType: 'text', tenantId: null, amenityId: null, floorId: null, x: null, y: null, nodeId: null, locationTextEn: null, locationTextId: null, showOnAttract: true, isPublished: false }, e0 ? JSON.parse(JSON.stringify(e0)) : {});
    const locBox = h('div');
    const renderLoc = () => {
      clear(locBox);
      if (e.locationType === 'tenant') locBox.append(field('Tenant', select([['', '— pilih —'], ...tenants.map(t => [t.id, t.displayName])], e.tenantId, { onchange: ev => e.tenantId = ev.target.value || null })));
      if (e.locationType === 'amenity') locBox.append(field('Fasilitas', select([['', '— pilih —'], ...amenities.map(a => [a.id, a.id])], e.amenityId, { onchange: ev => e.amenityId = ev.target.value || null })));
      if (e.locationType === 'text') locBox.append(h('div.lang-pair', field('Lokasi (ID)', input({ value: e.locationTextId || '', placeholder: 'Atrium GF Pentacity', oninput: ev => e.locationTextId = ev.target.value || null })), field('Lokasi (EN)', input({ value: e.locationTextEn || '', oninput: ev => e.locationTextEn = ev.target.value || null }))));
      if (e.locationType === 'point') locBox.append(h('div.row', h('span.small', e.floorId ? `${floorName(flBy[e.floorId])} · ${(+e.x).toFixed(0)}, ${(+e.y).toFixed(0)} · node n${e.nodeId}` : 'Belum dipilih'), btn('Pilih di peta', { size: 'sm', icon: 'map-pin', onClick: async () => { const r = await pickPoint(floors, e); if (r) { Object.assign(e, r); renderLoc(); } } })));
    };
    renderLoc();
    const mediaRow = h('div.row');
    const renderMedia = () => { clear(mediaRow).append(e.media ? h('img.logo-thumb', { src: assetUrl(e.media.url), alt: '', style: { width: '96px', height: '64px', objectFit: 'cover' } }) : h('span.small.muted', 'Tanpa gambar (kartu warna)'), btn('Pilih', { size: 'sm', icon: 'image', onClick: async () => { const m = await mediaPicker('image'); if (m) { e.media = { id: m.id, url: m.url }; renderMedia(); } } }), e.media ? btn('', { size: 'sm', icon: 'x', kind: 'ghost', onClick: () => { e.media = null; renderMedia(); } }) : null); };
    renderMedia();
    const tI = input({ value: e.titleId }), tE = input({ value: e.titleEn });
    const dI = textarea({ value: e.descId, rows: 2 }), dE = textarea({ value: e.descEn, rows: 2 });
    const s = input({ type: 'datetime-local', value: isoToLocal(e.startsAt) }), en = input({ type: 'datetime-local', value: isoToLocal(e.endsAt) });
    const body = h('div.stack',
      h('div.lang-pair', field('Judul (ID)', tI, { name: 'titleId', required: true }), field('Judul (EN)', tE, { name: 'titleEn', required: true })),
      h('div.lang-pair', field('Deskripsi (ID)', dI), field('Deskripsi (EN)', dE)),
      h('div.lang-pair', field('Mulai', s, { name: 'startsAt', required: true }), field('Selesai', en, { name: 'endsAt', required: true })),
      field('Lokasi', segmented(Object.entries(LOC).map(([v, l]) => ({ value: v, label: l })), e.locationType, v => { e.locationType = v; renderLoc(); })), locBox,
      field('Gambar', mediaRow),
      h('div.row.wrap', { style: { gap: '18px' } }, toggle(e.showOnAttract, 'Tampil di layar atraksi', { onchange: ev => e.showOnAttract = ev.target.checked }), toggle(e.isPublished, 'Terpublish', { onchange: ev => e.isPublished = ev.target.checked })));
    const res = await dialog({ title: isNew ? 'Event baru' : 'Ubah event', wide: true, body, actions: [!isNew ? { label: 'Hapus', kind: 'danger', value: 'del' } : null, { label: 'Batal', value: null }, { label: 'Simpan', kind: 'primary', value: 'save', validate: async () => {
      Object.assign(e, { titleId: tI.value.trim(), titleEn: tE.value.trim(), descId: dI.value || null, descEn: dE.value || null, startsAt: localToIso(s.value), endsAt: localToIso(en.value) });
      const errs = {}; if (!e.titleId) errs.titleId = 'required'; if (!e.titleEn) errs.titleEn = 'required'; if (!e.startsAt) errs.startsAt = 'required'; if (!e.endsAt) errs.endsAt = 'required';
      if (e.startsAt && e.endsAt && e.endsAt < e.startsAt) errs.endsAt = 'Harus setelah mulai';
      if (Object.keys(errs).length) { showFieldErrors(body, errs); return false; }
      try { isNew ? await api.post('/events', e) : await api.put('/events/' + e.id, e, e.etag); return true; } catch (er) { if (er.fields) showFieldErrors(body, er.fields); return false; }
    } }].filter(Boolean) });
    if (res === 'del' && await confirmDlg('Hapus event ini?', { danger: true, ok: 'Hapus' })) { await api.del('/events/' + e.id); toast('Event dihapus'); }
    if (res === 'save') toast('Event disimpan — publish kanal promo agar tayang');
    if (res) { ctx.refreshStatus(); load(); }
  }
  await load();
}

/** modal map to pick a point → {floorId, x, y, nodeId} */
export async function pickPoint(floors, cur) {
  const host = h('div', { style: { height: '460px', position: 'relative' } });
  let res = cur && cur.floorId ? { floorId: cur.floorId, x: cur.x, y: cur.y, nodeId: cur.nodeId } : null, graph = null, mc;
  const info = h('div.small.muted', 'Klik titik lokasi — di-snap ke node koridor terdekat.');
  const draw = () => { if (!mc) return; const t = mc.layer('top'); if (res && res.floorId === mc.floor.id) t.append(svgEl('path', { d: pinPath(res.x, res.y, mc.px(11)), class: 'ov-pin' })); };
  const p = dialog({ title: 'Pilih titik di peta', wide: true, body: h('div.stack', host, info), actions: [{ label: 'Batal', value: null }, { label: 'Pakai titik ini', kind: 'primary', value: () => res }],
    onOpen: () => {
      mc = new MapCanvas(host, { floors, floorId: (cur && cur.floorId) || 'gf', height: '100%', onRender: draw });
      mc.capture = true; mc.setCursor('crosshair');
      mc.on('floor', async f => { graph = (await api.get('/graph', { floor: f.id })).data; });
      mc.on('click', pt => { if (!graph) return; const nn = nearestNode(pt, graph.nodes); res = { floorId: mc.floor.id, x: +pt.x.toFixed(2), y: +pt.y.toFixed(2), nodeId: nn ? nn.node.id : null }; info.textContent = `${floorName(mc.floor)} · node n${res.nodeId}`; draw(); });
    } });
  const v = await p; if (mc) mc.destroy(); return v;
}
