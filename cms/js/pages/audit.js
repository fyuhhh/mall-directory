// Audit log — §2.17 / §7.2 #18: read-only, filter entity / user / date, before→after diff.
import { h, ic, btn, badge, pageHead, input, select, table, dialog, clear, fmtDate, debounce } from '../ui.js';
import { api } from '../api.js';
import { refHref } from './publish.js';

const ENT = [['', 'Semua entitas'], ['tenant', 'Tenant'], ['category', 'Kategori'], ['floor', 'Lantai'], ['graph', 'Graph'], ['bank', 'Bank konektor'], ['leg', 'Leg'], ['stop', 'Stop'], ['kiosk', 'Kiosk'], ['amenity', 'Fasilitas'], ['promo', 'Promo'], ['event', 'Event'], ['featured', 'Featured'], ['i18n', 'Teks'], ['media', 'Media'], ['release', 'Rilis'], ['notice', 'Pengumuman'], ['user', 'User'], ['setting', 'Setting']];
const ACT_TONE = { create: 'ok', delete: 'danger', publish: 'info', rollback: 'warn', closure_start: 'warn', closure_end: 'ok', login_fail: 'danger' };

export default async function audit(ctx) {
  ctx.setTitle('Audit log');
  ctx.root.append(pageHead('Audit log', 'Semua perubahan admin (retensi 2 tahun). Hanya-baca.'));
  const f = { entity: ctx.query.get('entity') || '', user: '', from: '', to: '', page: 1 };
  const eSel = select(ENT, f.entity, { sm: true, 'aria-label': 'Entitas' });
  const uIn = input({ type: 'search', placeholder: 'Nama user…', sm: true, style: { width: '180px' } });
  const fIn = input({ type: 'date', sm: true, 'aria-label': 'Dari' }), tIn = input({ type: 'date', sm: true, 'aria-label': 'Sampai' });
  const info = h('span.small.muted');
  ctx.root.append(h('div.filters', eSel, uIn, fIn, h('span.muted', '–'), tIn, info));
  const pager = h('div.tbl-foot');
  const tbl = table({ rows: [], compact: true, onRow: detail, empty: 'Tidak ada catatan', columns: [
    { key: 'ts', label: 'Waktu', render: r => h('span.nowrap', fmtDate(r.ts, { year: false })) },
    { key: 'user', label: 'User', render: r => r.user || h('span.muted', 'Sistem/anonim') },
    { key: 'action', label: 'Aksi', render: r => badge(r.action, ACT_TONE[r.action] || '') },
    { key: 'entity', label: 'Entitas', render: r => { const href = refHref({ type: r.entityType === 'leg' || r.entityType === 'stop' ? 'bank' : r.entityType, id: r.entityId }); return h('span', h('span.muted', r.entityType + ' '), r.entityId ? (href && r.entityType === 'tenant' ? h('a.mono', { href }, r.entityId) : h('span.mono', r.entityId)) : ''); } },
    { key: 'summary', label: 'Ringkasan' },
    { key: 'ip', label: 'IP', render: r => h('span.mono.small.muted', r.ip || '') }] });
  ctx.root.append(h('div.card', tbl, pager));
  async function load() {
    const r = await api.get('/audit', { entity: f.entity, user: f.user, from: f.from, to: f.to, page: f.page, per: 50 });
    tbl.setRows(r.data); info.textContent = `${r.total ?? r.data.length} catatan`;
    const pages = Math.max(1, Math.ceil((r.total || r.data.length) / 50));
    clear(pager).append(h('span.grow', `Halaman ${f.page} dari ${pages}`), btn('', { icon: 'chevron-left', size: 'sm', title: 'Sebelumnya', disabled: f.page <= 1, onClick: () => { f.page--; load(); } }), btn('', { icon: 'chevron-right', size: 'sm', title: 'Berikutnya', disabled: f.page >= pages, onClick: () => { f.page++; load(); } }));
  }
  function detail(r) {
    const keys = [...new Set([...Object.keys(r.before || {}), ...Object.keys(r.after || {})])];
    const fmt = v => v == null ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    dialog({ title: r.summary || r.action, wide: true, body: h('div.stack', h('dl.kv', h('dt', 'Waktu'), h('dd', fmtDate(r.ts, { year: true })), h('dt', 'User'), h('dd', r.user || '—'), h('dt', 'IP'), h('dd.mono', r.ip || '—'), h('dt', 'Entitas'), h('dd.mono', `${r.entityType} ${r.entityId || ''}`)),
      keys.length ? table({ rows: keys.map(k => ({ k })), keyFn: x => x.k, compact: true, columns: [{ key: 'k', label: 'Field', render: x => h('span.mono', x.k) }, { key: 'b', label: 'Sebelum', render: x => h('span.mono.small', { style: { color: 'var(--danger)' } }, fmt((r.before || {})[x.k])) }, { key: 'a', label: 'Sesudah', render: x => h('span.mono.small', { style: { color: 'var(--ok)' } }, fmt((r.after || {})[x.k])) }] }) : h('p.muted', 'Tidak ada detail field.')) });
  }
  eSel.addEventListener('change', () => { f.entity = eSel.value; f.page = 1; load(); });
  uIn.addEventListener('input', debounce(() => { f.user = uIn.value.trim(); f.page = 1; load(); }, 250));
  [fIn, tIn].forEach(x => x.addEventListener('change', () => { f.from = fIn.value; f.to = tIn.value; f.page = 1; load(); }));
  await load();
}
