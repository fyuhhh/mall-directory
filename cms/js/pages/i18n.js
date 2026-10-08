// i18n strings — §2.13 / §7.2 #15: key / default (from ../js/i18n.js) / override EN & ID, inline edit, preview.
import { h, ic, btn, badge, pageHead, input, toast, clear, table, debounce, emptyState } from '../ui.js';
import { api } from '../api.js';
import { can } from '../state.js';

/** Parse the kiosk dictionary (js/i18n.js) without executing it: {id:{k:v}, en:{k:v}} */
async function kioskDefaults() {
  const src = await (await fetch('../js/i18n.js', { cache: 'no-store' })).text();
  const out = { id: {}, en: {} };
  for (const lang of ['id', 'en']) {
    const m = new RegExp('\\b' + lang + ':\\s*\\{').exec(src); if (!m) continue;
    let i = m.index + m[0].length, depth = 1; const start = i;
    while (i < src.length && depth) { const c = src[i]; if (c === '{') depth++; else if (c === '}') depth--; else if (c === "'" || c === '"') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } } i++; }
    const body = src.slice(start, i - 1);
    const re = /([A-Za-z_][\w]*)\s*:\s*(['"])((?:\\.|(?!\2).)*)\2/g; let r;
    while ((r = re.exec(body))) out[lang][r[1]] = r[3].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\u00A0/g, ' ');
  }
  return out;
}

export default async function i18n(ctx) {
  ctx.setTitle('Teks kiosk');
  const canEdit = can('i18n.edit');
  ctx.root.append(pageHead('Teks kiosk (i18n)', 'Default dari js/i18n.js kiosk. Override disimpan di CMS & ikut snapshot directory (seksi konten).'));
  const [def, ov] = await Promise.all([kioskDefaults().catch(() => ({ id: {}, en: {} })), api.get('/i18n').then(r => r.data)]);
  const ovBy = Object.fromEntries(ov.map(o => [o.key, o]));
  const keys = [...new Set([...Object.keys(def.id), ...Object.keys(def.en), ...ov.map(o => o.key)])];
  let q = '', onlyOv = false;
  const search = input({ type: 'search', placeholder: 'Cari key atau teks…' });
  const chip = h('button', { type: 'button', class: 'chip', onclick: () => { onlyOv = !onlyOv; chip.classList.toggle('on', onlyOv); tbl.setRows(rows()); } }, 'Hanya yang di-override', h('span.n', String(ov.length)));
  ctx.root.append(h('div.filters', h('div.search', ic('search'), search), chip, h('span.small.muted', `${keys.length} key`)));
  const rows = () => keys.filter(k => (!onlyOv || ovBy[k]) && (!q || (k + ' ' + (def.id[k] || '') + ' ' + (def.en[k] || '') + ' ' + JSON.stringify(ovBy[k] || '')).toLowerCase().includes(q))).map(k => ({ key: k }));
  const cell = (k, lang) => {
    const o = ovBy[k] || {}; const dv = lang === 'en' ? (def.en[k] ?? def.id[k] ?? '') : (def.id[k] ?? '');
    const inp = input({ value: o[lang] ?? '', placeholder: 'Override ' + lang.toUpperCase() + '…', sm: true, disabled: !canEdit, 'aria-label': `Override ${lang.toUpperCase()} ${k}`, style: o[lang] ? { borderColor: 'var(--gold)', background: 'var(--gold-soft)' } : null });
    const save = async () => {
      const cur = ovBy[k] || { key: k, en: null, id: null }; const nv = inp.value.trim() || null; if ((cur[lang] ?? null) === nv) return;
      const body = { en: cur.en, id: cur.id, note: cur.note || null }; body[lang] = nv;
      const r = await api.put('/i18n/' + encodeURIComponent(k), body);
      if (!body.en && !body.id) delete ovBy[k]; else ovBy[k] = Object.assign({ key: k }, r.data || body);
      inp.style.borderColor = nv ? 'var(--gold)' : ''; inp.style.background = nv ? 'var(--gold-soft)' : '';
      toast(nv ? `Override ${k} (${lang.toUpperCase()}) disimpan` : `Override ${k} (${lang.toUpperCase()}) dihapus — kembali ke default`); ctx.refreshStatus();
    };
    inp.addEventListener('change', save); inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = (ovBy[k] || {})[lang] || ''; inp.blur(); } });
    return h('div.stack', { style: { gap: '3px' } }, h('div.small.muted', { style: { whiteSpace: 'pre-wrap' } }, dv || '—'), inp);
  };
  const tbl = table({ rows: rows(), keyFn: r => r.key, compact: true, empty: 'Tidak ada key cocok', columns: [
    { key: 'key', label: 'Key', width: '200px', render: r => h('div', h('span.mono', r.key), ovBy[r.key] ? h('div', badge('override', 'gold')) : null) },
    { key: 'id', label: 'Indonesia (default → override)', render: r => cell(r.key, 'id') },
    { key: 'en', label: 'English (default → override)', render: r => cell(r.key, 'en') }] });
  ctx.root.append(h('div.card', tbl), h('p.small.muted', { style: { marginTop: '10px' } }, 'Kosongkan override untuk kembali ke default. Placeholder {n} dsb. harus dipertahankan. Enter = simpan, Esc = batal.'));
  search.addEventListener('input', debounce(() => { q = search.value.toLowerCase().trim(); tbl.setRows(rows()); }, 150));
}
