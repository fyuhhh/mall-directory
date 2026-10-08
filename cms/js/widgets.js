// Domain-specific UI pieces reused across pages.
import { h, ic, badge, assetUrl, initials, fmtTime, fmtDate, relTime, dialog, segmented, field, input, isoToLocal, localToIso, nowWita, witaIso, toast } from './ui.js';
import { STATUS_LABEL, STATUS_TONE, BUILDING_LABEL, floorName } from './state.js';
import { api } from './api.js';

export const CLIENT_LABEL = { windows_pc: 'PC Windows', smart_tv: 'Smart TV', android_box: 'Android box', other: 'Lainnya' };
export const STATE_LABEL = { online: 'Online', stale: 'Versi lama', offline: 'Offline' };
export const STATE_TONE = { online: 'ok', stale: 'warn', offline: 'danger' };

export function kioskState(k) { const s = (k.runtime && k.runtime.state) || 'offline'; return h('span.row', { style: { gap: '7px' } }, h('span', { class: 'dot ' + STATE_TONE[s] }), h('b', { style: { fontSize: '13px' } }, STATE_LABEL[s])); }
/** "TV · lite (auto: deviceMemory≤2)" — §6.8(6) */
export function perfBadge(k) {
  const rt = k.runtime || {}; const act = rt.perfActive || (k.perfMode === 'auto' ? null : k.perfMode);
  const dev = k.clientType === 'smart_tv' ? 'TV' : k.clientType === 'windows_pc' ? 'PC' : k.clientType === 'android_box' ? 'Android' : 'Lain';
  const reason = rt.perfReason ? ' (' + rt.perfReason.replace('<=', '≤').replace('auto:', 'auto: ') + ')' : '';
  return badge(`${dev} · ${act || 'auto'}${reason}`, act === 'lite' ? 'gold' : 'outline', k.clientType === 'smart_tv' ? 'tv' : 'monitor');
}
export function statusBadge(st) { return badge(STATUS_LABEL[st] || st, STATUS_TONE[st] || ''); }
export function logoThumb(logo, name, sm = true) {
  return logo && logo.url ? h('img', { class: 'logo-thumb' + (sm ? ' sm' : ''), src: assetUrl(logo.url), alt: '', loading: 'lazy' }) : h('span.logo-ph', { title: 'Belum ada logo' }, initials(name));
}
export function floorOptions(floors, { empty } = {}) {
  const o = empty ? [['', empty]] : [];
  floors.forEach(f => o.push([f.id, floorName(f)]));
  return o;
}
export const dirArrow = d => d === 'up' ? '↑' : d === 'down' ? '↓' : '↕';
export function closureText(c) {
  const d = c.direction === 'both' ? '' : (c.direction === 'up' ? '↑ naik ' : '↓ turun ');
  return `${d}${c.reasonId || c.reasonEn || 'Ditutup'} · ${c.endsAt ? 's/d ' + (sameDay(c.endsAt) ? fmtTime(c.endsAt) : fmtDate(c.endsAt)) : 'sampai dibuka'}`;
}
const sameDay = s => fmtDate(s, { time: false }) === fmtDate(new Date().toISOString(), { time: false });

export const REASONS = [
  { id: 'Perawatan', en: 'Maintenance' }, { id: 'Rusak', en: 'Out of order' }, { id: 'Pembersihan', en: 'Cleaning' }, { id: 'Acara', en: 'Event' }];

/** Mall closing time today from settings 'mall.hours' map {"1":[["10:00","22:00"]]} — default 22:00. */
export function mallCloseToday(settings) {
  const d = nowWita(); const dow = d.getDay() || 7;
  const iv = settings && settings['mall.hours'] && settings['mall.hours'][String(dow)];
  const close = iv && iv.length ? iv[iv.length - 1][1] : '22:00';
  const [hh, mm] = close.split(':').map(Number);
  const t = new Date(Date.now()); // compute in WITA wall time then back to ISO +08:00
  const w = nowWita(); w.setHours(hh, mm, 0, 0);
  const pad = n => String(n).padStart(2, '0');
  return `${w.getFullYear()}-${pad(w.getMonth() + 1)}-${pad(w.getDate())}T${pad(hh)}:${pad(mm)}:00+08:00`;
}

/**
 * Closure dialog (used by connector panel & Ops page). Returns API response data or null.
 * target = {type:'leg'|'bank'|'edge'|'amenity', id, label}; dirs = allowed directions.
 */
export async function closureDialog(target, { dirs = ['both', 'up', 'down'], dir = 'both', settings } = {}) {
  let direction = dir, reason = REASONS[0], until = 'close', custom = '';
  const body = h('div.stack');
  const optsDir = [{ value: 'both', label: 'Kedua arah', icon: 'arrow-up-down' }, { value: 'up', label: 'Naik saja', icon: 'arrow-up' }, { value: 'down', label: 'Turun saja', icon: 'arrow-down' }].filter(o => dirs.includes(o.value));
  const reasonWrap = h('div.sheet-opts');
  const mkReason = () => { reasonWrap.replaceChildren(...REASONS.map(r => h('button', { type: 'button', class: 'chip' + (r === reason ? ' on' : ''), onclick: () => { reason = r; mkReason(); } }, r.id))); };
  mkReason();
  const custIn = input({ type: 'datetime-local', value: isoToLocal(witaIso(new Date(Date.now() + 2 * 3600e3))), style: { maxWidth: '240px' } });
  const untilWrap = h('div.sheet-opts');
  const UNT = [['1h', '1 jam'], ['close', 'Sampai tutup mall'], ['open', 'Sampai dibuka manual'], ['custom', 'Pilih waktu…']];
  const mkUntil = () => { untilWrap.replaceChildren(...UNT.map(([k, l]) => h('button', { type: 'button', class: 'chip' + (k === until ? ' on' : ''), onclick: () => { until = k; mkUntil(); custIn.hidden = k !== 'custom'; } }, l))); };
  mkUntil(); custIn.hidden = true;
  body.append(
    h('div.callout.muted', ic('wrench'), h('div', h('b', target.label), h('div.small', 'Perubahan langsung dikirim ke semua kiosk (kanal status) — tanpa publish.'))),
    optsDir.length > 1 ? h('div.field', h('div.lbl', 'Arah yang ditutup'), segmented(optsDir, direction, v => direction = v, 'lg')) : null,
    h('div.field', h('div.lbl', 'Alasan'), reasonWrap),
    h('div.field', h('div.lbl', 'Sampai kapan'), untilWrap, custIn));
  const okv = await dialog({ title: 'Tutup sementara', body, actions: [{ label: 'Batal', value: null }, { label: 'Tutup sekarang', kind: 'danger solid', icon: 'wrench', value: true, autofocus: true }] });
  if (!okv) return null;
  const endsAt = until === '1h' ? witaIso(new Date(Date.now() + 3600e3)) : until === 'close' ? mallCloseToday(settings) : until === 'open' ? null : localToIso(custIn.value);
  const r = await api.post('/closures', { target: { type: target.type, id: String(target.id) }, direction, startsAt: null, endsAt, reasonEn: reason.en, reasonId: reason.id });
  toast(`${target.label} ditutup — status kiosk ${r.data.statusVersion ? r.data.statusVersion.split('-')[0] : ''} terkirim`);
  await showImpact(r.data.impact);
  return r.data;
}
export async function showImpact(impact) {
  if (!impact) return;
  const d = impact.unreachableDefault || [], a = impact.unreachableAccessible || [];
  if (!d.length && !a.length) { toast('Dampak: semua tenant tetap terjangkau dari kiosk.', 'ok'); return; }
  const list = (arr) => h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px', maxHeight: '180px', overflow: 'auto' } }, arr.slice(0, 40).map(x => h('li', (x.name || x.tenant) + (x.fromKiosks ? ` — dari ${x.fromKiosks.length} kiosk` : ''))));
  await dialog({ title: 'Dampak penutupan', body: h('div.stack',
    d.length ? h('div.callout.danger', ic('triangle-alert'), h('div', h('b', `${d.length} tenant tidak terjangkau (rute biasa)`), list(d))) : h('div.callout.ok', ic('circle-check'), 'Rute biasa: semua tenant tetap terjangkau.'),
    a.length ? h('div.callout.warn', ic('accessibility'), h('div', h('b', `${a.length} tenant tidak terjangkau rute kursi roda`), list(a))) : null,
    h('p.small.muted', 'Kiosk akan menampilkan "rute tidak tersedia — silakan ke Information Desk" untuk tujuan ini.')) });
}
export async function endClosure(c, label) {
  const r = await api.post(`/closures/${c.id}/end`);
  toast(`${label || 'Penutupan'} dibuka kembali`);
  return r.data;
}

/** Rotary dial 0–359° (kiosk facing, floor north). Drag, click, arrows (±1, Shift ±15). onChange(deg|null) */
export function dial(value, onChange, { disabled, nullable = true, label = 'arah' } = {}) {
  const needle = h('div.needle'); const num = input({ type: 'number', min: 0, max: 359, step: 1, value: value ?? '', class: 'inp sm', style: { width: '76px' }, disabled, 'aria-label': 'Derajat ' + label });
  const d = h('div.dial', { tabIndex: disabled ? -1 : 0, role: 'slider', 'aria-valuemin': 0, 'aria-valuemax': 359, 'aria-label': 'Dial ' + label },
    h('span.lbl', { style: { left: '50%', top: '6px', transform: 'translateX(-50%)' } }, '0°'), h('span.lbl', { style: { right: '7px', top: '50%', transform: 'translateY(-50%)' } }, '90'),
    h('span.lbl', { style: { left: '50%', bottom: '6px', transform: 'translateX(-50%)' } }, '180'), h('span.lbl', { style: { left: '7px', top: '50%', transform: 'translateY(-50%)' } }, '270'),
    needle, h('div.hub'));
  const set = (v, fire = true) => {
    value = v == null || v === '' || isNaN(v) ? null : ((Math.round(v) % 360) + 360) % 360;
    needle.style.display = value == null ? 'none' : ''; needle.style.transform = `rotate(${value || 0}deg)`;
    num.value = value ?? ''; d.setAttribute('aria-valuenow', value ?? '');
    if (fire) onChange && onChange(value);
  };
  const fromEvt = e => { const r = d.getBoundingClientRect(); const a = Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) * 180 / Math.PI; return (a + 360) % 360; };
  if (!disabled) {
    d.addEventListener('pointerdown', e => { d.setPointerCapture(e.pointerId); set(e.shiftKey ? fromEvt(e) : Math.round(fromEvt(e) / 5) * 5); const mv = ev => set(ev.shiftKey ? fromEvt(ev) : Math.round(fromEvt(ev) / 5) * 5); d.addEventListener('pointermove', mv); d.addEventListener('pointerup', () => d.removeEventListener('pointermove', mv), { once: true }); });
    d.addEventListener('keydown', e => { const st = e.shiftKey ? 15 : 1; if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { set((value || 0) + st); e.preventDefault(); } if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { set((value || 0) - st); e.preventDefault(); } });
    num.addEventListener('input', () => set(num.value === '' ? null : +num.value));
  }
  set(value, false);
  const wrap = h('div.stack', { style: { gap: '8px' } }, h('div.row', { style: { gap: '14px', alignItems: 'center' } }, d, h('div.stack', { style: { gap: '6px', minWidth: '120px' } }, h('div.row', { style: { gap: '6px' } }, num, h('span.muted', '°')),
    nullable && !disabled ? h('button.btn.sm.ghost', { type: 'button', onclick: () => set(null), style: { alignSelf: 'flex-start' } }, 'Kosongkan') : null)),
    h('span.small.muted', 'Seret jarum (kelipatan 5°, Shift = bebas), panah keyboard, atau ketik.'));
  wrap.setValue = v => set(v, false);
  return wrap;
}

const scripts = {};
export function loadScript(src) {
  if (!scripts[src]) scripts[src] = new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Gagal memuat ' + src)); document.head.append(s); });
  return scripts[src];
}
/** QR as SVG markup using the kiosk's vendored generator (offline). */
export async function qrSvg(text) {
  await loadScript('../assets/vendor/qrcode.min.js'); await loadScript('../js/qr.js');
  return window.BSB.qrSvg(text, { margin: 2 });
}
export async function copyText(t, label = 'Disalin') {
  try { await navigator.clipboard.writeText(t); toast(label); }
  catch (e) { const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }); ta.value = t; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast(label); }
}
