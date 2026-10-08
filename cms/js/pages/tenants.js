// Tenant list — §2.2 / §7.2 #3: filters, bulk set category & status, export CSV.
import { h, ic, btn, badge, table, pageHead, select, input, toast, dialog, field, debounce, clear, fmtNum, relTime, confirmDlg } from '../ui.js';
import { api, apiUrl, lookups, invalidate, MOCK } from '../api.js';
import { can, floorName, STATUS_LABEL, HOURS_MODE, BUILDING_LABEL } from '../state.js';
import { statusBadge, logoThumb, floorOptions } from '../widgets.js';

const MISSING = [['', 'Semua'], ['logo', 'Tanpa logo'], ['hours', 'Tanpa jam'], ['placement', 'Belum ditempatkan'], ['unit', 'Unit belum ditautkan']];

export default async function tenants(ctx) {
  ctx.setTitle('Tenant');
  const q = ctx.query;
  const f = { q: q.get('q') || '', floor: q.get('floor') || '', building: q.get('building') || '', category: q.get('category') || '', status: q.get('status') || '', missing: q.get('missing') || '' };
  const [floors, cats] = await Promise.all([lookups.floors(), lookups.categories()]);
  const catBy = Object.fromEntries(cats.map(c => [c.id, c])), flBy = Object.fromEntries(floors.map(x => [x.id, x]));
  const canEdit = can('tenants.edit');

  const countEl = h('span');
  ctx.root.append(pageHead('Tenant', h('span', countEl, ' outlet · brand & outlet digabung dalam satu form'), [
    h('a.btn', { href: MOCK ? null : apiUrl('/admin/tenants/export.csv'), download: 'tenants.csv', onclick: MOCK ? (e) => { e.preventDefault(); exportLocal(); } : null }, ic('download'), 'Export CSV'),
    canEdit ? h('a.btn.primary', { href: '#/tenants/new' }, ic('plus'), 'Tenant baru') : null]));

  // filters
  const search = input({ type: 'search', placeholder: 'Cari nama, id, unit, keyword…', value: f.q, 'aria-label': 'Cari tenant' });
  const sFloor = select(floorOptions(floors, { empty: 'Semua lantai' }), f.floor, { sm: true, 'aria-label': 'Lantai' });
  const sBld = select([['', 'Semua gedung'], ['pentacity', 'Pentacity'], ['ewalk', 'E-Walk']], f.building, { sm: true, 'aria-label': 'Gedung' });
  const sCat = select([['', 'Semua kategori'], ...cats.map(c => [c.id, c.nameId])], f.category, { sm: true, 'aria-label': 'Kategori' });
  const sSt = select([['', 'Semua status'], ...Object.entries(STATUS_LABEL)], f.status, { sm: true, 'aria-label': 'Status' });
  const chips = h('div.row.wrap', { style: { gap: '6px' } });
  const renderChips = () => { clear(chips); MISSING.forEach(([k, l]) => chips.append(h('button', { type: 'button', class: 'chip' + (f.missing === k ? ' on' : ''), onclick: () => { f.missing = k; renderChips(); load(); } }, l))); };
  renderChips();
  ctx.root.append(h('div.filters', h('div.search', ic('search'), search), sFloor, sBld, sCat, sSt), h('div.filters', h('span.small.muted', 'Kelengkapan:'), chips));
  [sFloor, sBld, sCat, sSt].forEach((s, i) => s.addEventListener('change', () => { f[['floor', 'building', 'category', 'status'][i]] = s.value; load(); }));
  search.addEventListener('input', debounce(() => { f.q = search.value.trim(); load(); }, 200));

  // bulk bar
  const bulk = h('div.savebar', { hidden: true, style: { position: 'sticky', top: '0', bottom: 'auto', marginTop: 0, marginBottom: '10px' } });
  const tbl = table({
    selectable: canEdit, keyFn: r => r.id, empty: 'Tidak ada tenant yang cocok dengan filter.',
    onSelect: ids => renderBulk(ids),
    onRow: r => location.hash = '#/tenants/' + encodeURIComponent(r.id),
    columns: [
      { key: 'logo', label: '', render: r => logoThumb(r.logoOverride || r.brand.logo, r.displayName), width: '60px' },
      { key: 'displayName', label: 'Nama', sort: r => r.displayName.toLowerCase(), render: r => h('div', h('div.t-name', r.displayName), h('div.t-sub.mono', r.id)) },
      { key: 'category', label: 'Kategori', sort: r => r.brand.categoryId, render: r => { const c = catBy[r.brand.categoryId]; return c ? h('span.row', { style: { gap: '7px' } }, h('span.swatch', { style: { background: c.color } }), c.nameId) : r.brand.categoryId; } },
      { key: 'floor', label: 'Lokasi', sort: r => (flBy[r.floorId] || {}).level, render: r => h('div.nowrap', h('div', h('b', (flBy[r.floorId] || {}).short || r.floorId), ' · ' + BUILDING_LABEL[r.building]), r.unitNo ? h('div.t-sub.mono', r.unitNo) : null) },
      { key: 'status', label: 'Status', sort: true, render: r => statusBadge(r.status) },
      { key: 'hoursMode', label: 'Jam', sort: true, render: r => r.hoursMode === 'unknown' ? h('span.muted', '—') : h('span.nowrap', { mall: 'Jam mall', custom: 'Khusus', '24h': '24 jam' }[r.hoursMode]) },
      { key: 'map', label: 'Peta', render: r => h('span.row', { style: { gap: '4px' } },
        r.nodeId ? badge('Ditempatkan', 'ok', 'map-pin') : badge('Belum', 'danger', 'map-pin'),
        r.unitShapeId ? badge('Unit', 'info', 'link') : null) },
      { key: 'updatedAt', label: 'Diubah', sort: r => r.updatedAt, render: r => h('span.small.muted.nowrap', r.updatedAt ? relTime(r.updatedAt) : '—') },
    ], rows: [] });
  const cardEl = h('div.card', h('div.card-b.flush', tbl));
  ctx.root.append(bulk, cardEl);

  let rows = [];
  async function load() {
    const params = Object.assign({ per: 500 }, f);
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    history.replaceState(null, '', '#/tenants' + (qs ? '?' + qs : ''));
    const r = await api.get('/tenants', params);
    rows = r.data; countEl.textContent = fmtNum(r.total ?? rows.length);
    tbl.setRows(rows);
  }
  function renderBulk(ids) {
    clear(bulk); bulk.hidden = !ids.length; if (!ids.length) return;
    const sc = select([['', 'Set kategori…'], ...cats.map(c => [c.id, c.nameId])], '', { sm: true, 'aria-label': 'Set kategori' });
    const ss = select([['', 'Set status…'], ...Object.entries(STATUS_LABEL)], '', { sm: true, 'aria-label': 'Set status' });
    bulk.append(ic('check'), h('b', `${ids.length} dipilih`), h('span.grow'), sc, ss,
      h('button.btn.light.sm', { onclick: async () => {
        const set = {}; if (sc.value) set.categoryId = sc.value; if (ss.value) set.status = ss.value;
        if (!Object.keys(set).length) return toast('Pilih kategori atau status dulu', 'warn');
        if (!(await confirmDlg(`Terapkan ke ${ids.length} tenant?`, { ok: 'Terapkan' }))) return;
        try { await api.post('/tenants/bulk', { ids, set }, { silent: true }); }
        catch (e) {
          if (e.status !== 404) throw e;
          for (const id of ids) { const t = rows.find(x => x.id === id); const body = {}; if (set.status) body.status = set.status; if (set.categoryId) body.brand = Object.assign({}, t.brand, { categoryId: set.categoryId }); await api.put('/tenants/' + encodeURIComponent(id), body, t.etag); }
        }
        toast(`${ids.length} tenant diperbarui`); invalidate('tenants-lite'); tbl.clearSel(); load(); ctx.refreshStatus();
      } }, 'Terapkan'),
      h('button.btn.ghost.sm', { onclick: () => tbl.clearSel() }, 'Batal'));
  }
  function exportLocal() {
    const cols = ['id', 'displayName', 'brand', 'category', 'floorId', 'building', 'unitNo', 'status', 'hoursMode', 'phone', 'url'];
    const csv = [cols.join(',')].concat(rows.map(r => [r.id, r.displayName, r.brand.name, r.brand.categoryId, r.floorId, r.building, r.unitNo, r.status, r.hoursMode, r.phone, r.urlOverride || r.brand.url].map(v => '"' + String(v ?? '').replace(/"/g, '""') + '"').join(','))).join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: 'tenants.csv' }); a.click();
  }
  await load();
  tbl.focus({ preventScroll: true });
}
