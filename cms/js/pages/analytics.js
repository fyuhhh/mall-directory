// Analytics — §2.16 / §7.2 #17: date & kiosk filters, stat tiles, daily bars (small multiples, one hue each),
// top searches, zero-result searches, tenants, routes per kiosk, QR funnel, promo impressions, uptime; CSV export.
import { h, ic, btn, badge, pageHead, input, select, table, toast, clear, card, fmtNum, emptyState, loading, HARI_S } from '../ui.js';
import { api, apiUrl, lookups, MOCK } from '../api.js';

const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export default async function analytics(ctx) {
  ctx.setTitle('Analitik');
  const kiosks = await lookups.kiosks().catch(() => []);
  const to = new Date(), from = new Date(Date.now() - 6 * 864e5);
  const f = { from: ctx.query.get('from') || ymd(from), to: ctx.query.get('to') || ymd(to), kiosk: ctx.query.get('kiosk') || '' };
  const fIn = input({ type: 'date', value: f.from, sm: true, 'aria-label': 'Dari' }), tIn = input({ type: 'date', value: f.to, sm: true, 'aria-label': 'Sampai' });
  const kSel = select([['', 'Semua kiosk'], ...kiosks.map(k => [k.id, k.name])], f.kiosk, { sm: true, 'aria-label': 'Kiosk' });
  const quick = (days, label) => h('button', { type: 'button', class: 'chip', onclick: () => { fIn.value = ymd(new Date(Date.now() - (days - 1) * 864e5)); tIn.value = ymd(new Date()); apply(); } }, label);
  ctx.root.append(pageHead('Analitik', 'Data anonim (IP HP di-hash harian, UU PDP). Raw 180 hari; rollup harian selamanya.'),
    h('div.filters', h('span.small.muted', 'Periode'), fIn, h('span.muted', '–'), tIn, quick(7, '7 hari'), quick(30, '30 hari'), kSel));
  const body = h('div'); ctx.root.append(body);
  [fIn, tIn, kSel].forEach(e => e.addEventListener('change', apply));
  function apply() { f.from = fIn.value; f.to = tIn.value; f.kiosk = kSel.value; history.replaceState(null, '', '#/analytics?' + new URLSearchParams(f)); load(); }
  const csv = report => h('a.btn.sm.ghost', { href: MOCK ? null : apiUrl('/admin/analytics/export.csv?' + new URLSearchParams(Object.assign({ report }, f))), title: 'Export CSV', onclick: MOCK ? e => { e.preventDefault(); toast('Export CSV tersedia saat API aktif', 'info'); } : null }, ic('download'), 'CSV');

  async function load() {
    clear(body).append(loading());
    const q = { from: f.from, to: f.to, kiosk: f.kiosk };
    const get = (p, extra) => api.get('/analytics/' + p, Object.assign({}, q, extra || {}), { silent: true }).then(r => r.data).catch(() => null);
    const [sum, searches, zero, tenants, routes, qr, promos, uptime] = await Promise.all([get('summary'), get('searches'), get('searches', { zero: 1 }), get('tenants'), get('routes'), get('qr'), get('promos'), get('uptime')]);
    clear(body);
    if (!sum) { body.append(emptyState('Analitik belum tersedia', 'chart-column')); return; }
    const tile = (label, v, d) => h('div.card.stat', h('div.kicker', label), h('div.v', v), d ? h('div.d', d) : null);
    body.append(h('div.grid.g4', tile('Sesi', fmtNum(sum.sessions), `${fmtNum(sum.searches)} pencarian`), tile('Rute diminta', fmtNum(sum.routes), `${(sum.routesAccessiblePct ?? 0).toLocaleString('id-ID')}% mode kursi roda`),
      tile('Scan QR ke HP', fmtNum(sum.qrScans), `dari ${fmtNum(sum.qrShown)} QR tampil`), tile('Impresi promo', fmtNum(sum.promoImpressions), `${fmtNum(sum.promoTaps)} tap`)));
    const series = sum.series || [];
    const grid = h('div.grid.g2', { style: { marginTop: '16px' } });
    grid.append(card('Sesi per hari', barChart(series, 'sessions', 'var(--ink)')), card('Rute per hari', barChart(series, 'routes', 'var(--accent)')));
    body.append(grid);
    const g2 = h('div.grid.g2', { style: { marginTop: '16px', alignItems: 'start' } });
    g2.append(card('Pencarian teratas', hbars((searches || []).map(s => ({ label: '“' + s.query + '”', v: s.count, sub: s.avgResults === 0 ? '0 hasil' : null }))), { actions: [csv('searches')] }),
      card('Pencarian tanpa hasil', h('div.stack', hbars((zero || []).map(s => ({ label: '“' + s.query + '”', v: s.count })), 'var(--warn)'), h('p.small.muted', 'Bahan keyword: tambahkan ke tenant/fasilitas terkait, mis. "toilet", "atm", "musholla" → buat fasilitas.')), { actions: [csv('searches_zero')] }),
      card('Tenant paling dilihat', table({ rows: tenants || [], keyFn: r => r.tenantId, compact: true, columns: [
        { key: 'name', label: 'Tenant', render: r => h('a', { href: '#/tenants/' + r.tenantId }, r.name || r.tenantId) }, { key: 'views', label: 'Dilihat', cls: 'num', sort: true, render: r => fmtNum(r.views) }, { key: 'routes', label: 'Rute', cls: 'num', sort: true, render: r => fmtNum(r.routes) }] }), { actions: [csv('tenants')], flush: true }),
      card('Rute per kiosk', table({ rows: routes || [], keyFn: r => r.kioskId, compact: true, columns: [
        { key: 'name', label: 'Kiosk' }, { key: 'routes', label: 'Rute', cls: 'num', sort: true, render: r => fmtNum(r.routes) }, { key: 'accessiblePct', label: '% kursi roda', cls: 'num', render: r => (r.accessiblePct ?? 0).toLocaleString('id-ID') + '%' },
        { key: 'fail', label: 'Gagal', cls: 'num', render: r => r.fail ? h('b', { style: { color: 'var(--danger)' } }, String(r.fail)) : '0' }] }), { actions: [csv('routes')], flush: true }));
    body.append(g2);
    const g3 = h('div.grid.g2', { style: { marginTop: '16px', alignItems: 'start' } });
    if (qr) {
      const steps = [['QR tampil di kiosk', qr.shown], ['Dipindai HP', qr.scanned], ['Mulai navigasi', qr.navStart], ['Tiba di tujuan', qr.arrived]];
      g3.append(card('Konversi kiosk → HP', h('div.funnel', steps.map(([l, v]) => h('div.st', { title: `${l}: ${fmtNum(v)}` }, h('span', l), h('div.bar', h('i', { style: { width: (100 * v / Math.max(1, qr.shown)) + '%' } })), h('b.num', { style: { textAlign: 'right' } }, fmtNum(v)))),
        h('div.small.muted', `Kompas ditolak: ${fmtNum(qr.compassDenied)} · konversi scan ${(100 * qr.scanned / Math.max(1, qr.shown)).toFixed(1).replace('.', ',')}%`)), { actions: [csv('qr')] }));
    }
    g3.append(card('Promo (laporan pengiklan)', table({ rows: promos || [], keyFn: r => r.promoId, compact: true, empty: 'Belum ada impresi', columns: [
      { key: 'title', label: 'Promo', render: r => h('a', { href: '#/promos/' + r.promoId }, r.title) }, { key: 'impressions', label: 'Impresi', cls: 'num', sort: true, render: r => fmtNum(r.impressions) },
      { key: 'taps', label: 'Tap', cls: 'num', render: r => fmtNum(r.taps) }, { key: 'ctr', label: 'CTR', cls: 'num', render: r => (r.ctr ?? 0).toLocaleString('id-ID') + '%' }] }), { actions: [csv('promos')], flush: true }));
    body.append(g3);
    if (uptime && uptime.length) {
      const days = uptime[0].days.map(d => d.day);
      const ut = h('div', { style: { display: 'grid', gridTemplateColumns: `180px repeat(${days.length}, minmax(0,1fr)) 70px`, gap: '4px', alignItems: 'center', fontSize: '12.5px' } },
        h('span'), days.map(d => h('span.muted.small', { style: { textAlign: 'center' } }, d.slice(8) + '/' + d.slice(5, 7))), h('span.muted.small', { style: { textAlign: 'right' } }, 'Rata²'));
      uptime.forEach(k => {
        const avg = k.days.reduce((a, b) => a + b.pct, 0) / k.days.length;
        ut.append(h('a', { href: '#/kiosks/' + k.kioskId, style: { fontWeight: 650, color: 'inherit' } }, k.name),
          k.days.map(d => h('span', { title: `${k.name} ${d.day}: ${d.pct}%`, style: { height: '26px', borderRadius: '4px', background: d.pct >= 95 ? 'var(--ok)' : d.pct >= 50 ? '#E08A1E' : 'var(--danger)', opacity: d.pct >= 95 ? .35 + .65 * (d.pct - 95) / 5 : 1, display: 'grid', placeItems: 'center', color: d.pct >= 99 ? '#fff' : d.pct >= 95 ? 'var(--ink)' : '#fff', fontSize: '11px', fontWeight: 700 } }, d.pct >= 99.95 ? '' : Math.round(d.pct))),
          h('b.num', { style: { textAlign: 'right' } }, avg.toFixed(1).replace('.', ',') + '%'));
      });
      body.append(h('div', { style: { marginTop: '16px' } }, card('Uptime kiosk per hari', h('div.stack', ut, h('div.small.muted', 'Hijau ≥ 95% · oranye 50–95% · merah < 50%. Angka tampil bila < 100%.')), { actions: [csv('uptime')] })));
    }
  }
  function barChart(series, key, color) {
    if (!series.length) return emptyState('Belum ada data');
    const max = Math.max(...series.map(s => s[key])) || 1;
    return h('div.vchart', series.map(s => { const d = new Date(s.day + 'T00:00:00'); return h('div.col', { title: `${s.day}: ${fmtNum(s[key])}` },
      h('span.num', { style: { fontSize: '11px', color: 'var(--ink-2)' } }, fmtNum(s[key])),
      h('i', { style: { height: `calc(${(100 * s[key] / max).toFixed(1)}% - 34px)`, background: color, borderRadius: '4px 4px 0 0' } }),
      h('span', `${HARI_S[(d.getDay() + 6) % 7]} ${d.getDate()}`)); }));
  }
  function hbars(rows, color = 'var(--ink)') {
    if (!rows.length) return emptyState('Belum ada data');
    const max = Math.max(...rows.map(r => r.v)) || 1;
    return h('div.hbar', rows.slice(0, 10).map(r => [h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.label, r.sub ? h('span.small.muted', ' · ' + r.sub) : null),
      h('div.bar', { title: `${r.label}: ${fmtNum(r.v)}` }, h('i', { style: { width: (100 * r.v / max) + '%', background: color } })), h('b.num', { style: { textAlign: 'right' } }, fmtNum(r.v))]));
  }
  await load();
}
