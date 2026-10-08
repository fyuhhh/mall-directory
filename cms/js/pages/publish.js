// Publish — §2.14 / §2.15 / §7.2 #16: validate (errors block, warnings don't; reachability per kiosk default + accessible),
// diff per section, notes, publish; promo channel; history with download & rollback.
import { h, ic, btn, badge, pageHead, textarea, tabs, table, toast, dialog, confirmDlg, clear, card, fmtDate, relTime, fmtNum, fmtBytes, loading, emptyState } from '../ui.js';
import { api, apiUrl, lookups, MOCK } from '../api.js';
import { state, can } from '../state.js';

const CODE_LABEL = {
  E_REF: 'Referensi rusak', E_BOUNDS: 'Titik di luar denah', E_NODE_FLOOR: 'Node beda lantai', E_EDGE_FLOOR: 'Edge lintas lantai', E_LEG_LEVEL: 'Level leg salah', E_URL: 'URL bukan https', E_REACH: 'Tenant tak terjangkau',
  W_REACH_RETURN: 'Tidak bisa kembali ke kiosk', W_REACH_ACC: 'Tak terjangkau kursi roda', W_REACH_NOW: 'Tertutup saat ini', W_ESC_SPAN: 'Eskalator lompat level', W_STOP_DANGLING: 'Stop buntu',
  W_COMPONENT: 'Komponen terisolasi', W_POI_NODE: 'Node POI = node stop', W_UNIT_MISSING: 'Unit SVG hilang', W_NO_LOGO: 'Tanpa logo', W_NO_HOURS: 'Tanpa jam', W_NO_FACING: 'Kiosk tanpa arah hadap', W_NO_NORTH: 'Arah utara kosong', W_SCHEDULE_GAP: 'Jadwal tutup di jam mall' };
export function refHref(ref) {
  if (!ref) return null;
  switch (ref.type) {
    case 'tenant': return '#/tenants/' + encodeURIComponent(ref.id);
    case 'kiosk': return '#/kiosks/' + encodeURIComponent(ref.id);
    case 'stop': case 'leg': case 'bank': return '#/connectors' + (ref.bankId ? '/' + ref.bankId : ref.type === 'bank' ? '/' + ref.id : '');
    case 'amenity': return '#/amenities';
    case 'floor': return '#/floors?id=' + ref.id;
    case 'node': case 'edge': return '#/graph' + (ref.floor ? '?floor=' + ref.floor : '');
    case 'settings': return '#/settings';
    case 'category': return '#/categories';
    default: return null;
  }
}

export default async function publish(ctx) {
  ctx.setTitle('Publish');
  let tab = ctx.query.get('tab') || 'directory';
  const canDir = can('publish.content') || can('publish.map'), canPromo = can('publish.promos'), canRb = can('releases.rollback');
  ctx.root.append(pageHead('Publish', 'Draft (database) → Validasi → Pratinjau perubahan → Publish → Kiosk memuat ulang saat idle.'));
  const bar = tabs([{ key: 'directory', label: 'Directory', icon: 'map' }, { key: 'promos', label: 'Promo', icon: 'megaphone' }, { key: 'history', label: 'Riwayat & rollback', icon: 'history' }], tab, k => { tab = k; history.replaceState(null, '', '#/publish?tab=' + k); show(); });
  const body = h('div'); ctx.root.append(bar, body);
  const kiosks = await lookups.kiosks().catch(() => []);
  const kName = Object.fromEntries(kiosks.map(k => [k.id, k.name]));
  function show() { clear(body); if (tab === 'history') history_(); else channel(tab); }

  async function channel(ch) {
    body.append(loading('Menyusun kandidat & menjalankan validasi…'));
    let pv;
    try { pv = (await api.get('/publish/preview', { channel: ch })).data; } catch (e) { clear(body).append(h('div.callout.danger', ic('circle-alert'), 'Gagal memuat pratinjau: ' + e.message)); return; }
    clear(body);
    const live = state.me.live && state.me.live[ch];
    const v = pv.validation || { errors: [], warnings: [] };
    const allowed = ch === 'promos' ? canPromo : canDir;
    const notes = textarea({ rows: 2, placeholder: 'Catatan rilis (opsional) — mis. "Koreksi arah Eskalator A GF↔UG, 3 tenant baru"' });
    const pubBtn = btn(`Publish ${ch === 'promos' ? 'promo' : 'directory'}`, { icon: 'rocket', kind: 'primary', size: 'lg', disabled: !allowed || !pv.canPublish || v.errors.length > 0 || !(pv.sectionsChanged || []).length });
    pubBtn.addEventListener('click', async () => {
      if (!(await confirmDlg(h('div', h('p', `Publish ${pv.candidateVersion}? Semua kiosk akan mengunduh lalu memuat ulang saat layar atraksi (idle).`), v.warnings.length ? h('p.small.muted', `${v.warnings.length} peringatan tidak memblokir.`) : null), { title: 'Publish', ok: 'Publish sekarang' }))) return;
      pubBtn.disabled = true;
      try { const r = await api.post('/publish', { channel: ch === 'promos' ? 'promos' : 'directory', notes: notes.value || null }); toast(`Terpublish ${r.data.release.version} — kiosk memuat ulang saat idle`); await ctx.refreshStatus(); show(); }
      catch (e) { pubBtn.disabled = false; }
    });
    const head = h('div.card', { style: { padding: '16px 18px' } }, h('div.row.wrap', { style: { gap: '18px' } },
      h('div', h('div.kicker', 'Live'), h('div.mono', { style: { fontWeight: 700, fontSize: '15px', marginTop: '3px' } }, live ? live.version : '—'), h('div.small.muted', live ? fmtDate(live.publishedAt) : '')),
      h('span', { style: { fontSize: '22px', color: 'var(--muted)' } }, '→'),
      h('div', h('div.kicker', 'Kandidat'), h('div.mono', { style: { fontWeight: 700, fontSize: '15px', marginTop: '3px' } }, pv.candidateVersion || '—'), h('div.small.muted', (pv.sectionsChanged || []).length ? 'Seksi berubah: ' + pv.sectionsChanged.map(s => ({ content: 'konten', map: 'peta', promos: 'promo' }[s] || s)).join(' · ') : 'Tidak ada perubahan')),
      h('span.grow'),
      ch !== 'promos' ? btn('Jalankan ulang validasi', { icon: 'refresh-cw', onClick: () => show() }) : null));
    body.append(head);
    if (live && live.rolledBackFrom) body.append(h('div.callout.warn', { style: { marginTop: '12px' } }, ic('history'), `Live = rollback ke ${live.rolledBackFrom}; draft berbeda. Publish berikutnya akan menggantikannya.`));
    (pv.blockers || []).forEach(b => body.append(h('div.callout.danger', { style: { marginTop: '12px' } }, ic('lock'), b)));
    if (!allowed) body.append(h('div.callout.warn', { style: { marginTop: '12px' } }, ic('lock'), 'Peran Anda tidak punya izin publish kanal ini.'));

    const grid = h('div.grid', { style: { gridTemplateColumns: 'minmax(0,1.25fr) minmax(0,1fr)', marginTop: '16px', alignItems: 'start' } });
    body.append(grid);
    const left = h('div.stack', { style: { gap: '16px' } }), right = h('div.stack', { style: { gap: '16px' } });
    grid.append(left, right);
    left.append(validationCard(v, ch));
    if (ch !== 'promos' && v.stats) left.append(reachCard(v));
    right.append(diffCard(pv.diff || {}, ch));
    right.append(card('Publish', h('div.stack', notes, h('div.row', pubBtn, h('span.small.muted', v.errors.length ? 'Perbaiki error validasi dulu.' : !(pv.sectionsChanged || []).length ? 'Draft sama dengan live.' : 'Error memblokir; peringatan tidak.')))));
  }

  function validationCard(v, ch) {
    const wrap = h('div.stack', { style: { gap: '10px' } });
    wrap.append(h('div.row.wrap', { style: { gap: '8px' } },
      v.errors.length ? badge(`${v.errors.length} error`, 'danger', 'circle-x') : badge('0 error', 'ok', 'circle-check'),
      v.warnings.length ? badge(`${v.warnings.length} peringatan`, 'warn', 'triangle-alert') : badge('0 peringatan', 'ok'),
      v.ms != null ? h('span.small.muted', `${v.ms} ms`) : null, v.ranAt ? h('span.small.muted', '· ' + relTime(v.ranAt)) : null));
    if (v.errors.length) wrap.append(h('ul.list-plain', v.errors.map(e => issueLi(e, 'danger'))));
    const groups = {};
    v.warnings.forEach(w => (groups[w.code] = groups[w.code] || []).push(w));
    Object.entries(groups).forEach(([code, ws]) => {
      const det = h('details', { open: ws.length <= 3 }, h('summary', { style: { cursor: 'pointer', padding: '6px 0', display: 'flex', gap: '8px', alignItems: 'center' } }, badge(String(ws.length), 'warn'), h('b.mono.small', code), h('span', CODE_LABEL[code] || '')),
        h('ul.list-plain', { style: { paddingLeft: '8px' } }, ws.slice(0, 50).map(w => issueLi(w, 'warn'))));
      wrap.append(det);
    });
    if (!v.errors.length && !v.warnings.length) wrap.append(h('div.callout.ok', ic('circle-check'), 'Tidak ada masalah.'));
    return card(ch === 'promos' ? 'Validasi promo' : 'Validasi (port verify_routes.py)', wrap);
  }
  function issueLi(it, tone) {
    const href = refHref(it.ref);
    return h('li', { style: { padding: '6px 0' } }, h('span', { class: 'dot ' + tone }), h('div.grow', { style: { fontSize: '13px' } }, href ? h('a', { href }, it.msg) : it.msg), h('span.mono.small.muted', it.code));
  }
  function reachCard(v) {
    const st = v.stats; const per = st.perKiosk || {};
    const accU = v.unreachableAccessible || {};
    const rows = Object.keys(per).length ? Object.entries(per).map(([id, x]) => ({ id, ...x })) : kiosks.map(k => ({ id: k.id, total: null }));
    const bar = (n, t) => t ? h('div.row', { style: { gap: '8px' } }, h('div', { class: 'bar grow' + (n === t ? ' ok' : ''), style: { minWidth: '80px' } }, h('i', { style: { width: (100 * n / t) + '%', background: n === t ? null : 'var(--warn)' } })), h('span.num.small', { style: { width: '62px', textAlign: 'right' } }, `${n}/${t}`)) : h('span.muted', '—');
    return card('Jangkauan per kiosk', h('div.stack',
      h('div.row.wrap', { style: { gap: '18px' } }, h('div', h('div.kicker', 'Rute biasa'), h('div', { style: { fontSize: '22px', fontWeight: 750 } }, (st.reachablePct ?? 0).toLocaleString('id-ID') + '%'), h('div.small.muted', `${fmtNum(st.reachable)}/${fmtNum(st.pairs)} pasangan`)),
        h('div', h('div.kicker', 'Kursi roda'), h('div', { style: { fontSize: '22px', fontWeight: 750 } }, (st.accessiblePct ?? 0).toLocaleString('id-ID') + '%')),
        h('div', h('div.kicker', 'Gagal kembali'), h('div', { style: { fontSize: '22px', fontWeight: 750 } }, fmtNum(st.returnFail ?? 0)))),
      table({ rows, keyFn: r => r.id, compact: true, columns: [
        { key: 'id', label: 'Kiosk', render: r => h('a', { href: '#/kiosks/' + r.id }, kName[r.id] || r.id) },
        { key: 'default', label: 'Rute biasa', render: r => bar(r.default, r.total) },
        { key: 'accessible', label: 'Kursi roda', render: r => bar(r.accessible, r.total) }] }),
      Object.keys(accU).length ? h('details', h('summary', { style: { cursor: 'pointer' } }, `${Object.keys(accU).length} tenant tak terjangkau kursi roda dari sebagian kiosk`),
        h('ul.list-plain', Object.entries(accU).slice(0, 40).map(([t, ks]) => h('li', h('a.grow', { href: '#/tenants/' + t }, t), h('span.small.muted', ks.map(k => kName[k] || k).join(', ')))))) : null));
  }
  function diffCard(diff, ch) {
    const wrap = h('div.stack', { style: { gap: '12px' } });
    const sec = (title, obj) => {
      if (!obj) return;
      const items = [];
      for (const [k, v] of Object.entries(obj)) {
        if (v == null) continue;
        if (Array.isArray(v.added) || Array.isArray(v.removed) || Array.isArray(v.changed)) {
          const a = v.added || [], r = v.removed || [], c = v.changed || [];
          if (!a.length && !r.length && !c.length) continue;
          items.push(h('div', h('div.row', { style: { gap: '6px', marginBottom: '4px' } }, h('b', k), a.length ? badge('+' + a.length, 'ok') : null, r.length ? badge('−' + r.length, 'danger') : null, c.length ? badge('~' + c.length, 'info') : null),
            h('ul', { style: { margin: 0, paddingLeft: '18px', fontSize: '12.5px', display: 'grid', gap: '2px' } },
              a.slice(0, 12).map(x => h('li', h('span', { style: { color: 'var(--ok)' } }, '+ '), typeof x === 'object' ? (x.label || x.id) : String(x))),
              r.slice(0, 12).map(x => h('li', h('span', { style: { color: 'var(--danger)' } }, '− '), typeof x === 'object' ? (x.label || x.id) : String(x))),
              c.slice(0, 20).map(x => typeof x === 'object' ? h('li', h('span', { style: { color: 'var(--accent)' } }, '~ '), x.label || x.id, x.fields ? h('span.muted', ' · ' + x.fields.join(', ')) : null) : h('li', '~ ' + x)))));
        } else if (typeof v === 'object') {
          const parts = Object.entries(v).filter(([, n]) => n && typeof n !== 'object').map(([kk, n]) => `${{ added: 'tambah', removed: 'hapus', moved: 'pindah', changed: 'ubah' }[kk] || kk} ${n === true ? '' : n}`);
          if (parts.length) items.push(h('div.row', h('b', k), h('span.small.muted', parts.join(' · '))));
        }
      }
      wrap.append(h('div', h('div.section-t', title), items.length ? h('div.stack', { style: { gap: '8px', marginTop: '8px' } }, items) : h('div.small.muted', { style: { marginTop: '4px' } }, 'Tidak ada perubahan')));
    };
    if (ch === 'promos') sec('Promo', diff.promos); else { sec('Konten', diff.content); sec('Peta', diff.map); }
    return card('Perubahan dibanding live', wrap);
  }

  async function history_() {
    body.append(loading());
    const rels = (await api.get('/releases')).data;
    clear(body);
    const tbl = table({ rows: rels, keyFn: r => r.id, empty: 'Belum ada rilis', columns: [
      { key: 'version', label: 'Versi', render: r => h('div', h('b.mono', r.version), r.isLive ? h('span', { style: { marginLeft: '6px' } }, badge('LIVE', 'ok')) : null, r.rolledBackFrom ? h('div.t-sub', 'rollback dari #' + (r.rolledBackFromVersion || r.rolledBackFrom)) : null) },
      { key: 'channel', label: 'Kanal', render: r => badge(r.channel === 'promos' ? 'Promo' : r.channel === 'status' ? 'Status' : 'Directory', r.channel === 'promos' ? 'gold' : 'outline') },
      { key: 'createdAt', label: 'Waktu', sort: true, render: r => h('span.nowrap', fmtDate(r.createdAt)) },
      { key: 'createdBy', label: 'Oleh' },
      { key: 'notes', label: 'Catatan', render: r => h('span.small', r.notes || '—') },
      { key: 'bytes', label: 'Ukuran', cls: 'num', render: r => fmtBytes(r.bytes) },
      { key: 'act', label: '', render: r => h('div.row', { style: { justifyContent: 'flex-end', gap: '6px' } },
        h('a.btn.sm', { href: MOCK ? null : apiUrl(`/admin/releases/${r.id}/download`), title: 'Unduh JSON', onclick: MOCK ? e => { e.preventDefault(); toast('Unduh tidak tersedia di mode mock', 'info'); } : null }, ic('download')),
        canRb && !r.isLive ? btn('Rollback', { icon: 'rotate-ccw', size: 'sm', onClick: () => rollback(r) }) : null) }] });
    body.append(h('div.callout.muted', { style: { marginBottom: '12px' } }, ic('info'), 'Rollback menyalin file rilis lama ke live sebagai rilis BARU (versi naik → kiosk reload). Database/draft tidak ikut di-rollback.'), h('div.card', tbl));
  }
  async function rollback(r) {
    if (!(await confirmDlg(h('div', h('p', `Rollback ${r.channel} ke ${r.version}?`), h('p.small.muted', 'Live akan diganti dengan isi rilis ini sebagai rilis baru. Draft di database tidak berubah — dashboard akan menandai "draft berbeda".')), { title: 'Rollback', ok: 'Rollback', danger: true }))) return;
    const res = await api.post(`/releases/${r.id}/rollback`); toast(`Live sekarang ${res.data.release.version} (isi ${r.version})`); await ctx.refreshStatus(); show();
  }
  show();
}
