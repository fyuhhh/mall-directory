// Ops Status — §2.7 / §7.2 #9 (mobile-first): live closures per leg & direction with big switches, quick durations,
// emergency notice. Writes go straight to the status channel (no publish).
import { h, ic, btn, badge, pageHead, field, input, textarea, segmented, toast, dialog, confirmDlg, clear, fmtTime, fmtDate, relTime, emptyState, witaIso, showFieldErrors } from '../ui.js';
import { api, lookups, invalidate } from '../api.js';
import { state, can, floorName, BUILDING_LABEL, BANK_ICON, BANK_TYPE } from '../state.js';
import { closureDialog, endClosure, closureText, mallCloseToday, REASONS } from '../widgets.js';

const tidy = s => String(s || '').replace(/ · /g, '\u00A0· ');
const isEsc = b => b.type === 'escalator' || b.type === 'travelator';

export default async function ops(ctx) {
  ctx.setTitle('Status Ops');
  const canClose = can('status.closures'), canNotice = can('status.notice');
  let building = (() => { try { return localStorage.getItem('bsb-ops-bld') || ''; } catch (e) { return ''; } })();
  const liveEl = h('span');
  ctx.root.classList.add('ops');
  ctx.root.append(pageHead('Status Ops', h('span', 'Tutup/buka eskalator & lift secara live — terkirim ke kiosk ≤ 70 dtk tanpa publish. ', liveEl), [btn('', { icon: 'refresh-cw', title: 'Muat ulang', onClick: () => load(true) })]));
  const noticeEl = h('div'); const filterEl = h('div', { style: { marginBottom: '12px' } }); const listEl = h('div');
  ctx.root.append(noticeEl, filterEl, listEl);
  let banks = [], floors = [], notices = [], settings = {};
  const flBy = {};

  filterEl.append(segmented([{ value: '', label: 'Semua' }, { value: 'pentacity', label: 'Pentacity' }, { value: 'ewalk', label: 'E-Walk' }], building, v => { building = v; try { localStorage.setItem('bsb-ops-bld', v); } catch (e) { } render(); }, 'lg'));

  async function load(manual) {
    invalidate('connectors');
    [banks, floors, notices, settings] = await Promise.all([lookups.connectors(), lookups.floors(), canNotice ? api.get('/notices', null, { silent: true }).then(r => r.data).catch(() => []) : [],
      api.get('/settings', null, { silent: true }).then(r => r.data).catch(() => ({}))]);
    floors.forEach(f => flBy[f.id] = f);
    const st = state.me.live && state.me.live.status;
    clear(liveEl).append(st ? h('span.small', 'Status live ', h('b.mono', st.version.split('-')[0]), ' · ', relTime(st.publishedAt)) : null);
    render(); renderNotice();
    if (manual) toast('Status dimuat ulang', 'info', 1500);
  }
  const timer = setInterval(() => { if (!document.querySelector('dialog[open]')) load(); }, 30000);
  ctx.onLeave(() => clearInterval(timer));

  function renderNotice() {
    clear(noticeEl);
    if (!canNotice) return;
    const act = notices.find(n => n.active);
    if (act) {
      noticeEl.append(h('div', { class: 'notice-card ' + act.level },
        h('div.row', ic(act.level === 'emergency' ? 'siren' : act.level === 'warning' ? 'triangle-alert' : 'info'), h('b.grow', { style: { fontSize: '15px' } }, { info: 'Info', warning: 'Peringatan', emergency: 'DARURAT — layar penuh merah di semua kiosk' }[act.level]),
          btn('Akhiri', { size: 'sm', kind: act.level === 'emergency' ? '' : 'primary', onClick: async () => { if (!(await confirmDlg('Akhiri pengumuman ini di semua kiosk?', { ok: 'Akhiri' }))) return; await api.post(`/notices/${act.id}/end`); toast('Pengumuman diakhiri'); ctx.refreshStatus(); load(); } })),
        h('div', { style: { marginTop: '8px' } }, act.textId), h('div.small', { style: { opacity: .8, marginTop: '2px' } }, act.textEn),
        h('div.small', { style: { opacity: .8, marginTop: '6px' } }, `Sejak ${fmtTime(act.startsAt)} · ${act.endsAt ? 's/d ' + fmtDate(act.endsAt) : 'sampai diakhiri'} · ${act.createdBy || ''}`)));
    } else noticeEl.append(h('div.notice-card', h('div.row.wrap', ic('megaphone'), h('div.grow', h('b', 'Pengumuman kiosk'), h('div.small.muted', 'Tidak ada pengumuman aktif.')), btn('Buat pengumuman', { icon: 'plus', onClick: newNotice }))));
  }
  async function newNotice() {
    let level = 'info', until = 'close';
    const tId = textarea({ name: 'textId', rows: 2, placeholder: 'Lift Pentacity sedang perawatan. Gunakan eskalator B.' });
    const tEn = textarea({ name: 'textEn', rows: 2, placeholder: 'Pentacity lift under maintenance. Please use escalator B.' });
    const body = h('div.stack',
      field('Tingkat', segmented([{ value: 'info', label: 'Info', icon: 'info' }, { value: 'warning', label: 'Peringatan', icon: 'triangle-alert' }, { value: 'emergency', label: 'Darurat', icon: 'siren' }], level, v => { level = v; warn.hidden = v !== 'emergency'; }, 'lg')),
      field('Teks (Indonesia)', tId, { name: 'textId', required: true }), field('Teks (English)', tEn, { name: 'textEn', required: true }),
      field('Sampai', segmented([{ value: '1h', label: '1 jam' }, { value: 'close', label: 'Tutup mall' }, { value: 'open', label: 'Diakhiri manual' }], until, v => until = v)));
    const warn = h('div.callout.danger', { hidden: true }, ic('siren'), 'Darurat = layar penuh merah di SEMUA kiosk, menimpa atraksi & UI sampai diakhiri. Hanya untuk evakuasi/keadaan darurat.');
    body.append(warn);
    const ok = await dialog({ title: 'Pengumuman kiosk', body, actions: [{ label: 'Batal', value: null }, { label: 'Tayangkan', kind: 'primary', icon: 'send', value: true, validate: async () => {
      const o = { level, textId: tId.value.trim(), textEn: tEn.value.trim(), endsAt: until === '1h' ? witaIso(new Date(Date.now() + 3600e3)) : until === 'close' ? mallCloseToday(settings) : null, allKiosks: true };
      if (!o.textId || !o.textEn) { showFieldErrors(body, { textId: o.textId ? undefined : 'required', textEn: o.textEn ? undefined : 'required' }); return false; }
      if (level === 'emergency' && !(await confirmDlg('Tayangkan pengumuman DARURAT layar penuh di semua kiosk?', { danger: true, ok: 'Ya, tayangkan' }))) return false;
      try { await api.post('/notices', o); return true; } catch (e) { if (e.fields) showFieldErrors(body, e.fields); return false; }
    } }] });
    if (ok) { toast('Pengumuman tayang di kiosk (≤ 70 dtk)'); ctx.refreshStatus(); load(); }
  }

  function render() {
    clear(listEl);
    const list = banks.filter(b => b.isEnabled && (!building || b.building === building || b.building === 'both'));
    if (!list.length) { listEl.append(emptyState('Tidak ada bank')); return; }
    for (const b of list) {
      const legs = b.legs.slice().sort((x, y) => (flBy[y.upperFloor]?.level ?? 0) - (flBy[x.upperFloor]?.level ?? 0));
      const bankCl = (legs[0] && legs[0].activeClosures || []).filter(c => c.scope === 'bank');
      const card = h('div.ops-bank', h('div.ops-bank-h', h('span.t-ic', ic(BANK_ICON[b.type])),
        h('div.grow', h('h3', tidy(b.nameId)), h('div.small.muted', [BANK_TYPE[b.type], b.landmarkId].filter(Boolean).join(' · '))),
        canClose && !bankCl.length ? h('button.btn.sm', { type: 'button', onclick: async () => { if (await closureDialog({ type: 'bank', id: b.id, label: b.nameId + ' (semua)' }, { dirs: isEsc(b) ? ['both', 'up', 'down'] : ['both'], settings })) { ctx.refreshStatus(); load(); } } }, ic('wrench'), 'Tutup semua') : null));
      bankCl.forEach(c => card.append(h('div.ops-leg', h('div.row.wrap', h('span.closure-pill', ic('wrench'), 'Seluruh bank: ' + closureText(c)), h('span.grow'),
        canClose ? btn('Buka semua', { size: 'sm', kind: 'primary', onClick: async () => { await endClosure(c, b.nameId); ctx.refreshStatus(); load(); } }) : null))));
      for (const l of legs) {
        const lo = flBy[l.lowerFloor], up = flBy[l.upperFloor];
        const label = `${lo ? lo.short : l.lowerFloor} ↔ ${up ? up.short : l.upperFloor}`;
        const row = h('div.ops-leg', h('div.lg-t', h('span', label), h('span.small.muted', { style: { fontWeight: 500 } }, `L${l.id}`), !l.isEnabled ? badge('Nonaktif — tidak ada di lapangan', '') : null));
        if (!l.isEnabled) { row.style.opacity = .55; card.append(row); continue; }
        const dirs = isEsc(b) ? (l.direction === 'both' ? ['up', 'down'] : [l.direction]) : ['both'];
        const grid = h('div.ops-dirs');
        for (const d of dirs) grid.append(dirButton(b, l, d, label));
        row.append(grid); card.append(row);
      }
      listEl.append(card);
    }
  }
  function dirButton(b, l, d, label) {
    const cls = (l.activeClosures || []).filter(c => c.scope !== 'bank' && (d === 'both' || c.direction === 'both' || c.direction === d));
    const bankCl = (l.activeClosures || []).filter(c => c.scope === 'bank' && (d === 'both' || c.direction === 'both' || c.direction === d));
    const closed = cls.length > 0 || bankCl.length > 0; const c = cls[0] || bankCl[0];
    const name = d === 'up' ? 'Naik' : d === 'down' ? 'Turun' : (b.type === 'lift' ? 'Lift' : 'Lintasan');
    const btnEl = h('button', { type: 'button', class: 'ops-btn' + (closed ? ' closed' : ''), disabled: !canClose || (closed && !cls.length), 'aria-pressed': closed ? 'true' : 'false',
      'aria-label': `${b.nameId} ${label} ${name}: ${closed ? 'perawatan' : 'beroperasi'}` },
      h('span.big', ic(closed ? 'wrench' : d === 'up' ? 'arrow-up' : d === 'down' ? 'arrow-down' : 'check')),
      h('span', h('b', name), h('span', closed ? closureText(Object.assign({}, c, { direction: 'both' })) : 'Beroperasi')));
    btnEl.addEventListener('click', async () => {
      if (!closed) {
        const r = await closureDialog({ type: 'leg', id: l.id, label: `${b.nameId} ${label}${d !== 'both' ? (d === 'up' ? ' ↑ naik' : ' ↓ turun') : ''}` }, { dirs: [d], dir: d, settings });
        if (r) { ctx.refreshStatus(); load(); }
        return;
      }
      if (!(await confirmDlg(`Buka kembali ${b.nameId} ${label}${d !== 'both' ? ' — arah ' + name.toLowerCase() : ''}?`, { title: 'Beroperasi lagi', ok: 'Ya, beroperasi' }))) return;
      // closure covering both directions but only one is reopened → end it and re-close the other direction
      await endClosure(c, `${b.nameId} ${label}`);
      if (c.direction === 'both' && d !== 'both') {
        const other = d === 'up' ? 'down' : 'up';
        await api.post('/closures', { target: { type: 'leg', id: String(l.id) }, direction: other, startsAt: null, endsAt: c.endsAt, reasonEn: c.reasonEn, reasonId: c.reasonId });
        toast(`Arah ${other === 'up' ? 'naik' : 'turun'} tetap ditutup`, 'info');
      }
      ctx.refreshStatus(); load();
    });
    return btnEl;
  }
  await load();
}
