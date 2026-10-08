// Featured tenants — §2.12 / §7.2 #14: drag & drop ordered marquee with logos, optional period; preview in kiosk frame.
import { h, ic, btn, badge, pageHead, input, toast, clear, card, sortable, dirtyTracker, debounce, assetUrl, isoToLocal, localToIso, emptyState } from '../ui.js';
import { api, lookups } from '../api.js';
import { can, floorName } from '../state.js';
import { logoThumb } from '../widgets.js';
import { kioskFrame } from './promos.js';

export default async function featured(ctx) {
  ctx.setTitle('Featured');
  const canEdit = can('featured.edit');
  ctx.root.append(pageHead('Featured tenant', 'Urutan logo di marquee layar atraksi (menggantikan config.featured). Harus terpublish & punya logo.', [canEdit ? btn('Simpan urutan', { icon: 'save', kind: 'primary', kbd: 'Ctrl S', onClick: () => tracker.save() }) : null]));
  const [items0, tenants, floors] = await Promise.all([api.get('/featured').then(r => r.data), lookups.tenantsLite(), lookups.floors()]);
  const tBy = Object.fromEntries(tenants.map(t => [t.id, t])); const flBy = Object.fromEntries(floors.map(f => [f.id, f]));
  let items = items0.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const listEl = h('div'); const side = h('div.sticky.stack');
  const add = h('div', { style: { position: 'relative' } });
  ctx.root.append(h('div.split', { style: { gridTemplateColumns: 'minmax(0,1fr) 420px' } }, h('div.stack', canEdit ? add : null, h('div.card', listEl)), side));
  const tracker = dirtyTracker(listEl, { onSave: save }); tracker.reset = () => location.reload();
  ctx.root.append(tracker.el);

  // add via search
  const q = input({ type: 'search', placeholder: 'Tambah tenant ke featured…', 'aria-label': 'Tambah tenant' }); const pop = h('div.gs-pop', { hidden: true });
  q.addEventListener('input', debounce(() => {
    const s = q.value.toLowerCase().trim(); clear(pop); if (s.length < 2) { pop.hidden = true; return; }
    const res = tenants.filter(t => !items.some(i => i.tenantId === t.id) && t.displayName.toLowerCase().includes(s)).slice(0, 8);
    pop.hidden = !res.length;
    res.forEach(t => pop.append(h('div.gs-item', { onmousedown: ev => { ev.preventDefault(); items.push({ tenantId: t.id, startsAt: null, endsAt: null }); q.value = ''; pop.hidden = true; tracker.set(true); render(); } }, logoThumb(t.brand && t.brand.logo, t.displayName), h('div.grow', h('b', t.displayName), h('div.small.muted', t.id)))));
  }, 120));
  q.addEventListener('blur', () => setTimeout(() => pop.hidden = true, 150));
  add.append(h('div.search.filters', { style: { margin: 0 } }, h('div.search', { style: { flex: 1 } }, ic('search'), q)), pop);

  function render() {
    clear(listEl);
    if (!items.length) listEl.append(emptyState('Belum ada featured — kiosk memakai config.featured', 'star'));
    const box = h('div');
    items.forEach((it, i) => {
      const t = tBy[it.tenantId] || { displayName: it.tenantId };
      const logo = t.logoOverride || (t.brand && t.brand.logo);
      const issues = [!t.isPublished && t.isPublished !== undefined ? 'tidak terpublish' : null, !logo ? 'tanpa logo' : null, t.status === 'closed' ? 'tutup' : null].filter(Boolean);
      const s = h('input', { type: 'date', class: 'inp sm', value: isoToLocal(it.startsAt).slice(0, 10), disabled: !canEdit, style: { width: '138px' }, 'aria-label': 'Mulai', onchange: e => { it.startsAt = e.target.value ? e.target.value + 'T00:00:00+08:00' : null; tracker.set(true); } });
      const e = h('input', { type: 'date', class: 'inp sm', value: isoToLocal(it.endsAt).slice(0, 10), disabled: !canEdit, style: { width: '138px' }, 'aria-label': 'Selesai', onchange: ev => { it.endsAt = ev.target.value ? ev.target.value + 'T23:59:59+08:00' : null; tracker.set(true); } });
      box.append(h('div.row', { dataset: { k: it.tenantId }, style: { padding: '9px 14px', borderBottom: '1px solid var(--line)', gap: '12px' } },
        canEdit ? h('span.drag-handle', { title: 'Seret untuk mengurutkan' }, ic('grip-vertical')) : null,
        h('b.num.muted', { style: { width: '20px' } }, String(i + 1)), logoThumb(logo, t.displayName, false),
        h('div.grow', { style: { minWidth: '160px' } }, h('div', { style: { fontWeight: 650 } }, t.displayName), h('div.small.muted', `${t.floorId ? floorName(flBy[t.floorId]) : ''}`), issues.length ? h('div', issues.map(x => badge(x, 'danger'))) : null),
        h('div.stack', { style: { gap: '4px' } }, h('span.small.muted', 'Periode (opsional)'), h('div.row', { style: { gap: '4px' } }, s, h('span.muted', '–'), e)),
        canEdit ? btn('', { icon: 'x', size: 'sm', kind: 'ghost', title: 'Keluarkan', onClick: () => { items = items.filter(x => x !== it); tracker.set(true); render(); } }) : null));
    });
    listEl.append(box);
    if (canEdit) sortable(box, keys => { items = keys.map(k => items.find(x => x.tenantId === k)); tracker.set(true); render(); });
    clear(side).append(h('span.kicker', 'Pratinjau marquee kiosk'), kioskFrame(null, { featured: items.map(it => { const t = tBy[it.tenantId] || {}; const l = t.logoOverride || (t.brand && t.brand.logo); return { logo: l && l.url }; }) }),
      h('div.small.muted', '7 logo pertama terlihat bersamaan; marquee bergulir terus (mode lite: grid berganti halaman tiap 6 dtk).'));
  }
  async function save() {
    const bad = items.filter(it => { const t = tBy[it.tenantId]; return !t || !(t.logoOverride || (t.brand && t.brand.logo)); });
    if (bad.length) toast(`${bad.length} tenant tanpa logo — validasi publish akan menolaknya`, 'warn');
    await api.put('/featured', { items: items.map(it => ({ tenantId: it.tenantId, startsAt: it.startsAt, endsAt: it.endsAt })) });
    toast('Urutan featured disimpan — publish kanal promo'); ctx.refreshStatus(); return true;
  }
  render();
}
