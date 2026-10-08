// Promos — §2.10 / §7.2 #12: list + weekly calendar; editor with schedule (dates, days, hours), weight, target kiosks,
// image/video/text, link; live preview inside a scaled 1920×1080 kiosk attract frame.
import { h, ic, btn, badge, pageHead, field, input, select, toggle, checkbox, segmented, tabs, table, toast, dialog, confirmDlg, clear, card,
  dirtyTracker, showFieldErrors, fmtDate, fmtNum, assetUrl, HARI_S, isoToLocal, localToIso, emptyState, nowWita } from '../ui.js';
import { api, lookups } from '../api.js';
import { can } from '../state.js';
import { mediaPicker } from './media.js';

export const SLOT = { 'attract-hero': 'Kartu promo atraksi (520×380)', 'attract-fullscreen': 'Layar penuh atraksi (1920×1080)', 'panel-banner': 'Banner panel (C · v2)', 'phone-arrival': 'Layar tiba di HP (C · v2)' };
const SLOT_SHORT = { 'attract-hero': 'Kartu atraksi', 'attract-fullscreen': 'Layar penuh', 'panel-banner': 'Banner panel', 'phone-arrival': 'HP tiba' };
const SLOT_SPEC = { 'attract-hero': '1040×760 JPG/PNG/WebP atau MP4 H.264 ≤ 15 MB, ≤ 30 dtk, tanpa audio. Teks penting jauhi 40 px dari tepi.', 'attract-fullscreen': '1920×1080 gambar atau MP4 ≤ 30 MB, ≤ 30 dtk.' };
const ST = { draft: ['Draft', ''], active: ['Aktif', 'ok'], paused: ['Dijeda', 'warn'], archived: ['Arsip', ''] };
const LINK = { none: 'Tidak ada', tenant: 'Tenant', category: 'Kategori', event: 'Event', url: 'URL (tampil QR)' };

/** render the kiosk attract screen with a promo card (shared with Featured/Event previews). */
export function kioskFrame(promo, { featured = [], lang = 'id' } = {}) {
  const frame = h('div.kframe'); const inner = h('div.kf-in');
  frame.append(inner);
  new ResizeObserver(() => { inner.style.transform = `scale(${frame.clientWidth / 1920})`; }).observe(frame);
  inner.style.background = 'radial-gradient(60% 70% at 15% 20%, #FBE9D3 0%, rgba(251,233,211,0) 60%), radial-gradient(50% 60% at 85% 80%, #E3E7F7 0%, rgba(227,231,247,0) 60%), #F5F1EB';
  const fullscreen = promo && promo.slot === 'attract-fullscreen';
  if (!fullscreen) {
    inner.append(
      h('div', { style: { position: 'absolute', left: '80px', top: '56px', width: '84px', height: '84px', borderRadius: '22px', background: '#1D1A17', color: '#F4EBDC', display: 'grid', placeItems: 'center', fontSize: '38px', fontWeight: 800 } }, 'eP'),
      h('div', { style: { position: 'absolute', left: '80px', top: '205px', fontSize: '20px', fontWeight: 800, letterSpacing: '.4em', color: '#B8893B' } }, lang === 'id' ? 'DIREKTORI & NAVIGASI' : 'DIRECTORY & WAYFINDING'),
      h('div', { style: { position: 'absolute', left: '80px', top: '290px', fontSize: '50px', color: '#4A433C', fontWeight: 500 } }, lang === 'id' ? 'Selamat datang di' : 'Welcome to'),
      h('div', { style: { position: 'absolute', left: '76px', top: '340px', fontSize: '124px', fontWeight: 800, letterSpacing: '-.04em', color: '#1D1A17', lineHeight: 1 } }, 'e-Walk ', h('span', { style: { color: '#B8893B' } }, '&'), ' Pentacity'),
      h('div', { style: { position: 'absolute', left: '0', right: '0', top: '728px', display: 'flex', gap: '24px', padding: '0 0 0 40px', overflow: 'hidden' } },
        (featured.length ? featured : Array(7).fill(null)).slice(0, 7).map(f => h('div', { style: { width: '250px', height: '150px', flex: 'none', background: '#FDFCFA', borderRadius: '26px', boxShadow: '0 4px 20px rgba(0,0,0,.05)', display: 'grid', placeItems: 'center' } },
          f && f.logo ? h('img', { src: assetUrl(f.logo), alt: '', style: { maxWidth: '130px', maxHeight: '70px', objectFit: 'contain' } }) : h('span', { style: { width: '120px', height: '14px', borderRadius: '7px', background: '#EDE7DE' } })))),
      h('div', { style: { position: 'absolute', left: '632px', top: '934px', width: '656px', height: '90px', borderRadius: '45px', background: '#1D1A17', color: '#fff', display: 'grid', placeItems: 'center', fontSize: '32px', fontWeight: 800 } }, lang === 'id' ? 'Sentuh layar untuk mulai' : 'Touch to start'));
  }
  if (promo) {
    const box = fullscreen ? { left: '0', top: '0', width: '1920px', height: '1080px', borderRadius: '0' } : { left: '1320px', top: '204px', width: '520px', height: '380px' };
    const c = h('div.att-card', { style: Object.assign({ background: promo.bgColor || '#1D1A17' }, box) });
    const m = promo.kind === 'video' ? (promo.poster || promo.media) : promo.media;
    if (promo.kind !== 'text' && m && m.url) {
      if (promo.kind === 'video' && promo.media && !promo._lite) c.append(h('video', { src: assetUrl(promo.media.url), muted: true, autoplay: true, loop: true, playsinline: true, poster: promo.poster ? assetUrl(promo.poster.url) : null }));
      else c.append(h('img', { src: assetUrl(m.url), alt: '' }));
    } else {
      c.append(h('div', { style: { position: 'absolute', right: '-120px', top: '-60px', width: '420px', height: '420px', borderRadius: '50%', border: '50px solid rgba(255,255,255,.08)' } }));
      const title = lang === 'id' ? (promo.titleId || promo.titleEn) : (promo.titleEn || promo.titleId);
      const sub = lang === 'id' ? (promo.subId || promo.subEn) : (promo.subEn || promo.subId);
      c.append(h('div', { style: { position: 'relative' } }, h('div.k', promo.kind === 'event' ? 'EVENT' : 'PROMO'), h('div.t', { style: fullscreen ? { fontSize: '96px' } : null }, title || 'Judul promo'), sub ? h('div.s', { style: fullscreen ? { fontSize: '36px' } : null }, sub) : null));
    }
    inner.append(c);
  }
  return frame;
}

function activeOnDay(p, day) {
  const s = new Date(p.startsAt), e = new Date(p.endsAt);
  const d0 = new Date(day); d0.setHours(0, 0, 0, 0); const d1 = new Date(day); d1.setHours(23, 59, 59, 999);
  if (e < d0 || s > d1) return false;
  const dow = (day.getDay() + 6) % 7; return !!(p.daysMask & (1 << dow));
}

export default async function promos(ctx) {
  if (ctx.params.id) return editor(ctx);
  ctx.setTitle('Promo');
  const canEdit = can('promos.edit');
  ctx.root.append(pageHead('Promo & iklan', 'Kanal promo dipublish terpisah (promos.json) — tidak menunggu validasi peta.', [
    h('a.btn', { href: '#/publish?tab=promos' }, ic('rocket'), 'Publish promo'), canEdit ? h('a.btn.primary', { href: '#/promos/new' }, ic('plus'), 'Promo baru') : null]));
  const [list, kiosks] = await Promise.all([api.get('/promos').then(r => r.data), lookups.kiosks().catch(() => [])]);
  let st = ctx.query.get('status') || 'current';
  const filt = () => list.filter(p => st === 'all' ? true : st === 'current' ? (p.status === 'active' || p.status === 'paused' || p.status === 'draft') : p.status === st).sort((a, b) => (b.status === 'active') - (a.status === 'active') || b.weight - a.weight);
  const bar = tabs([{ key: 'current', label: 'Berjalan & draft' }, { key: 'active', label: 'Aktif', count: list.filter(p => p.status === 'active').length }, { key: 'archived', label: 'Arsip' }, { key: 'all', label: 'Semua' }], st, k => { st = k; tbl.setRows(filt()); });
  const now = Date.now();
  const tbl = table({ rows: filt(), onRow: p => location.hash = '#/promos/' + p.id, columns: [
    { key: 'sw', label: '', width: '58px', render: p => p.media && p.kind !== 'text' ? h('img.logo-thumb.sm', { src: assetUrl((p.poster || p.media).url), alt: '', style: { objectFit: 'cover' } }) : h('span', { style: { display: 'block', width: '44px', height: '30px', borderRadius: '8px', background: p.bgColor || '#1D1A17' } }) },
    { key: 'titleId', label: 'Judul', sort: true, render: p => h('div', h('div.t-name', p.titleId), h('div.t-sub', [SLOT_SHORT[p.slot], p.advertiserName || p.advertiserTenantId].filter(Boolean).join(' · '))) },
    { key: 'period', label: 'Periode', sort: p => p.startsAt, render: p => h('div.nowrap', h('div', `${fmtDate(p.startsAt, { time: false })} – ${fmtDate(p.endsAt, { time: false })}`), h('div.t-sub', daysText(p.daysMask) + (p.timeFrom ? ` · ${p.timeFrom}–${p.timeTo}` : ''))) },
    { key: 'weight', label: 'Bobot', cls: 'num', sort: true },
    { key: 'targets', label: 'Kiosk', render: p => p.allKiosks ? 'Semua' : `${p.targets.length} kiosk` },
    { key: 'status', label: 'Status', sort: true, render: p => { const live = p.status === 'active' && new Date(p.startsAt) <= now && new Date(p.endsAt) >= now; return h('span.row', { style: { gap: '4px' } }, badge(ST[p.status][0], ST[p.status][1]), p.status === 'active' && !live ? badge(new Date(p.startsAt) > now ? 'Terjadwal' : 'Lewat', 'info') : null); } },
    { key: 'imp', label: 'Impresi / tap', cls: 'num', sort: p => p.stats ? p.stats.impressions : 0, render: p => p.stats ? `${fmtNum(p.stats.impressions)} / ${fmtNum(p.stats.taps)}` : '—' }] });
  ctx.root.append(bar, h('div.card', tbl));

  // week calendar
  const today = nowWita(); const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const days = [...Array(7)].map((_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
  const wk = h('div.week', h('div.wh', 'Promo'), days.map((d, i) => h('div.wh', { style: d.toDateString() === today.toDateString() ? { color: 'var(--ink)' } : null }, `${HARI_S[i]} ${d.getDate()}`)));
  const inWeek = list.filter(p => p.status === 'active' || p.status === 'paused' || p.status === 'draft').filter(p => days.some(d => activeOnDay(p, d)));
  inWeek.forEach(p => { wk.append(h('div', h('a', { href: '#/promos/' + p.id, style: { fontWeight: 650, color: 'inherit' } }, p.titleId)), days.map(d => h('div', activeOnDay(p, d) ? h('div.wb', { title: p.timeFrom ? `${p.timeFrom}–${p.timeTo}` : 'sepanjang hari', style: { background: p.status === 'active' ? (p.bgColor || 'var(--ink)') : 'repeating-linear-gradient(45deg,#ddd 0 6px,#f3f3f3 6px 12px)', opacity: p.status === 'paused' ? .45 : 1 } }) : null))); });
  ctx.root.append(h('div', { style: { marginTop: '18px' } }, card('Kalender minggu ini', inWeek.length ? wk : emptyState('Tidak ada promo minggu ini', 'calendar'), { actions: [h('span.small.muted', 'Arsir = draft · pudar = dijeda')] })));
}
const daysText = m => m === 127 ? 'Setiap hari' : m === 31 ? 'Sen–Jum' : m === 96 ? 'Sab–Min' : HARI_S.filter((_, i) => m & (1 << i)).join(', ');

async function editor(ctx) {
  const isNew = ctx.params.id === 'new';
  const canEdit = can('promos.edit');
  const [kiosks, tenants, cats, events] = await Promise.all([lookups.kiosks().catch(() => []), lookups.tenantsLite().catch(() => []), lookups.categories(), api.get('/events').then(r => r.data).catch(() => [])]);
  const d0 = new Date(); const pad = n => String(n).padStart(2, '0');
  const today = `${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}`;
  let p = isNew ? { titleEn: '', titleId: '', subEn: null, subId: null, kind: 'text', media: null, poster: null, bgColor: '#2F5BEA', slot: 'attract-hero', linkType: 'none', linkRef: null,
    startsAt: today + 'T00:00:00+08:00', endsAt: today.slice(0, 8) + '28T23:59:00+08:00', daysMask: 127, timeFrom: null, timeTo: null, durationSec: 8, weight: 5, status: 'draft', allKiosks: true, targets: [], advertiserTenantId: null, advertiserName: null }
    : (await api.get('/promos/' + ctx.params.id)).data;
  ctx.setTitle(isNew ? 'Promo baru' : p.titleId);
  ctx.root.append(pageHead(isNew ? 'Promo baru' : p.titleId, isNew ? 'Simpan sebagai draft, lalu aktifkan dan publish kanal promo.' : h('span', badge(ST[p.status][0], ST[p.status][1]), p.stats ? `  ${fmtNum(p.stats.impressions)} impresi · ${fmtNum(p.stats.taps)} tap` : ''),
    [!isNew && canEdit ? btn('', { icon: 'trash-2', kind: 'danger', title: 'Hapus', onClick: del }) : null, canEdit ? btn('Simpan', { icon: 'save', kind: 'primary', kbd: 'Ctrl S', onClick: () => tracker.save() }) : null],
    [h('a', { href: '#/promos' }, 'Promo'), ic('chevron-right'), isNew ? 'Baru' : '#' + p.id]));
  const form = h('div.stack', { style: { gap: '16px' } }); const prev = h('div.sticky.stack');
  ctx.root.append(h('div.split', { style: { gridTemplateColumns: 'minmax(0,1fr) 500px' } }, form, prev));
  const tracker = dirtyTracker(form, { onSave: save }); tracker.reset = () => location.reload();
  let pvLang = 'id';
  const upd = () => renderPrev();
  const bind = (k, el, conv = v => v === '' ? null : v) => { el.addEventListener('input', () => { p[k] = conv(el.value); upd(); }); el.addEventListener('change', () => { p[k] = conv(el.value); upd(); }); return el; };
  const I = (k, a = {}) => bind(k, input(Object.assign({ value: p[k] ?? '', disabled: !canEdit }, a)), a.type === 'number' ? v => v === '' ? null : +v : undefined);

  // content
  const kindSeg = segmented([{ value: 'text', label: 'Kartu warna', icon: 'type' }, { value: 'image', label: 'Gambar', icon: 'image' }, { value: 'video', label: 'Video', icon: 'video' }], p.kind, v => { p.kind = v; tracker.set(true); renderMedia(); upd(); });
  const mediaBox = h('div.stack');
  function renderMedia() {
    clear(mediaBox);
    if (p.kind === 'text') { mediaBox.append(field('Warna latar', h('div.row', bind('bgColor', input({ type: 'color', value: p.bgColor || '#2F5BEA', disabled: !canEdit, style: { width: '64px', padding: '3px' } })), h('span.small.muted', 'Kartu teks seperti placeholder kiosk sekarang.')))); return; }
    const pick = (key, kind) => h('div.row', p[key] ? h('img.logo-thumb', { src: assetUrl(p[key].url), alt: '', style: { objectFit: 'cover', width: '96px', height: '64px' } }) : h('span.muted.small', 'Belum dipilih'),
      btn('Pilih / unggah', { size: 'sm', icon: 'image-plus', disabled: !canEdit, onClick: async () => { const m = await mediaPicker(kind); if (m) { p[key] = { id: m.id, url: m.url }; tracker.set(true); renderMedia(); upd(); } } }),
      p[key] ? btn('', { size: 'sm', icon: 'x', kind: 'ghost', title: 'Lepas', onClick: () => { p[key] = null; tracker.set(true); renderMedia(); upd(); } }) : null);
    mediaBox.append(field(p.kind === 'video' ? 'Video MP4' : 'Gambar', pick('media', p.kind === 'video' ? 'video' : 'image'), { hint: SLOT_SPEC[p.slot] || '' }));
    if (p.kind === 'video') mediaBox.append(field('Poster (wajib untuk mode lite / Smart TV)', pick('poster', 'image'), { hint: 'Kiosk lite menampilkan poster, bukan video.' }));
  }
  renderMedia();
  form.append(card('Konten', h('div.stack',
    h('div.lang-pair', field(h('span', h('span.lang-tag', 'ID'), ' Judul'), I('titleId', { placeholder: 'Weekend Fashion Week' }), { name: 'titleId', required: true }), field(h('span', h('span.lang-tag', 'EN'), ' Judul'), I('titleEn'), { name: 'titleEn', required: true })),
    h('div.lang-pair', field(h('span', h('span.lang-tag', 'ID'), ' Subjudul'), I('subId', { placeholder: 'Diskon s.d. 50%…' })), field(h('span', h('span.lang-tag', 'EN'), ' Subjudul'), I('subEn'))),
    field('Jenis', kindSeg), mediaBox,
    h('div.form.cols-2', field('Slot', bind('slot', select(Object.entries(SLOT).map(([k, v]) => [k, v]), p.slot, { disabled: !canEdit }))),
      field('Durasi tampil (detik)', I('durationSec', { type: 'number', min: 3, max: 30 }), { hint: 'Default 8; video = durasi video, maks 30.' })))));
  // link
  const refBox = h('div');
  const renderRef = () => {
    clear(refBox);
    if (p.linkType === 'tenant') refBox.append(field('Tenant', bind('linkRef', select([['', '— pilih —'], ...tenants.map(t => [t.id, t.displayName])], p.linkRef, { disabled: !canEdit }))));
    if (p.linkType === 'category') refBox.append(field('Kategori', bind('linkRef', select([['', '— pilih —'], ...cats.map(c => [c.id, c.nameId])], p.linkRef, { disabled: !canEdit }))));
    if (p.linkType === 'event') refBox.append(field('Event', bind('linkRef', select([['', '— pilih —'], ...events.map(e => [e.id, e.titleId])], p.linkRef, { disabled: !canEdit }))));
    if (p.linkType === 'url') refBox.append(field('URL', I('linkRef', { type: 'url', placeholder: 'https://…' }), { name: 'linkRef', hint: 'Ditampilkan sebagai QR saat promo disentuh.' }));
  };
  const linkSel = bind('linkType', select(Object.entries(LINK), p.linkType, { disabled: !canEdit })); linkSel.addEventListener('change', () => { p.linkRef = null; renderRef(); });
  renderRef();
  form.append(card('Saat promo disentuh', h('div.form.cols-2', field('Tautan', linkSel), refBox)));

  // schedule
  const days = h('div.row.wrap', { style: { gap: '6px' } });
  const renderDays = () => { clear(days); HARI_S.forEach((d, i) => days.append(h('button', { type: 'button', class: 'chip' + (p.daysMask & (1 << i) ? ' on' : ''), disabled: !canEdit, onclick: () => { p.daysMask ^= (1 << i); tracker.set(true); renderDays(); } }, d))); days.append(h('span.small.muted', { style: { marginLeft: '6px' } }, daysText(p.daysMask))); };
  renderDays();
  const sIn = input({ type: 'datetime-local', value: isoToLocal(p.startsAt), disabled: !canEdit }); sIn.addEventListener('change', () => { p.startsAt = localToIso(sIn.value); });
  const eIn = input({ type: 'datetime-local', value: isoToLocal(p.endsAt), disabled: !canEdit }); eIn.addEventListener('change', () => { p.endsAt = localToIso(eIn.value); });
  const weight = input({ type: 'range', min: 1, max: 10, value: p.weight, disabled: !canEdit, style: { flex: 1 } }); const wv = h('b.num', { style: { width: '24px' } }, String(p.weight));
  weight.addEventListener('input', () => { p.weight = +weight.value; wv.textContent = weight.value; });
  const stSeg = segmented(Object.entries(ST).map(([k, v]) => ({ value: k, label: v[0] })), p.status, v => { p.status = v; tracker.set(true); });
  form.append(card('Jadwal & prioritas', h('div.form.cols-2',
    field('Mulai', sIn, { name: 'startsAt', required: true }), field('Selesai', eIn, { name: 'endsAt', required: true }),
    field('Hari tayang', days, { span: 'span-2', name: 'daysMask' }),
    field('Jam dari', I('timeFrom', { type: 'time' }), { hint: 'Kosong = sepanjang jam mall' }), field('Jam sampai', I('timeTo', { type: 'time' })),
    field('Bobot (frekuensi tampil)', h('div.row', h('span.small.muted', '1'), weight, h('span.small.muted', '10'), wv), { span: 'span-2', hint: 'Rotasi smooth weighted round-robin: bobot 10 tampil ±2× lebih sering dari bobot 5.' }),
    field('Status', stSeg, { span: 'span-2' }))));

  // targets
  const tBox = h('div.row.wrap', { style: { gap: '6px' } });
  const renderTargets = () => { clear(tBox); kiosks.forEach(k => tBox.append(h('button', { type: 'button', class: 'chip' + (p.targets.includes(k.id) ? ' on' : ''), disabled: !canEdit || p.allKiosks, onclick: () => { p.targets = p.targets.includes(k.id) ? p.targets.filter(x => x !== k.id) : [...p.targets, k.id]; tracker.set(true); renderTargets(); } }, k.name))); };
  renderTargets();
  form.append(card('Target kiosk & pengiklan', h('div.stack',
    toggle(p.allKiosks, 'Semua kiosk', { disabled: !canEdit, onchange: e => { p.allKiosks = e.target.checked; renderTargets(); } }), tBox,
    h('div.form.cols-2', field('Tenant pengiklan', bind('advertiserTenantId', select([['', '— bukan tenant —'], ...tenants.map(t => [t.id, t.displayName])], p.advertiserTenantId, { disabled: !canEdit }))),
      field('Nama pengiklan', I('advertiserName', { placeholder: 'Pihak luar / internal' }))))));
  form.append(tracker.el);

  function renderPrev() {
    clear(prev).append(h('div.row', h('span.kicker.grow', 'Pratinjau layar atraksi kiosk'), segmented([{ value: 'id', label: 'ID' }, { value: 'en', label: 'EN' }], pvLang, v => { pvLang = v; renderPrev(); })),
      kioskFrame(p, { lang: pvLang }),
      h('div.small.muted', p.slot === 'attract-fullscreen' ? 'Takeover layar penuh tiap 4 putaran promo.' : 'Kartu promo 520×380 di kanan atas layar atraksi. Mode lite: video diganti poster.'),
      p.stats && p.stats.impressions ? card('Statistik', h('dl.kv', h('dt', 'Impresi'), h('dd', fmtNum(p.stats.impressions)), h('dt', 'Tap'), h('dd', fmtNum(p.stats.taps)), h('dt', 'CTR'), h('dd', (100 * p.stats.taps / p.stats.impressions).toFixed(2).replace('.', ',') + '%'))) : null);
  }
  renderPrev();

  async function save() {
    const errs = {};
    if (!p.titleId) errs.titleId = 'required'; if (!p.titleEn) errs.titleEn = 'required';
    if (!p.startsAt) errs.startsAt = 'required'; if (!p.endsAt) errs.endsAt = 'required';
    if (p.startsAt && p.endsAt && new Date(p.endsAt) < new Date(p.startsAt)) errs.endsAt = 'Harus setelah tanggal mulai';
    if (!p.daysMask) errs.daysMask = 'Pilih minimal satu hari';
    if (p.linkType === 'url' && p.linkRef && !/^https:\/\//.test(p.linkRef)) errs.linkRef = 'https';
    if (p.kind !== 'text' && !p.media) toast('Belum ada media — promo akan tampil sebagai kartu warna', 'warn');
    if (p.kind === 'video' && !p.poster) toast('Video tanpa poster tidak tampil di mode lite', 'warn');
    if (Object.keys(errs).length) { showFieldErrors(form, errs); return false; }
    const body = Object.assign({}, p); delete body.stats; delete body.etag; if (body.allKiosks) body.targets = [];
    try {
      const r = isNew ? await api.post('/promos', body) : await api.put('/promos/' + p.id, body, p.etag);
      toast('Promo disimpan — publish kanal promo agar tayang'); ctx.refreshStatus();
      if (isNew) { tracker.set(false); location.hash = '#/promos/' + r.data.id; } else p = Object.assign(p, r.data);
      return true;
    } catch (e) { if (e.fields) showFieldErrors(form, e.fields); return false; }
  }
  async function del() { if (!(await confirmDlg('Hapus promo ini? Pertimbangkan status "Arsip" agar statistik tetap tersimpan.', { danger: true, ok: 'Hapus' }))) return; await api.del('/promos/' + p.id); tracker.set(false); toast('Promo dihapus'); location.hash = '#/promos'; }
}
