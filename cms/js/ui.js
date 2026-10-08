// Small DOM/UI toolkit for the CMS. All user data is rendered via textContent (never innerHTML) — CMS_SPEC §8.1.
import { icon } from './icons.js';

// Native append()/prepend()/replaceChildren() turn null into the text "null"; the CMS builds DOM with optional
// children everywhere, so skip null/false/undefined consistently.
for (const P of [Element.prototype, DocumentFragment.prototype]) {
  for (const m of ['append', 'prepend', 'replaceChildren']) {
    const orig = P[m];
    P[m] = function (...a) { return orig.apply(this, a.filter(x => x != null && x !== false)); };
  }
}

/** h('div.card#id', {attrs}, ...children) — children: Node | string | number | array | null */
export function h(sel, attrs, ...kids) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) { kids.unshift(attrs); attrs = {}; }
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(sel) || [];
  const el = document.createElement(m[1] || 'div');
  (m[2] || '').replace(/([.#])([\w-]+)/g, (_, t, v) => { if (t === '.') el.classList.add(v); else el.id = v; });
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') { String(v).split(/\s+/).filter(Boolean).forEach(c => el.classList.add(c)); }
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'html') el.innerHTML = v; // trusted markup only (icons)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' && ('value' in el)) el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'readOnly' || k === 'multiple') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
export function append(el, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const ic = (name, cls) => { const t = document.createElement('template'); t.innerHTML = icon(name, cls); return t.content.firstChild; };
export const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function svgEl(tag, attrs = {}, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const k in attrs) {
    const v = attrs[k]; if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c) el.appendChild(c);
  return el;
}

// ---------- buttons, badges ----------
export function btn(label, opts = {}) {
  const cls = ['btn', opts.kind || '', opts.size || '', !label ? 'icon' : ''].filter(Boolean).join(' ');
  const b = h('button', { type: opts.type || 'button', class: cls, title: opts.title || null, disabled: opts.disabled, onclick: opts.onClick, 'aria-label': !label ? opts.title : null },
    opts.icon ? ic(opts.icon) : null, label ? h('span', label) : null);
  if (opts.kbd) b.append(h('kbd', opts.kbd));
  return b;
}
export const badge = (text, tone = '', iconName) => h('span', { class: 'badge ' + tone }, iconName ? ic(iconName) : null, text);
export const dot = tone => h('span', { class: 'dot ' + (tone || '') });

// ---------- toast ----------
let toastHost;
export function toast(msg, type = 'ok', ms) {
  if (!toastHost) { toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' }); document.body.append(toastHost); }
  const icn = type === 'ok' ? 'circle-check' : type === 'err' ? 'circle-alert' : type === 'warn' ? 'triangle-alert' : 'info';
  const t = h('div', { class: 'toast ' + type }, ic(icn), h('div.grow', msg), h('button.t-x', { 'aria-label': 'Tutup', onclick: () => t.remove() }, ic('x')));
  toastHost.append(t);
  setTimeout(() => t.remove(), ms || (type === 'err' ? 7000 : 3500));
}

// ---------- dialog ----------
/** dialog({title, body, actions:[{label, kind, value, icon}], wide}) → Promise(value|null) */
export function dialog({ title, body, actions, wide, onOpen, dismissable = true }) {
  return new Promise(resolve => {
    const d = h('dialog', { class: 'dlg' + (wide ? ' wide' : '') });
    let done = false;
    const close = v => { if (done) return; done = true; d.close(); d.remove(); resolve(v); };
    const acts = (actions || [{ label: 'Tutup', value: null }]).map(a => {
      const b = btn(a.label, { kind: a.kind, icon: a.icon, onClick: async () => {
        if (a.validate) { const ok = await a.validate(); if (!ok) return; }
        close(typeof a.value === 'function' ? a.value() : a.value);
      } });
      if (a.autofocus) b.setAttribute('autofocus', '');
      return b;
    });
    d.append(
      h('div.dlg-h', h('h3', title || ''), dismissable ? h('button.btn.ghost.sm.icon.x', { 'aria-label': 'Tutup', onclick: () => close(null) }, ic('x')) : null),
      h('div.dlg-b', body || null),
      h('div.dlg-f', acts));
    d.addEventListener('cancel', e => { e.preventDefault(); if (dismissable) close(null); });
    document.body.append(d);
    d.showModal();
    onOpen && onOpen(d, close);
  });
}
export function confirmDlg(message, { title = 'Konfirmasi', ok = 'Ya, lanjutkan', danger = false, cancel = 'Batal' } = {}) {
  return dialog({ title, body: typeof message === 'string' ? h('p', message) : message,
    actions: [{ label: cancel, value: false }, { label: ok, kind: danger ? 'danger solid' : 'primary', value: true, autofocus: true }] });
}

// ---------- form controls ----------
export function field(label, control, { hint, name, span, required, err } = {}) {
  const f = h('div', { class: 'field' + (span ? ' ' + span : ''), dataset: name ? { field: name } : {} },
    label ? h('label', label, required ? h('span', { style: { color: 'var(--danger)' } }, '*') : null) : null,
    control,
    hint ? h('div.hint', hint) : null,
    h('div.err', { hidden: !err }, err || ''));
  if (control && control.id === '' && label && control.matches && control.matches('input,select,textarea')) {
    const id = 'f' + Math.random().toString(36).slice(2, 8); control.id = id; f.querySelector('label').htmlFor = id;
  }
  return f;
}
export function input(attrs = {}) { return h('input', Object.assign({ class: 'inp' + (attrs.sm ? ' sm' : ''), type: 'text' }, attrs, { sm: null })); }
export function textarea(attrs = {}) { const v = attrs.value; const t = h('textarea', Object.assign({ class: 'inp', rows: 3 }, attrs, { value: null })); t.value = v == null ? '' : v; return t; }
export function select(options, value, attrs = {}) {
  const s = h('select', Object.assign({ class: 'inp' + (attrs.sm ? ' sm' : '') }, attrs, { sm: null }));
  for (const o of options) {
    if (o && o.group) {
      const g = h('optgroup', { label: o.group });
      o.options.forEach(x => g.append(h('option', { value: x.value }, x.label)));
      s.append(g);
    } else {
      const [v, l] = Array.isArray(o) ? o : typeof o === 'object' ? [o.value, o.label] : [o, o];
      s.append(h('option', { value: v == null ? '' : v }, l));
    }
  }
  s.value = value == null ? '' : value;
  return s;
}
export function toggle(checked, label, attrs = {}) {
  const i = h('input', Object.assign({ type: 'checkbox', checked }, attrs));
  return h('label.switch', i, h('span.tr'), label ? h('span', label) : null);
}
export function checkbox(checked, label, attrs = {}) {
  return h('label.check', h('input', Object.assign({ type: 'checkbox', checked }, attrs)), label);
}
/** segmented([{value,label,icon,title}], value, onChange) */
export function segmented(opts, value, onChange, cls = '') {
  const s = h('div', { class: 'seg ' + cls, role: 'radiogroup' });
  const set = v => { value = v; [...s.children].forEach(b => { b.classList.toggle('on', b.dataset.v === String(v)); b.setAttribute('aria-checked', b.dataset.v === String(v)); }); };
  for (const o of opts) {
    s.append(h('button', { type: 'button', role: 'radio', dataset: { v: String(o.value) }, title: o.title || null, disabled: o.disabled,
      onclick: () => { if (String(value) === String(o.value)) return; set(o.value); onChange && onChange(o.value); } },
      o.icon ? ic(o.icon) : null, o.label ? h('span', o.label) : null));
  }
  set(value);
  s.setValue = set; s.getValue = () => value;
  return s;
}
export function langPair(nameEn, nameId, values, attrs = {}) {
  const mk = (lang, nm) => {
    const ctrl = attrs.multiline ? textarea({ name: nm, value: values[nm] ?? '', rows: attrs.rows || 3, placeholder: attrs.placeholder || '' })
      : input({ name: nm, value: values[nm] ?? '', placeholder: attrs.placeholder || '' });
    return h('div.field', { dataset: { field: nm } }, h('label', h('span.lang-tag', lang), attrs.label || ''), ctrl, h('div.err', { hidden: true }));
  };
  return h('div.lang-pair', mk('ID', nameId), mk('EN', nameEn));
}

/** Show API field errors on a form root: {fieldName: message} */
export function showFieldErrors(root, fields = {}) {
  $$('.field', root).forEach(f => { f.classList.remove('has-err'); const e = $('.err', f); if (e) { e.hidden = true; e.textContent = ''; } });
  let first = null;
  for (const k in fields) {
    const f = root.querySelector(`[data-field="${CSS.escape(k)}"]`) || (root.querySelector(`[name="${CSS.escape(k)}"]`) || {}).closest?.('.field');
    if (!f) continue;
    f.classList.add('has-err');
    const e = $('.err', f); if (e) { e.hidden = false; e.textContent = fieldMsg(fields[k]); }
    first = first || f;
  }
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
const MSG = { required: 'Wajib diisi', invalid: 'Format tidak valid', unique: 'Sudah dipakai', too_long: 'Terlalu panjang', https: 'Harus diawali https://', not_found: 'Tidak ditemukan', in_use: 'Masih dipakai' };
export const fieldMsg = m => MSG[m] || m;

/** Read named inputs inside root into an object (checkbox → bool, number → Number|null). */
export function readForm(root) {
  const o = {};
  $$('[name]', root).forEach(el => {
    if (el.closest('[data-skip]')) return;
    const n = el.name;
    if (el.type === 'checkbox') o[n] = el.checked;
    else if (el.type === 'number') o[n] = el.value === '' ? null : Number(el.value);
    else if (el.type === 'radio') { if (el.checked) o[n] = el.value; }
    else o[n] = el.value === '' ? null : el.value;
  });
  return o;
}

// ---------- dirty tracking + Ctrl+S ----------
let activeSave = null;
export function dirtyTracker(root, { onSave, label = 'Perubahan belum disimpan', bar = true } = {}) {
  let dirty = false;
  const sb = bar ? h('div.savebar', { hidden: true }, ic('pencil'), h('span.grow', label),
    h('button.btn.ghost.sm', { type: 'button', onclick: () => api.reset && api.reset() }, 'Batalkan'),
    h('button.btn.light.sm', { type: 'button', onclick: () => api.save() }, ic('save'), 'Simpan', h('kbd', 'Ctrl S'))) : null;
  const api = {
    el: sb,
    get dirty() { return dirty; },
    set(v) { dirty = v; if (sb) sb.hidden = !v; },
    async save() { if (!onSave) return; const r = await onSave(); if (r !== false) api.set(false); },
    reset: null,
  };
  const mark = e => { if (e.target.closest('[data-nodirty]')) return; api.set(true); };
  root.addEventListener('input', mark); root.addEventListener('change', mark);
  activeSave = api;
  return api;
}
export const currentSaver = () => activeSave;
export const clearSaver = () => { activeSave = null; };
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    if (activeSave && document.body.contains(activeSave.el || document.body)) { e.preventDefault(); activeSave.save(); }
  }
});

// ---------- table ----------
/** table({columns:[{key,label,render,cls,sort,width}], rows, onRow, selectable, keyFn, empty}) */
export function table({ columns, rows, onRow, selectable, keyFn = r => r.id, empty = 'Tidak ada data', compact, sort: sortInit, onSelect }) {
  const wrap = h('div.tbl-wrap');
  const t = h('table', { class: 'tbl' + (compact ? ' compact' : '') });
  const sel = new Set();
  let sort = sortInit || null, kbdIdx = -1;
  const thead = h('thead'), tbody = h('tbody');
  t.append(thead, tbody); wrap.append(t);
  const headChk = selectable ? h('input', { type: 'checkbox', 'aria-label': 'Pilih semua', onchange: e => { rows.forEach(r => e.target.checked ? sel.add(keyFn(r)) : sel.delete(keyFn(r))); renderBody(); onSelect && onSelect([...sel]); } }) : null;
  function renderHead() {
    clear(thead);
    const tr = h('tr', selectable ? h('th.chk', headChk) : null);
    for (const c of columns) {
      const th = h('th', { class: (c.cls || '') + (c.sort ? ' sortable' : ''), style: c.width ? { width: c.width } : null }, c.label || '');
      if (c.sort) {
        if (sort && sort.key === c.key) th.append(' ', sort.dir > 0 ? '↑' : '↓');
        th.addEventListener('click', () => { sort = { key: c.key, dir: sort && sort.key === c.key ? -sort.dir : 1 }; renderHead(); renderBody(); });
      }
      tr.append(th);
    }
    thead.append(tr);
  }
  function sorted() {
    if (!sort) return rows;
    const c = columns.find(x => x.key === sort.key); const f = typeof c.sort === 'function' ? c.sort : r => r[c.key];
    return [...rows].sort((a, b) => { const x = f(a), y = f(b); return (x == null ? 1 : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
  }
  let view = [];
  function renderBody() {
    clear(tbody);
    view = sorted();
    if (!view.length) { tbody.append(h('tr', h('td', { colspan: columns.length + (selectable ? 1 : 0) }, h('div.empty', ic('search'), empty)))); return; }
    const frag = document.createDocumentFragment();
    view.forEach((r, i) => {
      const k = keyFn(r);
      const tr = h('tr', { class: (onRow ? 'click' : '') + (sel.has(k) ? ' sel' : '') + (i === kbdIdx ? ' kbd' : ''), dataset: { k: String(k) } });
      if (selectable) tr.append(h('td.chk', h('input', { type: 'checkbox', checked: sel.has(k), 'aria-label': 'Pilih', onclick: e => e.stopPropagation(),
        onchange: e => { e.target.checked ? sel.add(k) : sel.delete(k); tr.classList.toggle('sel', e.target.checked); onSelect && onSelect([...sel]); } })));
      for (const c of columns) {
        const v = c.render ? c.render(r) : r[c.key];
        tr.append(h('td', { class: c.cls || '' }, v == null ? '' : v));
      }
      if (onRow) tr.addEventListener('click', e => { if (e.target.closest('button,a,input,select,label')) return; onRow(r, e); });
      frag.append(tr);
    });
    tbody.append(frag);
  }
  renderHead(); renderBody();
  wrap.tabIndex = 0;
  wrap.addEventListener('keydown', e => {
    if (!onRow || !view.length) return;
    if (e.key === 'ArrowDown' || e.key === 'j') { kbdIdx = Math.min(view.length - 1, kbdIdx + 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp' || e.key === 'k') { kbdIdx = Math.max(0, kbdIdx - 1); e.preventDefault(); }
    else if (e.key === 'Enter' && kbdIdx >= 0) { onRow(view[kbdIdx], e); return; }
    else return;
    $$('tr.kbd', tbody).forEach(x => x.classList.remove('kbd'));
    const tr = tbody.children[kbdIdx]; if (tr) { tr.classList.add('kbd'); tr.scrollIntoView({ block: 'nearest' }); }
  });
  return Object.assign(wrap, {
    setRows(r) { rows = r; renderBody(); },
    selected: () => [...sel],
    clearSel() { sel.clear(); if (headChk) headChk.checked = false; renderBody(); onSelect && onSelect([]); },
  });
}

export function tabs(items, active, onChange) {
  const t = h('div.tabs', { role: 'tablist' });
  const set = k => { active = k; [...t.children].forEach(b => b.classList.toggle('on', b.dataset.k === k)); };
  for (const it of items) t.append(h('button', { type: 'button', role: 'tab', dataset: { k: it.key }, onclick: () => { set(it.key); onChange(it.key); } },
    it.icon ? ic(it.icon) : null, it.label, it.count != null ? h('span.badge', String(it.count)) : null));
  set(active);
  t.setActive = set;
  return t;
}

export function card(title, body, { actions, flush, cls } = {}) {
  return h('div', { class: 'card ' + (cls || '') },
    title ? h('div.card-h', typeof title === 'string' ? h('h3', title) : title, actions ? h('div.actions', actions) : null) : null,
    h('div', { class: 'card-b' + (flush ? ' flush' : '') }, body));
}
export const loading = (msg = 'Memuat…') => h('div.loading', h('span.spinner'), msg);
export const emptyState = (msg, iconName = 'search') => h('div.empty', ic(iconName), msg);

export function pageHead(title, sub, actions, crumb) {
  return h('div.page-head', h('div.grow',
    crumb ? h('div.crumb', crumb) : null,
    h('h1', title), sub ? h('div.sub', sub) : null),
    actions ? h('div.actions', actions) : null);
}

// ---------- formatting ----------
const pad = n => String(n).padStart(2, '0');
const BULAN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
export const HARI = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
export const HARI_S = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
export function parseDate(s) { if (!s) return null; const d = new Date(String(s).replace(' ', 'T')); return isNaN(d) ? null : d; }
/** Format in WITA regardless of browser tz. */
function wita(d) { return new Date(d.getTime() + (480 + d.getTimezoneOffset()) * 60000); }
export function fmtDate(s, { time = true, year = false } = {}) {
  const d0 = parseDate(s); if (!d0) return '—'; const d = wita(d0);
  return `${d.getDate()} ${BULAN[d.getMonth()]}${year ? ' ' + d.getFullYear() : ''}${time ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''}`;
}
export function fmtTime(s) { const d0 = parseDate(s); if (!d0) return '—'; const d = wita(d0); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function relTime(s) {
  const d = parseDate(s); if (!d) return '—';
  const sec = Math.round((Date.now() - d.getTime()) / 1000), a = Math.abs(sec), fut = sec < 0;
  const r = a < 45 ? 'baru saja' : a < 3600 ? Math.round(a / 60) + ' mnt' : a < 86400 ? Math.round(a / 3600) + ' jam' : Math.round(a / 86400) + ' hari';
  return r === 'baru saja' ? r : fut ? 'dalam ' + r : r + ' lalu';
}
/** ISO with +08:00 from a <input type=datetime-local> value (already WITA wall time). */
export const localToIso = v => v ? (v.length === 16 ? v + ':00' : v) + '+08:00' : null;
export function isoToLocal(s) { const d0 = parseDate(s); if (!d0) return ''; const d = wita(d0); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
export function nowWita() { return wita(new Date()); }
export function witaIso(date) { const d = wita(date); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00+08:00`; }
export const fmtNum = n => n == null ? '—' : Number(n).toLocaleString('id-ID');
export const fmtBytes = b => b == null ? '—' : b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1).replace('.', ',') + ' KB' : (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
export const initials = s => String(s || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
export function debounce(fn, ms = 200) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** App-root-relative path (e.g. "assets/logos/x.webp") → URL usable from cms/. */
export const assetUrl = p => !p ? '' : /^(https?:|data:|blob:|\/)/.test(p) ? p : '../' + p.replace(/^\.\//, '');

/** Simple drag-reorder for children of a container having [data-k]. onDrop(orderedKeys). */
export function sortable(container, onDrop, handleSel = '.drag-handle') {
  let dragEl = null;
  container.addEventListener('dragstart', e => {
    dragEl = e.target.closest('[data-k]'); if (!dragEl) return;
    dragEl.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragEl.dataset.k);
  });
  container.addEventListener('dragover', e => {
    if (!dragEl) return; e.preventDefault();
    const over = e.target.closest('[data-k]'); if (!over || over === dragEl) return;
    const r = over.getBoundingClientRect(); const after = e.clientY > r.top + r.height / 2;
    over.parentNode.insertBefore(dragEl, after ? over.nextSibling : over);
  });
  container.addEventListener('dragend', () => { if (!dragEl) return; dragEl.classList.remove('dragging'); dragEl = null; onDrop($$('[data-k]', container).map(x => x.dataset.k)); });
  container.addEventListener('mousedown', e => { const row = e.target.closest('[data-k]'); if (row) row.draggable = !!e.target.closest(handleSel); });
}
