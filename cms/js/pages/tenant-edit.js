// Tenant edit — §2.2 / §7.2 #4: tabs Info, Jam, Lokasi (map placement + unit link), Media, Riwayat; kiosk-card preview EN/ID.
import { h, ic, btn, badge, pageHead, field, input, textarea, select, toggle, segmented, tabs, card, toast, dialog, confirmDlg,
  dirtyTracker, showFieldErrors, clear, assetUrl, fmtDate, relTime, HARI, table, debounce, initials, svgEl, loading } from '../ui.js';
import { api, lookups, invalidate, MOCK } from '../api.js';
import { can, floorName, STATUS_LABEL, HOURS_MODE, BUILDING_LABEL } from '../state.js';
import { statusBadge, floorOptions } from '../widgets.js';
import { MapCanvas, pinPath, nearestOnEdges, nearestNode } from '../mapcanvas.js';
import { mediaPicker } from './media.js';

const clone = o => JSON.parse(JSON.stringify(o));
const NEW_T = () => ({ id: '', brandId: null, brand: { name: '', categoryId: '', logo: null, descEn: null, descId: null, keywordsEn: '', keywordsId: '', url: null, instagram: null, tiktok: null, facebook: null, whatsapp: null, outletCount: 0 },
  nameOverride: null, floorId: '', building: 'pentacity', unitNo: null, x: null, y: null, nodeId: null, unitShapeId: null, phone: null, urlOverride: null, logoOverride: null,
  status: 'open', statusNoteEn: null, statusNoteId: null, statusUntil: null, openingDate: null, hoursMode: 'mall', hours: [], hoursNoteEn: null, hoursNoteId: null, isPublished: true });

export default async function tenantEdit(ctx) {
  const isNew = ctx.params.id === 'new';
  const [floors, cats, settings] = await Promise.all([lookups.floors(), lookups.categories(), api.get('/settings', null, { silent: true }).then(r => r.data).catch(() => ({}))]);
  const flBy = Object.fromEntries(floors.map(f => [f.id, f])), catBy = Object.fromEntries(cats.map(c => [c.id, c]));
  let t, orig;
  if (isNew) {
    t = NEW_T();
    const fromBrand = ctx.query.get('brand');
    if (fromBrand) { const src = (await lookups.tenantsLite()).find(x => String(x.brandId) === fromBrand); if (src) { t.brandId = src.brandId; t.brand = clone(src.brand); } }
  } else {
    t = (await api.get('/tenants/' + encodeURIComponent(ctx.params.id))).data;
  }
  orig = clone(t);
  const canEdit = can('tenants.edit'), canPlace = can('tenants.place');
  ctx.setTitle(isNew ? 'Tenant baru' : t.displayName);

  const root = ctx.root;
  const titleEl = h('span', isNew ? 'Tenant baru' : t.displayName);
  const headBadges = h('span.row', { style: { gap: '6px', marginLeft: '10px', verticalAlign: 'middle', display: 'inline-flex' } });
  const head = pageHead(h('span', titleEl, headBadges), isNew ? 'Isi brand & outlet. ID publik tidak bisa diubah setelah dipublish.' : h('span.mono', t.id), [
    !isNew && canEdit ? h('a.btn', { href: '#/tenants/new?brand=' + t.brandId, title: 'Salin brand ke outlet baru (lantai kosong)' }, ic('copy'), 'Tambah outlet') : null,
    !isNew && canEdit ? btn('', { icon: 'trash-2', kind: 'danger', title: 'Hapus tenant', onClick: del }) : null,
    canEdit ? btn('Simpan', { icon: 'save', kind: 'primary', onClick: () => tracker.save(), kbd: 'Ctrl S' }) : null],
    [h('a', { href: '#/tenants' }, 'Tenant'), ic('chevron-right'), isNew ? 'Baru' : t.id]);
  root.append(head);
  const renderHeadBadges = () => { clear(headBadges).append(statusBadge(t.status), ...(t.issues || []).filter(i => i !== 'E_UNPLACED').map(i => badge({ W_NO_LOGO: 'Tanpa logo', W_NO_HOURS: 'Tanpa jam' }[i] || i, 'warn'))); };
  renderHeadBadges();

  const tabKeys = [{ key: 'info', label: 'Info', icon: 'store' }, { key: 'hours', label: 'Jam', icon: 'clock' }, { key: 'loc', label: 'Lokasi', icon: 'map-pin' }, { key: 'media', label: 'Media', icon: 'image' }];
  if (!isNew) tabKeys.push({ key: 'hist', label: 'Riwayat', icon: 'history' });
  let tab = ctx.query.get('tab') || 'info';
  const tabBar = tabs(tabKeys, tab, k => { tab = k; showTab(); });
  const panes = {};
  for (const k of tabKeys) panes[k.key] = h('div', { hidden: true });
  const formRoot = h('div', Object.values(panes));
  const preview = h('div.sticky.stack');
  root.append(tabBar, h('div.split', formRoot, preview));

  const tracker = dirtyTracker(formRoot, { onSave: save });
  tracker.reset = () => { t = clone(orig); buildAll(); tracker.set(false); };
  formRoot.append(tracker.el);

  // ---------- binding helpers ----------
  const get = path => path.split('.').reduce((o, k) => o == null ? o : o[k], t);
  const set = (path, v) => { const ks = path.split('.'); const last = ks.pop(); const o = ks.reduce((o, k) => o[k] = o[k] || {}, t); o[last] = v; renderPreview(); };
  const bindInput = (path, attrs = {}) => { const el = (attrs.multiline ? textarea : input)(Object.assign({ value: get(path) ?? '', disabled: !canEdit }, attrs, { multiline: null })); el.addEventListener('input', () => set(path, el.value === '' ? null : el.value)); return el; };
  const bindSelect = (path, opts, attrs = {}) => { const el = select(opts, get(path) ?? '', Object.assign({ disabled: !canEdit }, attrs)); el.addEventListener('change', () => set(path, el.value || null)); return el; };
  const F = (label, path, ctrl, o = {}) => field(label, ctrl, Object.assign({ name: path }, o));

  function buildInfo() {
    const p = clear(panes.info);
    // brand
    const brandNote = t.brand.outletCount > 1 ? h('div.callout.muted', ic('info'), `Brand ini dipakai ${t.brand.outletCount} outlet — perubahan brand berlaku untuk semuanya.`) : null;
    let brandName;
    if (isNew && !t.brandId) {
      brandName = bindInput('brand.name', { placeholder: 'mis. Uniqlo' });
      const sug = h('div.gs-pop', { hidden: true, style: { top: '64px' } });
      brandName.addEventListener('input', debounce(async () => {
        const qv = brandName.value.trim(); if (qv.length < 2) { sug.hidden = true; return; }
        const r = await api.get('/brands', { q: qv }, { silent: true }).catch(() => ({ data: [] }));
        clear(sug); sug.hidden = !r.data.length;
        r.data.slice(0, 6).forEach(b => sug.append(h('div.gs-item', { onmousedown: e => { e.preventDefault(); t.brandId = b.id; t.brand = clone(b); sug.hidden = true; buildInfo(); renderPreview(); tracker.set(true); } },
          h('div.grow', h('b', b.name), h('div.small.muted', `Pakai brand yang ada · ${b.outletCount || 0} outlet`)))));
      }, 200));
      brandName.addEventListener('blur', () => setTimeout(() => sug.hidden = true, 150));
      brandName = h('div', { style: { position: 'relative' } }, brandName, sug);
    } else brandName = bindInput('brand.name');
    p.append(card(h('div.row', h('h3', 'Brand'), isNew && t.brandId ? badge('Brand yang sudah ada', 'info') : null), h('div.stack', brandNote,
      h('div.form.cols-2',
        F('Nama brand', 'brand.name', brandName, { required: true }),
        F('Kategori', 'brand.categoryId', bindSelect('brand.categoryId', [['', '— pilih —'], ...cats.map(c => [c.id, c.nameId])]), { required: true }),
        h('div.span-2', h('div.section-t', 'Deskripsi'), h('div.lang-pair', { style: { marginTop: '8px' } },
          F(h('span', h('span.lang-tag', 'ID'), ' Bahasa Indonesia'), 'brand.descId', bindInput('brand.descId', { multiline: true, rows: 3 })),
          F(h('span', h('span.lang-tag', 'EN'), ' English'), 'brand.descEn', bindInput('brand.descEn', { multiline: true, rows: 3 })))),
        h('div.span-2', h('div.lang-pair',
          F(h('span', h('span.lang-tag', 'ID'), ' Keyword'), 'brand.keywordsId', bindInput('brand.keywordsId', { placeholder: 'baju, pakaian, kaos' }), { hint: 'Pisahkan dengan koma. Nama lantai & gedung ditambahkan otomatis.' }),
          F(h('span', h('span.lang-tag', 'EN'), ' Keyword'), 'brand.keywordsEn', bindInput('brand.keywordsEn', { placeholder: 'clothes, apparel' }), { hint: 'Tambahkan ejaan yang sering salah ketik.' }))),
        F('Situs web', 'brand.url', bindInput('brand.url', { type: 'url', placeholder: 'https://…' }), { hint: 'Wajib https://' }),
        F('Instagram', 'brand.instagram', h('div.inp-group', h('span.addon.pre', '@'), bindInput('brand.instagram', { placeholder: 'uniqloindonesia' }))),
        F('TikTok', 'brand.tiktok', h('div.inp-group', h('span.addon.pre', '@'), bindInput('brand.tiktok'))),
        F('WhatsApp', 'brand.whatsapp', bindInput('brand.whatsapp', { placeholder: '+62812…', inputmode: 'tel' }), { hint: 'Format E.164, mis. +6281234567890' }),
        F('Facebook', 'brand.facebook', bindInput('brand.facebook', { placeholder: 'https://facebook.com/…' }), { span: 'span-2' })))));

    // outlet
    const idIn = bindInput('id', { placeholder: 'uniqlo-gf', disabled: !isNew || !canEdit, class: 'inp mono' });
    const floorSel = bindSelect('floorId', floorOptions(floors, { empty: '— pilih lantai —' }));
    const bldSel = bindSelect('building', [['pentacity', 'Pentacity'], ['ewalk', 'E-Walk']]);
    const syncBld = () => { const fl = flBy[t.floorId]; if (fl && fl.building !== 'both') { t.building = fl.building; bldSel.value = fl.building; bldSel.disabled = true; } else bldSel.disabled = !canEdit; };
    floorSel.addEventListener('change', () => { syncBld(); if (isNew && !t.id && t.brand.name && t.floorId) { t.id = slug(t.brand.name) + '-' + t.floorId; idIn.value = t.id; } renderPreview(); });
    syncBld();
    const autoName = h('span.mono');
    const ovIn = bindInput('nameOverride', { placeholder: t.displayName || 'otomatis' });
    p.append(card('Outlet', h('div.form.cols-2',
      F('ID publik (slug)', 'id', idIn, { required: true, hint: isNew ? 'Huruf kecil-angka-strip. Dipakai QR & featured — tidak bisa diubah setelah publish.' : 'Tetap — dipakai QR kiosk (t=) & featured.' }),
      F('Nama tampilan (override)', 'nameOverride', ovIn, { hint: 'Kosongkan untuk nama otomatis: "Brand · Gedung [Lantai]" bila brand punya >1 outlet.' }),
      F('Lantai', 'floorId', floorSel, { required: true }),
      F('Gedung', 'building', bldSel, { hint: 'Otomatis dari lantai, kecuali GF/UG gabungan.' }),
      F('Nomor unit', 'unitNo', bindInput('unitNo', { placeholder: 'UG-12A', class: 'inp mono' })),
      F('Telepon', 'phone', bindInput('phone', { placeholder: '+62542…', inputmode: 'tel' })),
      F('URL khusus outlet', 'urlOverride', bindInput('urlOverride', { type: 'url', placeholder: 'https://… (opsional, menimpa situs brand)' }), { span: 'span-2' }))));

    // status
    const stSeg = segmented(Object.entries(STATUS_LABEL).map(([v, l]) => ({ value: v, label: l })), t.status, v => { set('status', v); tracker.set(true); buildStatusExtra(); renderHeadBadges(); });
    if (!canEdit) [...stSeg.children].forEach(b => b.disabled = true);
    const extra = h('div.form.cols-2');
    const buildStatusExtra = () => {
      clear(extra);
      if (t.status === 'temp_closed' || t.status === 'coming_soon') extra.append(h('div.span-2.lang-pair',
        F(h('span', h('span.lang-tag', 'ID'), ' Catatan status'), 'statusNoteId', bindInput('statusNoteId', { placeholder: t.status === 'coming_soon' ? 'Segera hadir' : 'Renovasi' })),
        F(h('span', h('span.lang-tag', 'EN'), ' Catatan status'), 'statusNoteEn', bindInput('statusNoteEn', { placeholder: t.status === 'coming_soon' ? 'Opening soon' : 'Renovation' }))));
      if (t.status === 'temp_closed') extra.append(F('Tutup sampai', 'statusUntil', bindInput('statusUntil', { type: 'date' }), { hint: 'Kosong = sampai diubah manual.' }));
      if (t.status === 'coming_soon') extra.append(F('Tanggal buka', 'openingDate', bindInput('openingDate', { type: 'date' })));
      if (t.status === 'closed') extra.append(h('div.span-2.callout.warn', ic('triangle-alert'), 'Tenant tutup permanen tidak diekspor ke kiosk saat publish berikutnya.'));
      if (t.status === 'coming_soon') extra.append(h('div.span-2.callout', ic('info'), 'Tampil dengan badge "Segera buka" dan tetap bisa dirutekan (ke hoarding).'));
    };
    buildStatusExtra();
    const pub = toggle(t.isPublished, 'Tampilkan di kiosk (terpublish)', { disabled: !canEdit, onchange: e => set('isPublished', e.target.checked) });
    p.append(card('Status', h('div.stack', h('div.row.wrap', stSeg, h('span.grow'), pub), extra)));
  }

  function buildHours() {
    const p = clear(panes.hours);
    const mall = settings['mall.hours'] || {};
    const mallTxt = Object.keys(mall).length ? summarizeWeek(mall) : '10:00–22:00 setiap hari';
    const grid = h('div');
    const seg = segmented(Object.entries(HOURS_MODE).map(([v, l]) => ({ value: v, label: l })), t.hoursMode, v => { set('hoursMode', v); tracker.set(true); if (v === 'custom' && !(t.hours || []).length) t.hours = [1, 2, 3, 4, 5, 6, 7].map(d => ({ dow: d, open: '10:00', close: '22:00', closed: false })); renderGrid(); renderHeadBadges(); }, 'lg');
    if (!canEdit) [...seg.children].forEach(b => b.disabled = true);
    const renderGrid = () => {
      clear(grid);
      if (t.hoursMode === 'mall') grid.append(h('div.callout.muted', ic('clock'), h('div', 'Mengikuti jam mall: ', h('b', mallTxt), '. Diatur di Pengaturan.')));
      else if (t.hoursMode === '24h') grid.append(h('div.callout.muted', ic('clock'), 'Buka 24 jam setiap hari.'));
      else if (t.hoursMode === 'unknown') grid.append(h('div.callout.warn', ic('triangle-alert'), 'Jam belum diketahui — kiosk tidak menampilkan jam buka (peringatan W_NO_HOURS).'));
      else {
        const g = h('div.hours-grid', h('span.kicker', 'Hari'), h('span.kicker', 'Buka'), h('span.kicker', 'Tutup'), h('span'));
        t.hours.sort((a, b) => a.dow - b.dow).forEach(r => {
          const o = input({ type: 'time', value: r.open || '', disabled: r.closed || !canEdit, oninput: e => { r.open = e.target.value; renderPreview(); } });
          const c = input({ type: 'time', value: r.close || '', disabled: r.closed || !canEdit, oninput: e => { r.close = e.target.value; renderPreview(); } });
          const cb = h('label.check', h('input', { type: 'checkbox', checked: r.closed, disabled: !canEdit, onchange: e => { r.closed = e.target.checked; o.disabled = c.disabled = r.closed; renderPreview(); } }), 'Libur');
          g.append(h('b', HARI[r.dow - 1]), o, c, cb);
        });
        grid.append(g, h('div.row', { style: { marginTop: '12px' } }, btn('Salin Senin ke semua hari', { size: 'sm', icon: 'copy', disabled: !canEdit, onClick: () => { const m = t.hours.find(x => x.dow === 1); t.hours.forEach(x => { x.open = m.open; x.close = m.close; x.closed = m.closed; }); tracker.set(true); renderGrid(); renderPreview(); } }),
          h('span.small.muted', 'Tutup lewat tengah malam: isi jam tutup lebih kecil dari jam buka.')));
      }
    };
    renderGrid();
    p.append(card('Jam buka', h('div.stack', seg, grid, h('div.lang-pair',
      F(h('span', h('span.lang-tag', 'ID'), ' Catatan jam'), 'hoursNoteId', bindInput('hoursNoteId', { placeholder: 'Dapur tutup 21:30' })),
      F(h('span', h('span.lang-tag', 'EN'), ' Catatan jam'), 'hoursNoteEn', bindInput('hoursNoteEn', { placeholder: 'Kitchen closes 21:30' }))))));
  }

  // ---------- location tab ----------
  let mc = null, graph = null, mode = null, pending = null;
  async function buildLoc() {
    const p = clear(panes.loc);
    if (!t.floorId) { p.append(h('div.callout.warn', ic('triangle-alert'), 'Pilih lantai di tab Info terlebih dahulu.')); return; }
    const info = h('div.small');
    const modeSeg = segmented([{ value: 'view', label: 'Lihat', icon: 'hand' }, { value: 'place', label: 'Tempatkan pin', icon: 'map-pin' }, { value: 'unit', label: 'Pilih unit', icon: 'link' }], 'view', v => setMode(v));
    if (!canPlace) [...modeSeg.children].slice(1).forEach(b => b.disabled = true);
    const saveBtn = btn('Simpan lokasi', { icon: 'save', kind: 'primary', size: 'sm', disabled: true, onClick: saveLoc });
    const cancelBtn = btn('Batal', { size: 'sm', kind: 'ghost', disabled: true, onClick: () => { pending = null; saveBtn.disabled = cancelBtn.disabled = true; draw(); renderInfo(); } });
    const unlinkBtn = btn('Lepas unit', { icon: 'unlink', size: 'sm', disabled: !t.unitShapeId || !canPlace, onClick: () => { pending = Object.assign(pending || {}, { unitShapeId: null }); saveBtn.disabled = cancelBtn.disabled = false; draw(); renderInfo(); } });
    // door on the linked unit's shop front + spur along the floor to the nearest path (Map3d::reconnect on the server)
    const autoBtn = btn('Sambung otomatis', { icon: 'route', size: 'sm', disabled: !canPlace || isNew, title: 'Pin pindah ke muka toko unit tertaut (lantai 3D) lalu disambung ke jalur terdekat tanpa menembus toko', onClick: async () => {
      if (pending) { toast('Simpan lokasi dulu', 'warn'); return; }
      try {
        const c = (await api.post('/graph/reconnect', { floor: t.floorId, tenants: [t.id] })).data.connected[0];
        Object.assign(t, (await api.get('/tenants/' + encodeURIComponent(t.id))).data); orig = clone(t); invalidate('tenants-lite');
        graph = (await api.get('/graph', { floor: fl.id })).data; graph.nodeBy = Object.fromEntries(graph.nodes.map(n => [n.id, n]));
        graph.takenUnits = Object.fromEntries(graph.attachments.tenants.filter(x => x.unitShapeId && x.id !== t.id).map(x => [x.unitShapeId, x.name || x.id]));
        markUnits(); draw(); renderInfo(); ctx.refreshStatus();
        if (t.x != null) mc.centerOn(t.x, t.y, 520);
        toast(c && c.viaFloor ? 'Pin di muka toko & tersambung ke jalur' : 'Tersambung garis lurus — pintu unit tidak menghadap koridor di gambar; atur jalurnya di Editor graph', c && c.viaFloor ? 'ok' : 'warn', 8000);
      } catch (e) { /* toast shown by api */ }
    } });
    autoBtn.hidden = MOCK;
    const mapHost = h('div', { style: { height: '560px', position: 'relative' } });
    p.append(card(null, h('div.stack', h('div.row.wrap', modeSeg, h('span.grow'), autoBtn, unlinkBtn, cancelBtn, saveBtn), mapHost, info), { cls: 'loc-card' }));
    const fl = flBy[t.floorId];
    mc = new MapCanvas(mapHost, { floors: [fl], floorId: fl.id, picker: false, height: '100%', layers: { labels: false }, onRender: draw, coords: true });
    ctx.onLeave(() => mc && mc.destroy());
    graph = (await api.get('/graph', { floor: fl.id })).data;
    graph.nodeBy = Object.fromEntries(graph.nodes.map(n => [n.id, n]));
    graph.takenUnits = Object.fromEntries(graph.attachments.tenants.filter(x => x.unitShapeId && x.id !== t.id).map(x => [x.unitShapeId, x.name || x.id]));
    mc.on('click', (pt, e) => { if (mode === 'place') placeAt(pt, e.shiftKey); });
    await mc.ready;
    draw(); markUnits(); renderInfo();
    if (t.x != null) mc.centerOn(t.x, t.y, 520);

    function setMode(v) {
      mode = v; mc.capture = v === 'place'; mc.setCursor(v === 'place' ? 'crosshair' : null);
      mc.setUnitPick(v === 'unit' ? { pick: id => {
        const other = graph.takenUnits[id];
        const doIt = () => { pending = Object.assign(pending || {}, { unitShapeId: id }); saveBtn.disabled = cancelBtn.disabled = false; markUnits(); renderInfo(); draw(); };
        if (other) confirmDlg(`Unit ${id} sudah ditautkan ke ${other}. Tautkan juga ke tenant ini?`, { ok: 'Tautkan', danger: true }).then(y => y && doIt()); else doIt();
      } } : null);
      mc.hint(v === 'place' ? 'Klik pintu masuk tenant — pin di-snap ke koridor terdekat. Shift+klik: pilih node manual.' : v === 'unit' ? 'Arahkan ke bentuk unit lalu klik untuk menautkan.' : '');
    }
    function placeAt(pt, manual) {
      const edges = graph.edges.filter(e => e.enabled);
      const exclude = new Set(graph.attachments.stops.map(s => s.nodeId));
      if (manual) {
        const nn = nearestNode(pt, graph.nodes, exclude);
        pending = Object.assign(pending || {}, { x: +pt.x.toFixed(2), y: +pt.y.toFixed(2), node: nn ? nn.node.id : null, snap: nn ? { x: nn.node.x, y: nn.node.y } : null, ops: null });
      } else {
        const maxD = 40 / (fl.unitScale || 1);
        const pr = nearestOnEdges(pt, edges, graph.nodeBy);
        if (!pr || pr.d > maxD) { toast(`Tidak ada koridor dalam ${Math.round(maxD)} unit — gunakan Shift+klik untuk memilih node, atau tambah koridor di Editor graph.`, 'warn', 6000); return; }
        const a = graph.nodeBy[pr.edge.a], b = graph.nodeBy[pr.edge.b];
        const da = Math.hypot(pr.x - a.x, pr.y - a.y) * fl.unitScale, db = Math.hypot(pr.x - b.x, pr.y - b.y) * fl.unitScale;
        const ops = []; let attachNode;
        if (da < 3 || db < 3) attachNode = da <= db ? a.id : b.id;
        else { ops.push({ op: 'splitEdge', edge: pr.edge.id, tmp: 't1', x: +pr.x.toFixed(2), y: +pr.y.toFixed(2) }); attachNode = 't1'; }
        const spur = pr.d * fl.unitScale > 3;
        if (spur) { ops.push({ op: 'addNode', tmp: 't2', floor: fl.id, x: +pt.x.toFixed(2), y: +pt.y.toFixed(2), label: 'spur:' + t.id }); ops.push({ op: 'addEdge', tmp: 'e1', a: 't2', b: attachNode }); attachNode = 't2'; }
        pending = Object.assign(pending || {}, { x: +pt.x.toFixed(2), y: +pt.y.toFixed(2), snap: { x: pr.x, y: pr.y }, node: attachNode, ops, spur });
      }
      saveBtn.disabled = cancelBtn.disabled = false; draw(); renderInfo();
    }
    function markUnits() {
      const m = {}; for (const id in graph.takenUnits) m[id] = 'ov-unit-taken';
      const cur = pending && 'unitShapeId' in pending ? pending.unitShapeId : t.unitShapeId; if (cur) m[cur] = 'ov-unit-linked';
      mc.markUnits(m);
    }
    function renderInfo() {
      clear(info);
      const cur = pending && 'unitShapeId' in pending ? pending.unitShapeId : t.unitShapeId;
      const x = pending && pending.x != null ? pending.x : t.x, y = pending && pending.y != null ? pending.y : t.y;
      info.append(h('dl.kv',
        h('dt', 'Koordinat'), h('dd.mono', x != null ? `${x.toFixed(1)}, ${y.toFixed(1)}` : '— belum ditempatkan'),
        h('dt', 'Node graph'), h('dd.mono', pending && pending.node != null ? String(pending.node).replace(/^t\d/, 'node baru') + (pending.spur ? ' (spur ke koridor)' : '') : t.nodeId ? 'n' + t.nodeId : '—'),
        h('dt', 'Unit shape'), h('dd', cur ? h('span.row', h('span.mono', cur), mc.hasShape(cur) ? badge('ditemukan di SVG', 'ok') : badge('tidak ada di SVG', 'warn')) : h('span.muted', '— belum ditautkan (kiosk tidak menyorot unit)'))),
        pending ? h('div.callout', { style: { marginTop: '10px' } }, ic('info'), 'Perubahan lokasi belum disimpan. Penempatan termasuk seksi konten; spur otomatis tidak memblokir publish leasing.') : null);
    }
    async function saveLoc() {
      try {
        let nodeId = t.nodeId;
        if (pending.node != null) {
          const ops = (pending.ops || []).slice();
          ops.push({ op: 'attach', entity: 'tenant', id: t.id, node: pending.node });
          const r = await api.post('/graph/ops', { revision: graph.revision, ops });
          nodeId = typeof pending.node === 'string' ? r.data.idMap[pending.node] : pending.node;
        }
        const body = {};
        if (pending.x != null) { body.x = pending.x; body.y = pending.y; body.nodeId = nodeId; }
        if ('unitShapeId' in pending) body.unitShapeId = pending.unitShapeId;
        const r2 = await api.put('/tenants/' + encodeURIComponent(t.id), body, t.etag);
        Object.assign(t, r2.data); orig = clone(t); pending = null; invalidate('tenants-lite');
        toast('Lokasi tenant disimpan'); renderHeadBadges(); ctx.refreshStatus();
        graph = (await api.get('/graph', { floor: fl.id })).data; graph.nodeBy = Object.fromEntries(graph.nodes.map(n => [n.id, n]));
        graph.takenUnits = Object.fromEntries(graph.attachments.tenants.filter(x => x.unitShapeId && x.id !== t.id).map(x => [x.unitShapeId, x.name || x.id]));
        saveBtn.disabled = cancelBtn.disabled = true; unlinkBtn.disabled = !t.unitShapeId; markUnits(); draw(); renderInfo();
      } catch (e) { if (e.code === 'conflict') toast('Graph/tenant berubah — muat ulang halaman lalu ulangi.', 'err'); else if (e.fields) toast(Object.values(e.fields).join(', '), 'err'); }
    }
  }
  function draw() {
    if (!mc || !graph) return;
    const g = mc.layer('graph'), tl = mc.layer('tenants'), top = mc.layer('top');
    const r = mc.px(3);
    for (const e of graph.edges) { const a = graph.nodeBy[e.a], b = graph.nodeBy[e.b]; if (a && b) g.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'ov-edge' + (e.enabled ? '' : ' off'), style: 'opacity:.55' })); }
    for (const n of graph.nodes) g.append(svgEl('circle', { cx: n.x, cy: n.y, r: r * .8, class: 'ov-node', style: 'opacity:.6' }));
    for (const o of graph.attachments.tenants) if (o.id !== t.id && o.x != null) tl.append(svgEl('circle', { cx: o.x, cy: o.y, r: mc.px(4), class: 'ov-tenant', fill: (catBy[o.categoryId] || {}).color || '#857B70', style: 'opacity:.5' }, svgEl('title', { text: o.name })));
    const x = pending && pending.x != null ? pending.x : t.x, y = pending && pending.y != null ? pending.y : t.y;
    const nodeId = pending && pending.node != null ? null : t.nodeId; const nd = nodeId && graph.nodeBy[nodeId];
    const snap = pending && pending.snap ? pending.snap : nd ? { x: nd.x, y: nd.y } : null;
    if (x != null && snap) top.append(svgEl('line', { x1: x, y1: y, x2: snap.x, y2: snap.y, class: 'ov-link' }), svgEl('circle', { cx: snap.x, cy: snap.y, r: mc.px(5), class: 'ov-snap' }));
    if (x != null) top.append(svgEl('path', { d: pinPath(x, y, mc.px(11)), class: 'ov-pin' }), svgEl('circle', { cx: x, cy: y - mc.px(23), r: mc.px(4.5), fill: '#fff' }));
  }

  function buildMedia() {
    const p = clear(panes.media);
    const logoCard = (title, path, note) => {
      const cur = get(path);
      const box = h('div.row', { style: { gap: '14px', alignItems: 'stretch' } },
        ['#fff', 'var(--bg)'].map(bg => h('div', { style: { width: '200px', height: '110px', borderRadius: '12px', border: '1px solid var(--line)', background: bg, display: 'grid', placeItems: 'center' } },
          cur ? h('img', { src: assetUrl(cur.url), alt: '', style: { maxWidth: '160px', maxHeight: '72px', objectFit: 'contain' } }) : h('span.muted.small', 'Belum ada logo'))));
      const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: async e => {
        const file = e.target.files[0]; if (!file) return;
        try {
          const r = await api.upload('/media', file, { kind: 'logo' });
          set(path, { id: r.data.id, url: r.data.url, url2x: r.data.url2x }); tracker.set(true); buildMedia();
          toast(`Logo diunggah (${r.data.width}×${r.data.height}, ${r.data.encoder || 'webp'})`);
          (r.data.warnings || []).forEach(w => toast(w, 'warn'));
        } catch (err) { if (err.fields) toast(Object.values(err.fields).join(', '), 'err'); }
      } });
      return card(title, h('div.stack', box, h('div.small.muted', note),
        h('div.row', fileIn, btn('Unggah PNG/JPG/WebP', { icon: 'cloud-upload', size: 'sm', disabled: !canEdit, onClick: () => fileIn.click() }),
          btn('Pilih dari media', { icon: 'image', size: 'sm', disabled: !canEdit, onClick: async () => { const m = await mediaPicker('logo'); if (m) { set(path, { id: m.id, url: m.url, url2x: m.url2x }); tracker.set(true); buildMedia(); } } }),
          cur ? btn('Hapus', { icon: 'x', size: 'sm', kind: 'ghost', disabled: !canEdit, onClick: () => { set(path, null); tracker.set(true); buildMedia(); } }) : null)));
    };
    p.append(logoCard('Logo brand', 'brand.logo', 'Dikonversi ke WebP 320 px (+ 640 px @2x), transparansi dipertahankan. SVG ditolak — minta PNG transparan ≥ 600 px. Pratinjau di latar putih & krem seperti kartu kiosk.'),
      logoCard('Logo khusus outlet (opsional)', 'logoOverride', 'Menimpa logo brand hanya untuk outlet ini.'));
  }

  async function buildHist() {
    const p = clear(panes.hist); p.append(loading());
    const r = await api.get('/audit', { entity: 'tenant', id: t.id, per: 100 }).catch(() => ({ data: [] }));
    clear(p).append(card('Riwayat perubahan', table({ rows: r.data, empty: 'Belum ada riwayat', compact: true, columns: [
      { key: 'ts', label: 'Waktu', render: x => h('span.nowrap', fmtDate(x.ts)) },
      { key: 'user', label: 'Oleh', render: x => x.user || 'Sistem' },
      { key: 'action', label: 'Aksi', render: x => badge(x.action, x.action === 'delete' ? 'danger' : x.action === 'create' ? 'ok' : '') },
      { key: 'summary', label: 'Ringkasan' },
      { key: 'diff', label: 'Perubahan', render: x => x.after ? h('span.mono.small', Object.keys(x.after).map(k => `${k}: ${fmtV(x.before && x.before[k])} → ${fmtV(x.after[k])}`).join('; ')) : '' }] }), { flush: true }));
  }

  // ---------- preview ----------
  let pvLang = 'id', pvBg = 'white';
  function renderPreview() {
    clear(preview);
    const name = t.nameOverride || (isNew ? t.brand.name || 'Nama tenant' : t.displayName);
    const cat = catBy[t.brand.categoryId]; const fl = flBy[t.floorId];
    const logo = t.logoOverride || t.brand.logo;
    const desc = pvLang === 'id' ? (t.brand.descId || t.brand.descEn) : (t.brand.descEn || t.brand.descId);
    const hours = hoursLine(t, settings, pvLang);
    const stTxt = { open: null, coming_soon: pvLang === 'id' ? 'Segera buka' : 'Coming soon', temp_closed: pvLang === 'id' ? 'Tutup sementara' : 'Temporarily closed', closed: pvLang === 'id' ? 'Tutup' : 'Closed' }[t.status];
    const note = pvLang === 'id' ? t.statusNoteId : t.statusNoteEn;
    preview.append(h('div.kicker', 'Pratinjau kartu kiosk'), h('div.row', h('span.grow'),
      segmented([{ value: 'id', label: 'ID' }, { value: 'en', label: 'EN' }], pvLang, v => { pvLang = v; renderPreview(); }),
      segmented([{ value: 'white', label: 'Putih' }, { value: 'cream', label: 'Krem' }], pvBg, v => { pvBg = v; renderPreview(); })),
      h('div', { class: 'tprev' + (pvBg === 'cream' ? ' cream' : '') },
        h('div.tp-logo', logo ? h('img', { src: assetUrl(logo.url), alt: '' }) : h('span.logo-ph', { style: { width: '64px', height: '48px', fontSize: '16px' } }, initials(name))),
        h('h3', name),
        h('div.tp-meta', cat ? h('span.badge', { style: { background: cat.color + '1A', color: cat.color } }, pvLang === 'id' ? cat.nameId : cat.nameEn) : null,
          fl ? h('span.badge.ink', fl.short) : null, h('span.badge.outline', BUILDING_LABEL[t.building] || ''),
          stTxt ? h('span', { class: 'badge ' + (t.status === 'coming_soon' ? 'info' : 'warn') }, stTxt + (note ? ' · ' + note : '')) : null),
        hours ? h('div.tp-desc', h('span.row', { style: { gap: '6px' } }, ic('clock'), hours)) : null,
        desc ? h('div.tp-desc', desc) : null,
        h('div.tp-desc.small.muted', [t.phone, (t.urlOverride || t.brand.url || '').replace(/^https:\/\//, '')].filter(Boolean).join(' · '))));
    if (!isNew) preview.append(h('div.card', { style: { padding: '12px 14px' } }, h('dl.kv', { style: { gridTemplateColumns: '110px 1fr' } },
      h('dt', 'Sumber'), h('dd.mono', t.srcId || '—'), h('dt', 'Terakhir diubah'), h('dd', t.updatedAt ? relTime(t.updatedAt) : '—'),
      h('dt', 'Keyword publish'), h('dd.small', keywordsPreview(t, fl)))));
  }

  function buildAll() { buildInfo(); buildHours(); buildMedia(); renderPreview(); renderHeadBadges(); if (tab === 'loc') buildLoc(); }
  function showTab() {
    for (const k in panes) panes[k].hidden = k !== tab;
    tracker.el.hidden = !tracker.dirty;
    if (tab === 'loc' && !mc) buildLoc();
    if (tab === 'hist') buildHist();
    history.replaceState(null, '', '#/tenants/' + encodeURIComponent(ctx.params.id) + (tab !== 'info' ? '?tab=' + tab : ''));
  }
  buildInfo(); buildHours(); buildMedia(); renderPreview(); showTab();

  async function save(force) {
    showFieldErrors(formRoot, {});
    const errs = {};
    if (!t.brand.name) errs['brand.name'] = 'required';
    if (!t.brand.categoryId) errs['brand.categoryId'] = 'required';
    if (!t.floorId) errs.floorId = 'required';
    if (isNew && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.id || '')) errs.id = t.id ? 'Hanya huruf kecil, angka, tanda minus' : 'required';
    for (const k of ['brand.url', 'urlOverride']) { const v = get(k); if (v && !/^https:\/\//.test(v)) errs[k] = 'https'; }
    if (Object.keys(errs).length) { tab = 'info'; tabBar.setActive('info'); showTab(); showFieldErrors(formRoot, errs); toast('Periksa isian yang ditandai', 'warn'); return false; }
    const body = clone(t); delete body.etag; delete body.issues; delete body.displayName; delete body.updatedAt;
    try {
      const r = isNew ? await api.post('/tenants', body) : await api.put('/tenants/' + encodeURIComponent(t.id), body, force || t.etag);
      t = r.data; orig = clone(t); invalidate('tenants-lite');
      toast(isNew ? 'Tenant dibuat' : 'Tenant disimpan'); ctx.refreshStatus();
      titleEl.textContent = t.displayName; renderHeadBadges(); renderPreview();
      if (isNew) { tracker.set(false); location.hash = '#/tenants/' + encodeURIComponent(t.id); }
      return true;
    } catch (e) {
      if (e.code === 'validation' && e.fields) { const ks = Object.keys(e.fields); const onHours = ks.some(k => k.startsWith('hours')); tab = onHours ? 'hours' : 'info'; tabBar.setActive(tab); showTab(); showFieldErrors(formRoot, e.fields); return false; }
      if (e.code === 'conflict') {
        const cur = e.details && e.details.current;
        const v = await dialog({ title: 'Data diubah oleh orang lain', body: h('p', `Tenant ini diubah oleh ${e.details && e.details.by || 'pengguna lain'}${e.details && e.details.at ? ' (' + relTime(e.details.at) + ')' : ''} setelah Anda membukanya.`),
          actions: [{ label: 'Batal', value: null }, { label: 'Muat ulang (buang perubahan saya)', value: 'reload' }, { label: 'Timpa dengan versi saya', kind: 'danger solid', value: 'force' }] });
        if (v === 'reload') { tracker.set(false); location.reload(); }
        if (v === 'force') return save(cur && cur.etag || '*');
      }
      return false;
    }
  }
  async function del() {
    if (!(await confirmDlg(`Hapus tenant ${t.displayName}? Gunakan status "Tutup permanen" bila hanya ingin menyembunyikan dari kiosk.`, { title: 'Hapus tenant', ok: 'Hapus', danger: true }))) return;
    await api.del('/tenants/' + encodeURIComponent(t.id)); invalidate('tenants-lite'); tracker.set(false); toast('Tenant dihapus'); location.hash = '#/tenants';
  }
}

const slug = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const fmtV = v => v == null ? '∅' : typeof v === 'object' ? JSON.stringify(v).slice(0, 40) : String(v);
function summarizeWeek(m) { const a = m['1'] && m['1'][0]; const same = Object.values(m).every(v => JSON.stringify(v) === JSON.stringify(m['1'])); return a ? (same ? `${a[0]}–${a[1]} setiap hari` : 'bervariasi per hari') : '—'; }
function hoursLine(t, settings, lang) {
  const today = ((new Date().getDay() + 6) % 7) + 1;
  const L = lang === 'id' ? { today: 'Buka hari ini', closed: 'Tutup hari ini', h24: 'Buka 24 jam' } : { today: 'Open today', closed: 'Closed today', h24: 'Open 24 hours' };
  if (t.hoursMode === '24h') return L.h24;
  if (t.hoursMode === 'mall') { const m = (settings['mall.hours'] || {})[String(today)] || [['10:00', '22:00']]; return m.length ? `${L.today} ${m[0][0]}–${m[0][1]}` : L.closed; }
  if (t.hoursMode === 'custom') { const r = (t.hours || []).find(x => x.dow === today); if (!r) return null; return r.closed ? L.closed : `${L.today} ${r.open}–${r.close}`; }
  return null;
}
function keywordsPreview(t, fl) {
  const s = new Set();
  [t.brand.keywordsId, t.brand.keywordsEn].forEach(k => (k || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean).forEach(x => s.add(x)));
  if (fl) s.add(fl.short.toLowerCase()); s.add(t.building === 'ewalk' ? 'e-walk' : 'pentacity');
  return [...s].join(', ') + ' + sinonim kategori';
}
