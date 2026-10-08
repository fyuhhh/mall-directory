// Dashboard — §7.2 #2
import { h, ic, badge, card, pageHead, fmtDate, relTime, fmtNum, btn, toast, emptyState, assetUrl } from '../ui.js';
import { api, lookups } from '../api.js';
import { state, can, floorName } from '../state.js';
import { kioskState, perfBadge, closureText, CLIENT_LABEL } from '../widgets.js';

export default async function dashboard(ctx) {
  ctx.setTitle('Dashboard');
  const me = state.me;
  const root = ctx.root;
  const hour = new Date().getHours();
  const greet = hour < 11 ? 'Selamat pagi' : hour < 15 ? 'Selamat siang' : hour < 19 ? 'Selamat sore' : 'Selamat malam';
  root.append(pageHead(`${greet}, ${me.user.name.split(' ')[0]}`, 'Ringkasan direktori kiosk e-Walk & Pentacity hari ini.', [
    can('publish.content') || can('publish.map') ? h('a.btn', { href: '#/publish' }, ic('shield-check'), 'Validasi & publish') : null]));

  const [kiosks, closures, validation, floors, missLogo, missHours, missPlace, searches, zero, settings] = await Promise.all([
    lookups.kiosks().catch(() => []),
    api.get('/closures', { active: 1 }, { silent: true }).then(r => r.data).catch(() => []),
    api.get('/validate/last', null, { silent: true }).then(r => r.data).catch(() => null),
    lookups.floors().catch(() => []),
    api.get('/tenants', { missing: 'logo', per: 1 }, { silent: true }).then(r => r.total).catch(() => null),
    api.get('/tenants', { missing: 'hours', per: 1 }, { silent: true }).then(r => r.total).catch(() => null),
    api.get('/tenants', { missing: 'placement', per: 1 }, { silent: true }).then(r => r.total).catch(() => null),
    can('analytics.view') ? api.get('/analytics/searches', { days: 7 }, { silent: true }).then(r => r.data).catch(() => []) : [],
    can('analytics.view') ? api.get('/analytics/searches', { days: 7, zero: 1 }, { silent: true }).then(r => r.data).catch(() => []) : [],
    api.get('/settings', null, { silent: true }).then(r => r.data).catch(() => ({})),
  ]);
  const fl = Object.fromEntries(floors.map(f => [f.id, f]));
  const cnt = s => kiosks.filter(k => (k.runtime || {}).state === s).length;
  const live = me.live || {};
  const unpub = me.unpublished || {};
  const unpubParts = [unpub.content && 'Konten', unpub.map && 'Peta', unpub.promos && 'Promo'].filter(Boolean);

  // --- stat row
  const vTone = !validation ? '' : validation.errors.length ? 'danger' : validation.warnings.length ? 'warn' : 'ok';
  root.append(h('div.grid.g4',
    statCard('Kiosk online', h('span', cnt('online'), h('small', '/ ' + kiosks.length)), [cnt('stale') ? `${cnt('stale')} versi lama` : null, cnt('offline') ? `${cnt('offline')} offline` : null].filter(Boolean).join(' · ') || 'Semua sehat', cnt('offline') ? 'danger' : cnt('stale') ? 'warn' : 'ok', '#/kiosks'),
    statCard('Penutupan aktif', closures.length, closures.length ? 'Eskalator/lift sedang ditutup' : 'Semua konektor beroperasi', closures.length ? 'warn' : 'ok', '#/ops'),
    statCard('Validasi terakhir', validation ? (validation.errors.length ? `${validation.errors.length} error` : 'Lolos') : '—',
      validation ? `${validation.warnings.length} peringatan · ${relTime(validation.ranAt)}` : 'Belum pernah dijalankan', vTone, '#/publish'),
    statCard('Belum dipublish', unpubParts.length ? unpubParts.join(' · ') : 'Tidak ada', unpubParts.length ? 'Draft berbeda dengan rilis live' : 'Draft = live', unpubParts.length ? 'warn' : 'ok', '#/publish')));

  // --- release banner
  if (live.directory && live.directory.rolledBackFrom) {
    root.append(h('div.callout.warn', { style: { marginTop: '16px' } }, ic('history'), h('div', h('b', `Live = rollback ke ${live.directory.rolledBackFrom}; draft berbeda.`), ' Publish berikutnya akan menimpa rilis rollback ini.')));
  }

  const grid = h('div.grid', { style: { gridTemplateColumns: 'minmax(0,1.6fr) minmax(0,1fr)', marginTop: '16px', alignItems: 'start' } });
  root.append(grid);
  const left = h('div.stack', { style: { gap: '16px' } }), right = h('div.stack', { style: { gap: '16px' } });
  grid.append(left, right);

  // --- kiosks
  const kgrid = h('div.grid.g2', { style: { gap: '10px' } });
  kiosks.forEach(k => {
    const rt = k.runtime || {};
    kgrid.append(h('a.card', { href: '#/kiosks/' + k.id, style: { padding: '12px 14px', textDecoration: 'none', color: 'inherit', boxShadow: 'none' } },
      h('div.row', h('b.grow', { style: { fontSize: '14px' } }, k.name), kioskState(k)),
      h('div.small.muted', { style: { margin: '2px 0 8px' } }, `${floorName(fl[k.floorId])} · ${CLIENT_LABEL[k.clientType]} · ${rt.lastSeenAt ? 'terakhir ' + relTime(rt.lastSeenAt) : 'belum pernah ping'}`),
      h('div.row.wrap', { style: { gap: '6px' } }, perfBadge(k),
        rt.swActive === false ? badge('Tanpa Service Worker', 'danger', 'triangle-alert') : null,
        rt.state === 'stale' ? badge('Data ' + (rt.dataVersion || '').split('-')[0], 'warn') : null,
        k.facingDeg == null ? badge('Arah hadap kosong', '', 'compass') : null)));
  });
  left.append(card('Status kiosk', kiosks.length ? kgrid : emptyState('Belum ada kiosk'), { actions: [h('a.btn.sm.ghost', { href: '#/kiosks' }, 'Kelola', ic('chevron-right'))] }));

  // --- closures
  const cl = h('ul.list-plain');
  closures.forEach(c => cl.append(h('li', h('span.cat-ic', { style: { background: 'var(--warn-soft)', color: 'var(--warn)' } }, ic('wrench')),
    h('div.grow', h('div', { style: { fontWeight: 650 } }, c.target.label), h('div.small.muted', closureText(c) + ' · oleh ' + (c.createdBy || '—'))),
    h('a.btn.sm', { href: '#/ops' }, 'Ops'))));
  left.append(card('Penutupan aktif (status live)', closures.length ? cl : emptyState('Semua eskalator & lift beroperasi', 'circle-check'), { actions: [h('a.btn.sm.ghost', { href: '#/ops' }, 'Status Ops', ic('chevron-right'))] }));

  // --- searches
  if (can('analytics.view')) {
    const mk = (rows, zeroMode) => rows.length ? h('ol', { style: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '6px' } },
      rows.slice(0, 5).map(r => h('li', h('div.row', h('span.grow', '“' + r.query + '”'), h('span.num.muted', fmtNum(r.count) + '×'))))) : emptyState('Belum ada data');
    left.append(h('div.grid.g2', card('Pencarian teratas · 7 hari', mk(searches)), card('Pencarian tanpa hasil · 7 hari', h('div', mk(zero, true), zero.length ? h('p.small.muted', { style: { marginTop: '10px' } }, 'Tambahkan sebagai keyword tenant atau fasilitas.') : null))));
  }

  // --- releases
  const rel = h('dl.kv',
    h('dt', 'Directory'), h('dd', live.directory ? h('span', h('b.mono', live.directory.version), h('div.small.muted', fmtDate(live.directory.publishedAt))) : '—'),
    h('dt', 'Promo'), h('dd', live.promos ? h('span', h('b.mono', live.promos.version), h('div.small.muted', fmtDate(live.promos.publishedAt))) : '—'),
    h('dt', 'Status live'), h('dd', live.status ? h('span', h('b.mono', live.status.version), h('div.small.muted', fmtDate(live.status.publishedAt))) : '—'));
  right.append(card('Rilis live', rel, { actions: [h('a.btn.sm.ghost', { href: '#/publish?tab=history' }, 'Riwayat', ic('chevron-right'))] }));

  // --- completeness
  const noFacing = kiosks.filter(k => k.facingDeg == null).length;
  const noNorth = settings['map.northDeg'] == null ? floors.filter(f => f.northDeg == null).length : 0;
  const rows = [
    ['Tenant tanpa logo', missLogo, '#/tenants?missing=logo', 'image'],
    ['Tenant tanpa jam buka', missHours, '#/tenants?missing=hours', 'clock'],
    ['Tenant belum ditempatkan', missPlace, '#/tenants?missing=placement', 'map-pin'],
    ['Kiosk tanpa arah hadap', noFacing, '#/kiosks', 'compass'],
    ['Lantai tanpa arah utara', noNorth, '#/floors', 'navigation'],
  ];
  const comp = h('ul.list-plain');
  rows.forEach(([l, n, href, icn]) => comp.append(h('li', h('span.cat-ic', { style: { background: n ? 'var(--warn-soft)' : 'var(--ok-soft)', color: n ? 'var(--warn)' : 'var(--ok)', width: '28px', height: '28px', fontSize: '15px' } }, ic(icn)),
    h('a.grow', { href, style: { color: 'inherit' } }, l), h('b.num', n == null ? '—' : fmtNum(n)))));
  right.append(card('Kelengkapan data', comp));

  // --- validation summary
  if (validation) {
    const st = validation.stats || {};
    right.append(card('Jangkauan rute', h('div.stack', { style: { gap: '10px' } },
      meter('Rute biasa', st.reachablePct), meter('Rute kursi roda', st.accessiblePct),
      h('div.small.muted', `${fmtNum(st.pairs)} pasangan kiosk→tenant · dicek ${relTime(validation.ranAt)}${validation.by ? ' oleh ' + validation.by : ''}`))));
  }
}

function statCard(label, value, desc, tone, href) {
  return h('a.card.stat', { href, style: { textDecoration: 'none', color: 'inherit' } },
    h('div.row', h('span.kicker.grow', label), tone ? h('span', { class: 'dot ' + tone }) : null),
    h('div', { class: 'v' + (typeof value === 'string' && !/^\d/.test(value) ? ' txt' : '') }, value), h('div.d', desc));
}
function meter(label, pct) {
  pct = pct == null ? 0 : pct;
  return h('div', h('div.row', { style: { marginBottom: '5px', fontSize: '13px' } }, h('span.grow', label), h('b.num', pct.toLocaleString('id-ID') + '%')),
    h('div', { class: 'bar' + (pct >= 99.5 ? ' ok' : '') }, h('i', { style: { width: pct + '%' } })));
}
