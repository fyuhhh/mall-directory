// Floors — §2.4 / §7.2 #6: list; edit names, unit scale, north dial, focus boxes (drag rect), replace SVG (2-step).
import { h, ic, btn, badge, pageHead, field, input, toast, dialog, clear, card, svgEl, dirtyTracker, showFieldErrors, segmented, fmtBytes, confirmDlg } from '../ui.js';
import { api, lookups, invalidate } from '../api.js';
import { can, floorName, BUILDING_LABEL } from '../state.js';
import { dial } from '../widgets.js';
import { MapCanvas } from '../mapcanvas.js';

export default async function floors(ctx) {
  ctx.setTitle('Lantai');
  const canEdit = can('floors.edit');
  ctx.root.append(pageHead('Lantai', 'Denah SVG per lantai/gedung. Koordinat tenant, kiosk & graph memakai viewBox SVG ini.'));
  let list = await lookups.floors();
  const settings = await api.get('/settings', null, { silent: true }).then(r => r.data).catch(() => ({}));
  let cur = list.find(f => f.id === ctx.query.get('id')) || list.find(f => f.id === 'gf') || list[0];
  const listEl = h('div.card'); const detail = h('div.stack', { style: { gap: '16px' } });
  ctx.root.append(h('div.split.l', listEl, detail));
  let mc = null;
  ctx.onLeave(() => mc && mc.destroy());

  function renderList() {
    clear(listEl);
    [...list].sort((a, b) => b.level - a.level || a.building.localeCompare(b.building)).forEach(f => listEl.append(h('div.row', {
      style: { padding: '10px 14px', borderBottom: '1px solid var(--line)', cursor: 'pointer', background: f.id === cur.id ? 'var(--accent-soft)' : null }, tabIndex: 0,
      onclick: () => select(f), onkeydown: e => { if (e.key === 'Enter') select(f); } },
      h('b', { style: { width: '42px', height: '30px', borderRadius: '8px', background: 'var(--ink)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: '13px', flex: 'none' } }, f.short),
      h('div.grow', h('div', { style: { fontWeight: 650 } }, f.nameId || f.nameEn), h('div.small.muted', `${BUILDING_LABEL[f.building]} · level ${f.level} · skala ${f.unitScale}`)),
      f.northDeg == null ? badge('Utara?', 'warn', 'compass') : badge(f.northDeg + '°', 'ok', 'compass'))));
  }
  function select(f) { if (tracker && tracker.dirty && !confirm('Buang perubahan lantai ini?')) return; cur = f; history.replaceState(null, '', '#/floors?id=' + f.id); renderList(); renderDetail(); }

  let tracker = null, focusMode = null, draft = null;
  function renderDetail() {
    clear(detail); draft = JSON.parse(JSON.stringify(cur));
    if (mc) { mc.destroy(); mc = null; }
    const mapHost = h('div', { style: { height: '470px', position: 'relative' } });
    const shapeInfo = h('span.small.muted', `viewBox ${cur.viewBox.join(' ')}`);
    const focusSeg = segmented([{ value: '', label: 'Lihat', icon: 'hand' }, ...(cur.building === 'both' ? ['pentacity', 'ewalk'] : [cur.building]).map(b => ({ value: b, label: 'Focus ' + BUILDING_LABEL[b], icon: 'focus' }))], '', v => { focusMode = v || null; mc.capture = !!focusMode; mc.setCursor(focusMode ? 'crosshair' : null); mc.hint(focusMode ? `Seret persegi untuk area fokus ${BUILDING_LABEL[focusMode]} (dipakai kamera kiosk saat membuka lantai ini).` : ''); });
    if (!canEdit) [...focusSeg.children].slice(1).forEach(b => b.disabled = true);
    detail.append(card(h('div.row', h('h3', floorName(cur)), h('span.mono.small.muted', cur.id)), h('div.stack', h('div.row', focusSeg, h('span.grow'), shapeInfo), mapHost)));
    mc = new MapCanvas(mapHost, { floors: [cur], floorId: cur.id, picker: false, height: '100%', onRender: drawFocus, coords: true });
    mc.ready.then(() => { if (!mc || !mc.floorSvg) return; const u = mc.floorSvg.querySelectorAll('[id^="unit-"]').length, sh = mc.floorSvg.querySelectorAll('path,rect,polygon,ellipse').length; shapeInfo.textContent = `viewBox ${cur.viewBox.join(' ')} · ${sh} shape · ${u} unit tertaut`; });
    // drag rect for focus boxes
    let drag = null;
    mc.svg.addEventListener('pointerdown', e => { if (!focusMode || e.button !== 0) return; e.stopPropagation(); const p = mc.toSvg(e); drag = { x0: p.x, y0: p.y }; mc.svg.setPointerCapture(e.pointerId); }, true);
    mc.svg.addEventListener('pointermove', e => { if (!drag) return; const p = mc.toSvg(e); draft.focus[focusMode] = [Math.min(drag.x0, p.x), Math.min(drag.y0, p.y), Math.abs(p.x - drag.x0), Math.abs(p.y - drag.y0)].map(v => +v.toFixed(1)); drawFocus(); });
    mc.svg.addEventListener('pointerup', () => { if (!drag) return; drag = null; tracker.set(true); });

    const form = h('div.form.cols-2',
      field('Nama (Indonesia)', input({ name: 'nameId', value: draft.nameId, disabled: !canEdit }), { name: 'nameId' }),
      field('Nama (English)', input({ name: 'nameEn', value: draft.nameEn, disabled: !canEdit }), { name: 'nameEn' }),
      field('Kode singkat', input({ name: 'short', value: draft.short, disabled: !canEdit, class: 'inp mono' }), { name: 'short' }),
      field('Skala unit (unit_scale)', input({ name: 'unitScale', type: 'number', step: '0.0001', value: draft.unitScale, disabled: !canEdit }), { name: 'unitScale', hint: 'Biaya koridor = panjang × skala. Perkiraan ±30 % — koreksi dengan jarak terukur di lapangan.' }),
      h('div.span-2', field('Arah utara (north_deg)', dial(draft.northDeg, v => { draft.northDeg = v; tracker.set(true); }, { disabled: !canEdit, label: 'utara' }), { hint: `Derajat kompas dari "atas" peta. Kosong = ikut global (${settings['map.northDeg'] ?? 'belum diisi'}).` })));
    form.addEventListener('input', e => { const n = e.target.name; if (!n) return; draft[n] = e.target.type === 'number' ? (e.target.value === '' ? null : +e.target.value) : e.target.value; });
    const focusInfo = h('div.small.muted');
    const fi = () => { clear(focusInfo).append(...Object.entries(draft.focus || {}).map(([b, r]) => h('div', h('b', 'Focus ' + BUILDING_LABEL[b] + ': '), h('span.mono', r.map(v => Math.round(v)).join(', '))))); };
    fi();
    detail.append(card('Properti lantai', h('div.stack', form, focusInfo)));
    tracker = dirtyTracker(detail, { onSave: async () => {
      try {
        const body = { nameId: draft.nameId, nameEn: draft.nameEn, short: draft.short, unitScale: draft.unitScale, northDeg: draft.northDeg, focus: draft.focus };
        const r = await api.put('/floors/' + cur.id, body, cur.etag);
        Object.assign(cur, r.data); invalidate('floors'); list = await lookups.floors(); cur = list.find(f => f.id === r.data.id);
        toast('Lantai disimpan'); renderList(); ctx.refreshStatus(); return true;
      } catch (e) { if (e.fields) showFieldErrors(detail, e.fields); return false; }
    } });
    tracker.reset = () => renderDetail();
    const origDraw = drawFocus;
    detail.append(card('Ganti SVG denah', svgReplace(), { cls: '' }), tracker.el);
    function drawFocus() { if (!mc) return; const g = mc.layer('focus'); for (const [b, r] of Object.entries(draft.focus || {})) { g.append(svgEl('rect', { x: r[0], y: r[1], width: r[2], height: r[3], class: 'ov-focus' }), svgEl('text', { x: r[0] + mc.px(6), y: r[1] + mc.px(16), 'font-size': mc.px(13), class: 'ov-label', text: 'Focus ' + BUILDING_LABEL[b] })); } fi(); }
  }

  function svgReplace() {
    const wrap = h('div.stack');
    const fileIn = h('input', { type: 'file', accept: '.svg,image/svg+xml', hidden: true, onchange: async e => {
      const file = e.target.files[0]; if (!file) return;
      clear(report).append(h('div.loading', h('span.spinner'), 'Sanitasi & analisis SVG…'));
      try {
        const r = (await api.upload('/floors/' + cur.id + '/svg', file)).data; const rp = r.report;
        clear(report).append(
          rp.viewBoxChanged ? h('div.callout.danger', ic('triangle-alert'), h('div', h('b', 'viewBox berubah! '), 'Koordinat tenant, kiosk & graph TIDAK otomatis dipindah. Lanjutkan hanya jika denah baru sudah diregistrasi ulang.')) : h('div.callout.ok', ic('circle-check'), 'viewBox sama — koordinat lama tetap valid.'),
          h('dl.kv', h('dt', 'Ukuran'), h('dd', `${fmtBytes(rp.bytesIn)} → ${fmtBytes(rp.bytesOut)}`),
            h('dt', 'viewBox lama → baru'), h('dd.mono', `${(rp.viewBoxOld || []).join(' ')} → ${(rp.viewBoxNew || []).join(' ')}`),
            h('dt', 'Elemen dibuang'), h('dd', Object.entries(rp.removed || {}).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'tidak ada'),
            h('dt', 'Jumlah shape'), h('dd', String(rp.shapes)),
            h('dt', 'Unit hilang'), h('dd', rp.missingUnitShapes && rp.missingUnitShapes.length ? h('span', { style: { color: 'var(--danger)', fontWeight: 650 } }, rp.missingUnitShapes.join(', ')) : 'tidak ada')),
          h('div.row', btn('Batal', { onClick: () => clear(report) }), btn('Konfirmasi ganti SVG', { kind: rp.viewBoxChanged ? 'danger solid' : 'primary', icon: 'check', onClick: async () => {
            if (rp.viewBoxChanged && !(await confirmDlg('viewBox berbeda. Yakin mengganti denah?', { danger: true, ok: 'Ganti' }))) return;
            await api.post('/floors/' + cur.id + '/svg/confirm', { uploadToken: r.uploadToken }); toast('SVG lantai diganti — publish untuk mengirim ke kiosk'); invalidate('floors'); clear(report); ctx.refreshStatus();
          } })));
      } catch (err) { clear(report); }
      fileIn.value = '';
    } });
    const report = h('div.stack');
    wrap.append(h('p.small.muted', 'Alur 2 langkah: unggah → laporan sanitasi (script/foreignObject/href eksternal dibuang, shape tanpa id diberi id shp-n) → konfirmasi. Maks 8 MB.'),
      h('div.row', fileIn, btn('Unggah SVG baru…', { icon: 'file-up', disabled: !canEdit, onClick: () => fileIn.click() })), report);
    return wrap;
  }
  renderList(); renderDetail();
}
