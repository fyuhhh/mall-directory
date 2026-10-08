// Media library — §2.18 / §7.2 #19: grid, type filter, search, drag&drop upload, "dipakai oleh", delete unused.
import { h, ic, btn, badge, pageHead, input, select, toast, dialog, confirmDlg, clear, assetUrl, fmtBytes, fmtDate, debounce, emptyState, card } from '../ui.js';
import { api } from '../api.js';
import { can } from '../state.js';

const KINDS = [['', 'Semua'], ['logo', 'Logo'], ['image', 'Gambar'], ['video', 'Video'], ['svg', 'SVG lantai']];
const USED = { tenant: 'Tenant', brand: 'Brand', floor: 'Lantai', promo: 'Promo', event: 'Event' };
const usedHref = u => u.type === 'tenant' ? '#/tenants/' + encodeURIComponent(u.id) : u.type === 'floor' ? '#/floors' : u.type === 'promo' ? '#/promos/' + u.id : u.type === 'event' ? '#/events' : null;

function tile(m, onClick, selected) {
  const isImg = m.kind === 'logo' || m.kind === 'image' || m.kind === 'svg';
  return h('div', { class: 'mtile' + (selected ? ' sel' : ''), tabIndex: 0, onclick: () => onClick(m), onkeydown: e => { if (e.key === 'Enter') onClick(m); } },
    h('div.mt-img', isImg ? h('img', { src: assetUrl(m.url), alt: '', loading: 'lazy' }) : ic(m.kind === 'video' ? 'video' : m.kind === 'svg' ? 'layers' : 'image')),
    h('div.mt-b', h('b', { title: m.originalName }, m.originalName || '#' + m.id),
      h('div.row', { style: { gap: '6px', marginTop: '3px' } }, h('span.muted', fmtBytes(m.bytes)), h('span.grow'),
        m.usedBy && m.usedBy.length ? badge(m.usedBy.length + '× dipakai', 'info') : badge('tidak dipakai', ''))));
}

/** Modal picker → resolves media object or null. */
export async function mediaPicker(kind) {
  const grid = h('div.mgrid', { style: { maxHeight: '440px', overflow: 'auto', padding: '2px' } });
  const q = input({ type: 'search', placeholder: 'Cari nama file / tenant…' });
  let picked = null;
  const load = async () => {
    const r = await api.get('/media', { kind, q: q.value });
    clear(grid); if (!r.data.length) grid.append(emptyState('Tidak ada media'));
    r.data.slice(0, 120).forEach(m => grid.append(tile(m, mm => { picked = mm; [...grid.children].forEach(c => c.classList.remove('sel')); grid.children[r.data.indexOf(mm)].classList.add('sel'); }, false)));
  };
  q.addEventListener('input', debounce(load, 200));
  load();
  const v = await dialog({ title: 'Pilih dari media', wide: true, body: h('div.stack', q, grid), actions: [{ label: 'Batal', value: null }, { label: 'Pilih', kind: 'primary', value: () => picked }] });
  return v || null;
}

export default async function media(ctx) {
  ctx.setTitle('Media');
  let kind = ctx.query.get('kind') || '', q = '', sel = null, items = [];
  const canUp = can('media.upload'), canDel = can('media.delete');
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true, accept: 'image/png,image/jpeg,image/webp,video/mp4', onchange: e => upload([...e.target.files]) });
  ctx.root.append(pageHead('Media', 'Logo, gambar promo, video, dan SVG lantai. File identik otomatis digabung (SHA-256).', [fileIn, canUp ? btn('Unggah', { icon: 'cloud-upload', kind: 'primary', onClick: () => fileIn.click() }) : null]));
  const kindSel = select(KINDS, kind, { sm: true, 'aria-label': 'Jenis' });
  const search = input({ type: 'search', placeholder: 'Cari nama file / dipakai oleh…' });
  const countEl = h('span.small.muted');
  ctx.root.append(h('div.filters', h('div.search', ic('search'), search), kindSel, countEl));
  const upKind = select([['image', 'Gambar promo/event'], ['logo', 'Logo tenant'], ['video', 'Video promo (MP4)']], 'image', { sm: true, 'aria-label': 'Jenis unggahan', style: { width: 'auto' } });
  const drop = h('div.dropzone', ic('cloud-upload'), h('div', h('b', 'Tarik & lepas file ke sini'), ' atau ', h('a', { href: '#', onclick: e => { e.preventDefault(); fileIn.click(); } }, 'pilih file')),
    h('div.small', { style: { marginTop: '4px' } }, 'Logo: PNG/JPG/WebP ≤ 5 MB · Gambar ≤ 10 MB · Video MP4 H.264 ≤ 30 MB, ≤ 30 dtk, tanpa audio'),
    h('div.row', { style: { justifyContent: 'center', marginTop: '10px' } }, h('span.small', 'Simpan sebagai'), upKind));
  if (!canUp) drop.hidden = true;
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => upload([...e.dataTransfer.files]));
  const grid = h('div.mgrid');
  const side = h('div.sticky');
  ctx.root.append(h('div.split', h('div.stack', drop, grid), side));

  async function load() {
    const r = await api.get('/media', { kind, q });
    items = r.data; countEl.textContent = items.length + ' file';
    clear(grid);
    if (!items.length) grid.append(emptyState('Tidak ada media'));
    items.slice(0, 300).forEach(m => grid.append(tile(m, show, sel && sel.id === m.id)));
    if (!sel && items[0]) show(items[0], true); else if (!items.length) clear(side);
  }
  function show(m) {
    sel = m; [...grid.children].forEach((c, i) => c.classList && c.classList.toggle('sel', items[i] && items[i].id === m.id));
    clear(side).append(card(m.originalName || 'Media #' + m.id, h('div.stack',
      h('div.mt-img', { style: { height: '170px', borderRadius: '10px', display: 'grid', placeItems: 'center', background: 'repeating-conic-gradient(#F3EEE7 0% 25%, #fff 0% 50%) 50% / 16px 16px', border: '1px solid var(--line)' } },
        m.kind === 'video' ? h('video', { src: assetUrl(m.url), controls: true, muted: true, style: { maxWidth: '100%', maxHeight: '160px' } }) :
          h('img', { src: assetUrl(m.url), alt: '', style: { maxWidth: '90%', maxHeight: '150px', objectFit: 'contain' } })),
      h('dl.kv', { style: { gridTemplateColumns: '100px 1fr' } },
        h('dt', 'Jenis'), h('dd', m.kind), h('dt', 'Ukuran'), h('dd', `${fmtBytes(m.bytes)}${m.width ? ` · ${m.width}×${m.height}` : ''}${m.durationSec ? ` · ${m.durationSec} dtk` : ''}`),
        h('dt', 'Path'), h('dd.mono.small', m.url), h('dt', 'Diunggah'), h('dd', `${fmtDate(m.createdAt)} · ${m.createdBy || '—'}`)),
      h('div', h('div.kicker', { style: { marginBottom: '6px' } }, 'Dipakai oleh'),
        m.usedBy && m.usedBy.length ? h('ul.list-plain', m.usedBy.map(u => h('li', badge(USED[u.type] || u.type), usedHref(u) ? h('a', { href: usedHref(u) }, u.label || u.id) : h('span', u.label || u.id)))) : h('div.small.muted', 'Tidak dipakai — aman dihapus.')),
      canDel ? btn('Hapus', { icon: 'trash-2', kind: 'danger', disabled: m.usedBy && m.usedBy.length > 0, title: m.usedBy && m.usedBy.length ? 'Masih dipakai' : null, onClick: async () => {
        if (!(await confirmDlg(`Hapus ${m.originalName}?`, { ok: 'Hapus', danger: true }))) return;
        await api.del('/media/' + m.id); toast('Media dihapus'); sel = null; load();
      } }) : null)));
  }
  async function upload(files) {
    for (const f of files) {
      const k = /^video\//.test(f.type) ? 'video' : upKind.value;
      try { const r = await api.upload('/media', f, { kind: k }); toast(`${f.name} diunggah (${r.data.encoder || 'ok'})`); (r.data.warnings || []).forEach(w => toast(w, 'warn')); sel = r.data; }
      catch (e) { if (e.fields) toast(`${f.name}: ${Object.values(e.fields).join(', ')}`, 'err'); }
    }
    load();
  }
  kindSel.addEventListener('change', () => { kind = kindSel.value; sel = null; load(); });
  search.addEventListener('input', debounce(() => { q = search.value.trim(); load(); }, 200));
  await load();
}
