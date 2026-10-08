// Kiosks — §2.8 / §6.8 / §7.2 #10: list + map (position & facing dial), profile (client type, perf mode, languages),
// provisioning (token once + launch URL + .bat + QR), commands, runtime incl. UA / perfActive / swActive, uptime 7 days.
import { h, ic, btn, badge, pageHead, field, input, textarea, select, toggle, segmented, toast, dialog, confirmDlg, clear, card, svgEl,
  dirtyTracker, showFieldErrors, relTime, fmtDate, fmtNum, emptyState } from '../ui.js';
import { api, lookups, invalidate } from '../api.js';
import { can, floorName, BUILDING_LABEL } from '../state.js';
import { kioskState, perfBadge, CLIENT_LABEL, STATE_TONE, dial, qrSvg, copyText } from '../widgets.js';
import { MapCanvas, facingWedge, nearestNode } from '../mapcanvas.js';

export default async function kiosks(ctx) {
  ctx.setTitle('Kiosk');
  const canEdit = can('kiosks.edit'), canProv = can('kiosks.provision'), canCmd = can('kiosks.command');
  invalidate('kiosks');
  let [list, floors] = await Promise.all([lookups.kiosks(), lookups.floors()]);
  const flBy = Object.fromEntries(floors.map(f => [f.id, f]));
  let cur = list.find(k => k.id === ctx.params.id) || list[0];
  ctx.root.append(pageHead('Kiosk', `${list.length} titik "Anda di sini" · online = heartbeat < 3 menit`, [canEdit ? btn('Kiosk baru', { icon: 'plus', onClick: newKiosk }) : null]));
  const listEl = h('div.card'); const detail = h('div.stack', { style: { gap: '16px' } });
  ctx.root.append(h('div.split.l', h('div.sticky', listEl), detail));
  let mc = null; ctx.onLeave(() => mc && mc.destroy());

  function renderList() {
    clear(listEl);
    list.forEach(k => listEl.append(h('a', { href: '#/kiosks/' + k.id, style: { display: 'block', padding: '11px 14px', borderBottom: '1px solid var(--line)', color: 'inherit', textDecoration: 'none', background: cur && k.id === cur.id ? 'var(--accent-soft)' : null } },
      h('div.row', h('b.grow', k.name), kioskState(k)),
      h('div.small.muted', { style: { margin: '3px 0 6px' } }, `${floorName(flBy[k.floorId])} · ${k.id}`),
      h('div.row.wrap', { style: { gap: '5px' } }, perfBadge(k), (k.runtime || {}).swActive === false ? badge('SW mati', 'danger', 'triangle-alert') : null, k.isActive ? null : badge('Nonaktif', 'warn')))));
  }

  let tracker, draft;
  async function renderDetail() {
    clear(detail); if (mc) { mc.destroy(); mc = null; }
    if (!cur) { detail.append(emptyState('Belum ada kiosk')); return; }
    draft = JSON.parse(JSON.stringify(cur));
    const rt = cur.runtime || {};
    // header actions: commands
    const cmd = async (c, label) => {
      if (c === 'clear_cache' && !(await confirmDlg('Hapus cache Service Worker kiosk ini lalu muat ulang? Kiosk butuh server terjangkau untuk mengunduh ulang.', { ok: 'Hapus cache', danger: true }))) return;
      await api.post(`/kiosks/${cur.id}/commands`, { cmd: c }); toast(`Perintah "${label}" diantrikan — dijalankan pada ping berikutnya (≤ 60 dtk).`);
    };
    detail.append(h('div.card', { style: { padding: '14px 16px' } }, h('div.row.wrap', { style: { gap: '10px' } },
      h('div.grow', h('div.row', h('h2', { style: { fontSize: '19px' } }, cur.name), kioskState(cur)), h('div.small.muted', h('span.mono', cur.id), ' · ', floorName(flBy[cur.floorId]), ' · ', BUILDING_LABEL[cur.building])),
      canCmd ? h('div.btn-group', btn('Reload', { icon: 'refresh-cw', onClick: () => cmd('reload', 'Reload') }), btn('Identify', { icon: 'eye', title: 'Tampilkan ID kiosk 15 detik di layar', onClick: () => cmd('identify', 'Identify') }), btn('Hapus cache', { icon: 'trash-2', onClick: () => cmd('clear_cache', 'Hapus cache') })) : null)));

    // position + facing
    const mapHost = h('div', { style: { height: '420px', position: 'relative' } });
    let moving = false;
    const moveBtn = btn('Pindahkan', { icon: 'map-pin', size: 'sm', disabled: !canEdit, onClick: () => { moving = !moving; moveBtn.classList.toggle('primary', moving); mc.capture = moving; mc.setCursor(moving ? 'crosshair' : null); mc.hint(moving ? 'Klik lokasi kiosk — titik di-snap ke node graph terdekat.' : ''); } });
    const posInfo = h('div.small.muted');
    const facing = dial(draft.facingDeg, v => { draft.facingDeg = v; tracker.set(true); draw(); }, { disabled: !canEdit, label: 'hadap' });
    detail.append(card(h('div.row', h('h3', 'Posisi & arah hadap'), h('span.grow'), moveBtn), h('div.grid', { style: { gridTemplateColumns: 'minmax(0,1fr) 290px', gap: '18px' } },
      h('div.stack', mapHost, posInfo),
      h('div.stack', h('div.lbl', { style: { fontWeight: 650, fontSize: '12.5px' } }, 'Arah layar menghadap'), facing,
        h('p.small.muted', 'Derajat dari "atas" peta lantai. Dipakai HP untuk instruksi pertama ("dari layar ini, jalan ke kanan") — isi dari pengukuran lapangan §9.2.')))));
    const allowFloors = floors.filter(f => f.building === 'both' || f.building === draft.building || !draft.building);
    mc = new MapCanvas(mapHost, { floors: allowFloors, floorId: draft.floorId, height: '100%', onRender: draw });
    let graph = null;
    const loadGraph = async fid => { graph = (await api.get('/graph', { floor: fid })).data; graph.nodeBy = Object.fromEntries(graph.nodes.map(n => [n.id, n])); draw(); };
    mc.on('floor', (f, user) => { loadGraph(f.id); if (!user && draft.x != null) mc.centerOn(draft.x, draft.y, 420); });
    mc.on('click', pt => {
      if (!moving || !graph) return;
      const stops = new Set(graph.attachments.stops.map(s => s.nodeId));
      const nn = nearestNode(pt, graph.nodes, stops);
      const f = mc.floor;
      Object.assign(draft, { x: +pt.x.toFixed(2), y: +pt.y.toFixed(2), floorId: f.id, nodeId: nn ? nn.node.id : null });
      if (f.building !== 'both') draft.building = f.building;
      tracker.set(true); draw(); posText();
    });
    function draw() {
      if (!mc || !graph) return;
      const g = mc.layer('graph'), k = mc.layer('kiosks');
      for (const e of graph.edges) { const a = graph.nodeBy[e.a], b = graph.nodeBy[e.b]; if (a && b) g.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'ov-edge', style: 'opacity:.45' })); }
      for (const o of graph.attachments.kiosks) {
        const me = o.id === cur.id; const x = me ? draft.x : o.x, y = me ? draft.y : o.y; if (me && draft.floorId !== mc.floor.id) continue;
        const fd = me ? draft.facingDeg : o.facingDeg;
        if (fd != null) k.append(svgEl('path', { d: facingWedge(x, y, fd, mc.px(46)), class: 'ov-facing', style: me ? '' : 'opacity:.4' }));
        const nd = me && draft.nodeId && graph.nodeBy[draft.nodeId];
        if (nd) k.append(svgEl('line', { x1: x, y1: y, x2: nd.x, y2: nd.y, class: 'ov-link' }));
        k.append(svgEl('circle', { cx: x, cy: y, r: mc.px(me ? 9 : 6), class: 'ov-kiosk', style: me ? '' : 'opacity:.55' }, svgEl('title', { text: o.name || o.id })));
        k.append(svgEl('text', { x: x + mc.px(12), y: y + mc.px(4), 'font-size': mc.px(12), class: 'ov-label', text: (o.name || o.id) }));
      }
    }
    const posText = () => { clear(posInfo).append(`Lantai ${floorName(flBy[draft.floorId])} · x ${(+draft.x).toFixed(1)}, y ${(+draft.y).toFixed(1)} · node `, h('span.mono', draft.nodeId ? 'n' + draft.nodeId : '—')); };
    posText();

    // profile
    const segCT = segmented(Object.entries(CLIENT_LABEL).map(([v, l]) => ({ value: v, label: l, icon: v === 'smart_tv' ? 'tv' : v === 'windows_pc' ? 'monitor' : null })), draft.clientType, v => { draft.clientType = v; tracker.set(true); perfHint(); });
    const segPM = segmented([{ value: 'auto', label: 'Auto' }, { value: 'full', label: 'Full' }, { value: 'lite', label: 'Lite' }], draft.perfMode, v => { draft.perfMode = v; tracker.set(true); perfHint(); });
    if (!canEdit) [...segCT.children, ...segPM.children].forEach(b => b.disabled = true);
    const pHint = h('div.small.muted');
    const perfHint = () => { pHint.textContent = draft.perfMode === 'auto' ? (draft.clientType === 'smart_tv' ? 'Auto pada Smart TV dimulai dari lite; naik ke full bila perangkat kuat.' : 'Auto: lite bila deviceMemory ≤ 2, ≤ 4 core, Chromium < 90, tanpa backdrop-filter, atau frame > 25 ms.') : draft.perfMode === 'lite' ? 'Lite: tanpa blur/bayangan, animasi rute disederhanakan, promo video → poster.' : 'Full: semua animasi aktif (PC kiosk).'; };
    perfHint();
    const prof = h('div.form.cols-2',
      field('Nama', input({ name: 'name', value: draft.name, disabled: !canEdit }), { name: 'name', required: true }),
      field('ID (dipakai ?kiosk=)', input({ value: draft.id, disabled: true, class: 'inp mono' })),
      field('Jenis perangkat (client_type)', segCT, { span: 'span-2' }),
      field('Mode performa (perf_mode)', h('div.stack', { style: { gap: '6px' } }, segPM, pHint), { span: 'span-2' }),
      field('Bahasa UI default', select([['en', 'English'], ['id', 'Indonesia']], draft.defaultLang, { name: 'defaultLang', disabled: !canEdit })),
      field('Bahasa layar atraksi', select([['en', 'English'], ['id', 'Indonesia']], draft.attractLang, { name: 'attractLang', disabled: !canEdit })),
      field('Catatan perangkat', textarea({ name: 'hwNote', value: draft.hwNote, rows: 2, disabled: !canEdit, placeholder: 'Merk/model, OS, resolusi, lokasi fisik' }), { span: 'span-2' }),
      field('Status', toggle(draft.isActive, 'Kiosk aktif (dihitung di validasi jangkauan)', { name: 'isActive', disabled: !canEdit })));
    prof.addEventListener('input', e => { const n = e.target.name; if (!n) return; draft[n] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; });
    prof.addEventListener('change', e => { const n = e.target.name; if (!n) return; draft[n] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; });
    detail.append(card('Profil', prof));

    // provisioning
    const provBody = h('div.stack');
    const renderProv = (tokenData) => {
      clear(provBody);
      if (!tokenData) {
        provBody.append(h('div.row.wrap', h('div.grow', h('div', cur.tokenHint ? h('span', 'Token aktif berakhiran ', h('b.mono', '…' + cur.tokenHint)) : h('span.muted', 'Belum ada token — kiosk tidak bisa mengirim heartbeat/telemetri.')),
          h('div.small.muted', 'Token 32 byte ditampilkan sekali. Membuat token baru membatalkan token lama.')),
          canProv ? btn(cur.tokenHint ? 'Buat ulang token' : 'Buat token', { icon: 'key-round', kind: cur.tokenHint ? '' : 'primary', onClick: async () => {
            if (cur.tokenHint && !(await confirmDlg('Token lama langsung tidak berlaku. Kiosk harus dipasang ulang dengan URL baru. Lanjutkan?', { danger: true, ok: 'Buat ulang' }))) return;
            const r = await api.post(`/kiosks/${cur.id}/token`); cur.tokenHint = r.data.token.slice(-4); renderProv(r.data); renderList();
          } }) : h('span.small.muted', 'Hanya superadmin yang bisa membuat token.')));
        return;
      }
      const qr = h('div.qr-box');
      (tokenData.qrSvg ? Promise.resolve(tokenData.qrSvg) : qrSvg(tokenData.launchUrl)).then(svg => { qr.innerHTML = svg; });
      provBody.append(h('div.callout.warn', ic('triangle-alert'), h('div', h('b', 'Salin sekarang — token tidak akan ditampilkan lagi. '), 'Simpan di password manager tim IT.')),
        h('div.row', { style: { alignItems: 'flex-start', gap: '16px' } }, qr, h('div.stack.grow', { style: { minWidth: 0 } },
          field('Token', h('div.inp-group', input({ value: tokenData.token, readOnly: true, class: 'inp mono' }), h('button.addon', { type: 'button', onclick: () => copyText(tokenData.token, 'Token disalin') }, ic('copy')))),
          field('URL peluncuran (Edge --kiosk / Fully Kiosk Start URL)', h('div.inp-group', input({ value: tokenData.launchUrl, readOnly: true, class: 'inp mono' }), h('button.addon', { type: 'button', onclick: () => copyText(tokenData.launchUrl, 'URL disalin') }, ic('copy')))),
          h('div.small.muted', 'QR berisi URL peluncuran — scan dari Fully Kiosk / ketik di browser TV saat setup.'))),
        field('start-kiosk.bat (PC Windows)', h('div', { style: { position: 'relative' } }, h('pre.code', tokenData.bat || ''), h('button.btn.sm', { type: 'button', style: { position: 'absolute', right: '8px', top: '8px' }, onclick: () => copyText(tokenData.bat, '.bat disalin') }, ic('copy'), 'Salin'))),
        h('div.row', btn('Selesai', { onClick: () => renderProv(null) })));
    };
    renderProv(null);
    detail.append(card('Provisioning', provBody));

    // runtime
    const up = rt.uptime7d || [];
    detail.append(card('Runtime (dari heartbeat)', h('div.grid', { style: { gridTemplateColumns: 'minmax(0,1fr) 260px', gap: '20px' } },
      h('dl.kv',
        h('dt', 'Status'), h('dd', kioskState(cur)),
        h('dt', 'Terakhir terlihat'), h('dd', rt.lastSeenAt ? `${relTime(rt.lastSeenAt)} · ${fmtDate(rt.lastSeenAt)}` : 'belum pernah'),
        h('dt', 'Mode aktif'), h('dd', perfBadge(cur)),
        h('dt', 'Service Worker'), h('dd', rt.swActive === false ? h('span', badge('Tidak aktif', 'danger', 'triangle-alert'), h('div.small', { style: { color: 'var(--danger)', marginTop: '4px' } }, 'Kiosk tidak punya cache offline — pastikan HTTPS dengan sertifikat valid (§6.3) atau pakai Fully Kiosk.')) : rt.swActive ? badge('Aktif', 'ok') : '—'),
        h('dt', 'Versi data'), h('dd.mono', [rt.dataVersion, rt.promosVersion, rt.statusVersion].filter(Boolean).map(v => v.split('-')[0]).join(' · ') || '—'),
        h('dt', 'App build'), h('dd.mono', rt.appBuild || '—'),
        h('dt', 'Layar'), h('dd.mono', rt.screen || '—'),
        h('dt', 'Uptime sesi'), h('dd', rt.uptimeSec != null ? fmtDur(rt.uptimeSec) : '—'),
        h('dt', 'IP'), h('dd.mono', rt.ip || '—'),
        h('dt', 'User agent'), h('dd.mono.small', rt.userAgent || '—'),
        h('dt', 'Error terakhir'), h('dd', rt.lastError ? h('span.mono.small', { style: { color: 'var(--danger)' } }, rt.lastError) : '—')),
      h('div', h('div.kicker', { style: { marginBottom: '8px' } }, 'Uptime 7 hari'),
        h('div.uptime', up.map(v => h('i', { class: v < 50 ? 'bad' : v < 95 ? 'lo' : '', style: { height: Math.max(4, v) + '%' }, title: v + '%' }))),
        h('div.row', { style: { justifyContent: 'space-between', marginTop: '4px' } }, h('span.small.muted', '7 hari lalu'), h('span.small.muted', 'hari ini')),
        h('div', { style: { marginTop: '10px', fontWeight: 700 } }, up.length ? 'Rata-rata ' + (up.reduce((a, b) => a + b, 0) / up.length).toFixed(1).replace('.', ',') + '%' : '—')))));

    tracker = dirtyTracker(detail, { onSave: save });
    tracker.reset = () => renderDetail();
    detail.append(tracker.el);
    await mc.ready;
    if (draft.x != null) mc.centerOn(draft.x, draft.y, 420);
  }
  async function save() {
    const body = {}; ['name', 'floorId', 'building', 'x', 'y', 'nodeId', 'facingDeg', 'defaultLang', 'attractLang', 'clientType', 'perfMode', 'isActive', 'hwNote'].forEach(k => body[k] = draft[k]);
    try {
      const r = await api.put('/kiosks/' + cur.id, body, cur.etag);
      Object.assign(cur, r.data); invalidate('kiosks'); toast('Kiosk disimpan'); renderList(); ctx.refreshStatus(); return true;
    } catch (e) { if (e.fields) showFieldErrors(detail, e.fields); return false; }
  }
  async function newKiosk() {
    const body = h('div.form', field('ID (slug)', input({ name: 'id', class: 'inp mono', placeholder: 'ff-ewalk' }), { name: 'id', required: true, hint: 'Dipakai di URL ?kiosk= — tidak bisa diubah.' }),
      field('Nama', input({ name: 'name', placeholder: '1F E-Walk' }), { name: 'name', required: true }),
      field('Lantai', select(floors.map(f => [f.id, floorName(f)]), 'gf', { name: 'floorId' }), { name: 'floorId' }));
    const ok = await dialog({ title: 'Kiosk baru', body, actions: [{ label: 'Batal', value: null }, { label: 'Buat', kind: 'primary', value: true, validate: async () => {
      const id = body.querySelector('[name=id]').value.trim(), name = body.querySelector('[name=name]').value.trim(), floorId = body.querySelector('[name=floorId]').value;
      if (!/^[a-z0-9-]+$/.test(id) || !name) { showFieldErrors(body, { id: id ? 'Hanya huruf kecil, angka, minus' : 'required', name: name ? undefined : 'required' }); return false; }
      const f = flBy[floorId];
      try { const r = await api.post('/kiosks', { id, name, floorId, building: f.building === 'both' ? 'pentacity' : f.building, x: f.viewBox[2] / 2, y: f.viewBox[3] / 2, nodeId: null, facingDeg: null, defaultLang: 'en', attractLang: 'en', clientType: 'windows_pc', perfMode: 'auto', isActive: true, runtime: { state: 'offline' } }); list.push(r.data); cur = r.data; return true; }
      catch (e) { if (e.fields) showFieldErrors(body, e.fields); return false; }
    } }] });
    if (ok) { invalidate('kiosks'); location.hash = '#/kiosks/' + cur.id; toast('Kiosk dibuat — klik "Pindahkan" untuk menempatkan di peta'); }
  }
  renderList(); await renderDetail();
}
const fmtDur = s => { const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + ' hari ' : '') + hh + ' jam ' + m + ' mnt'; };
