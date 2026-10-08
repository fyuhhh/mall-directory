// Categories — §2.3 / §7.2 #5: drag-ordered list, name ID/EN, icon (from BSB.ICONS), color.
import { h, ic, btn, badge, pageHead, field, input, toggle, toast, dialog, confirmDlg, clear, sortable, card, showFieldErrors } from '../ui.js';
import { api, lookups, invalidate } from '../api.js';
import { can } from '../state.js';
import { icon as iconSvg } from '../icons.js';

/** icon picker over the kiosk icon set (BSB.ICONS from ../js/icons.js) */
export async function pickIcon(current) {
  const names = Object.keys((window.BSB && window.BSB.ICONS) || {}).sort();
  let picked = current;
  const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(84px, 1fr))', gap: '8px', maxHeight: '420px', overflow: 'auto' } });
  const render = () => { clear(grid); names.forEach(n => grid.append(h('button', { type: 'button', class: 'card', title: n, onclick: () => { picked = n; render(); },
    style: { padding: '10px 4px', display: 'grid', placeItems: 'center', gap: '6px', boxShadow: 'none', borderColor: n === picked ? 'var(--accent)' : 'var(--line)', background: n === picked ? 'var(--accent-soft)' : '#fff' } },
    h('span', { html: iconSvg(n), style: { fontSize: '22px' } }), h('span.small', { style: { fontSize: '10.5px', wordBreak: 'break-all' } }, n)))); };
  render();
  return dialog({ title: 'Pilih ikon (set ikon kiosk)', wide: true, body: h('div.stack', h('p.small.muted', 'Hanya ikon yang ada di js/icons.js kiosk yang bisa dipakai.'), grid), actions: [{ label: 'Batal', value: null }, { label: 'Pilih', kind: 'primary', value: () => picked }] });
}

export default async function categories(ctx) {
  ctx.setTitle('Kategori');
  const canEdit = can('categories.edit');
  ctx.root.append(pageHead('Kategori', 'Urutan = urutan tombol di beranda kiosk. Warna dipakai titik tenant di peta.', [canEdit ? btn('Kategori baru', { icon: 'plus', kind: 'primary', onClick: () => edit(null) }) : null]));
  const list = h('div.card');
  ctx.root.append(h('div', { style: { maxWidth: '900px' } }, list));
  let cats = [];
  async function load() { invalidate('categories'); cats = await lookups.categories(); render(); }
  function render() {
    clear(list);
    const body = h('div');
    cats.forEach(c => body.append(h('div.row', { dataset: { k: c.id }, style: { padding: '10px 14px', borderBottom: '1px solid var(--line)', gap: '12px' } },
      canEdit ? h('span.drag-handle', { title: 'Seret untuk mengurutkan' }, ic('grip-vertical')) : null,
      h('span.cat-ic', { style: { background: c.color + '1A', color: c.color }, html: iconSvg(c.icon) }),
      h('div.grow', h('div', { style: { fontWeight: 700 } }, c.nameId), h('div.small.muted', c.nameEn + ' · ', h('span.mono', c.id))),
      h('span.row', { style: { gap: '6px' } }, h('span.swatch', { style: { background: c.color } }), h('span.mono.small', c.color)),
      h('span.badge', { style: { minWidth: '74px', justifyContent: 'center' } }, (c.tenantCount ?? 0) + ' tenant'),
      c.isActive ? null : badge('Nonaktif', 'warn'),
      canEdit ? btn('', { icon: 'pencil', size: 'sm', title: 'Ubah', onClick: () => edit(c) }) : null)));
    list.append(body);
    if (canEdit) sortable(body, async keys => {
      const before = cats.map(c => c.id).join();
      cats = keys.map(k => cats.find(c => c.id === k)); if (before === keys.join()) return;
      try { for (let i = 0; i < cats.length; i++) if (cats[i].sortOrder !== i + 1) { const r = await api.put('/categories/' + cats[i].id, { sortOrder: i + 1 }, cats[i].etag); Object.assign(cats[i], r.data); } toast('Urutan kategori disimpan'); ctx.refreshStatus(); }
      catch (e) { load(); }
    });
  }
  async function edit(c) {
    const isNew = !c; const v = Object.assign({ id: '', nameEn: '', nameId: '', icon: 'sparkles', color: '#857B70', isActive: true }, c || {});
    const icBtn = h('button.btn', { type: 'button', onclick: async () => { const n = await pickIcon(v.icon); if (n) { v.icon = n; icPrev.innerHTML = iconSvg(n); icName.textContent = n; } } });
    const icPrev = h('span', { html: iconSvg(v.icon), style: { fontSize: '18px', display: 'inline-flex' } }); const icName = h('span', v.icon);
    icBtn.append(icPrev, icName);
    const colorIn = input({ type: 'color', name: 'color', value: v.color, style: { width: '56px', padding: '3px' } });
    const body = h('div.form.cols-2',
      field('ID (slug)', input({ name: 'id', value: v.id, disabled: !isNew, class: 'inp mono', placeholder: 'food-beverage' }), { name: 'id', required: true }),
      field('Warna', h('div.row', colorIn, input({ name: 'colorHex', value: v.color, class: 'inp mono', oninput: e => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) colorIn.value = e.target.value; } })), { name: 'color' }),
      field('Nama (Indonesia)', input({ name: 'nameId', value: v.nameId }), { name: 'nameId', required: true }),
      field('Nama (English)', input({ name: 'nameEn', value: v.nameEn }), { name: 'nameEn', required: true }),
      field('Ikon', icBtn, { name: 'icon' }),
      field('Status', toggle(v.isActive, 'Aktif', { name: 'isActive' })));
    colorIn.addEventListener('input', () => body.querySelector('[name=colorHex]').value = colorIn.value);
    const res = await dialog({ title: isNew ? 'Kategori baru' : 'Ubah kategori', body, actions: [
      !isNew ? { label: 'Hapus', kind: 'danger', value: 'delete' } : null, { label: 'Batal', value: null }, { label: 'Simpan', kind: 'primary', value: 'save', validate: async () => {
        const o = { id: body.querySelector('[name=id]').value.trim(), nameId: body.querySelector('[name=nameId]').value.trim(), nameEn: body.querySelector('[name=nameEn]').value.trim(), icon: v.icon, color: colorIn.value.toUpperCase(), isActive: body.querySelector('[name=isActive]').checked };
        const errs = {}; ['id', 'nameId', 'nameEn'].forEach(k => { if (!o[k]) errs[k] = 'required'; }); if (Object.keys(errs).length) { showFieldErrors(body, errs); return false; }
        try { if (isNew) await api.post('/categories', Object.assign(o, { sortOrder: cats.length + 1 })); else await api.put('/categories/' + c.id, o, c.etag); toast('Kategori disimpan'); return true; }
        catch (e) { if (e.fields) showFieldErrors(body, e.fields); return false; }
      } }].filter(Boolean) });
    if (res === 'delete') {
      if (c.tenantCount) { toast(`Kategori masih dipakai ${c.tenantCount} tenant — pindahkan dulu tenant-nya.`, 'warn'); return; }
      if (await confirmDlg(`Hapus kategori ${c.nameId}?`, { danger: true, ok: 'Hapus' })) { await api.del('/categories/' + c.id); toast('Kategori dihapus'); }
    }
    if (res) { ctx.refreshStatus(); load(); }
  }
  await load();
}
