// CMS shell: sidebar, topbar (global tenant search, unpublished badge, Publish), hash router.
import { h, ic, clear, append, toast, dialog, field, input, confirmDlg, currentSaver, clearSaver, debounce, assetUrl, initials, loading, showFieldErrors } from './ui.js';
import { api, MOCK, lookups, invalidate } from './api.js';
import { state, loadMe, can, onMe, ROLE_LABEL } from './state.js';

const NAV = [
  { group: 'Ringkasan', items: [{ path: '', label: 'Dashboard', icon: 'layout-dashboard' }] },
  { group: 'Konten', items: [
    { path: 'tenants', label: 'Tenant', icon: 'store' },
    { path: 'categories', label: 'Kategori', icon: 'tags' },
    { path: 'media', label: 'Media', icon: 'image' }] },
  { group: 'Peta', items: [
    { path: 'floors', label: 'Lantai', icon: 'layers' },
    { path: 'graph', label: 'Editor graph', icon: 'waypoints' },
    { path: 'connectors', label: 'Eskalator & lift', icon: 'arrow-up-down' },
    { path: 'kiosks', label: 'Kiosk', icon: 'monitor' },
    { path: 'amenities', label: 'Fasilitas', icon: 'map-pin' }] },
  { group: 'Operasional', items: [{ path: 'ops', label: 'Status Ops', icon: 'wrench', badge: 'closures' }] },
  { group: 'Marketing', items: [
    { path: 'promos', label: 'Promo', icon: 'megaphone' },
    { path: 'events', label: 'Event', icon: 'calendar' },
    { path: 'featured', label: 'Featured', icon: 'star' },
    { path: 'i18n', label: 'Teks kiosk', icon: 'languages' }] },
  { group: 'Rilis', items: [{ path: 'publish', label: 'Publish', icon: 'rocket' }] },
  { group: 'Laporan', items: [
    { path: 'analytics', label: 'Analitik', icon: 'chart-column', perm: 'analytics.view' },
    { path: 'audit', label: 'Audit log', icon: 'scroll-text', perm: 'audit.view' }] },
  { group: 'Sistem', items: [
    { path: 'users', label: 'Pengguna', icon: 'users', perm: 'users.manage' },
    { path: 'settings', label: 'Pengaturan', icon: 'settings', perm: 'settings.edit' }] },
];

const ROUTES = [
  ['', () => import('./pages/dashboard.js')],
  ['tenants', () => import('./pages/tenants.js')],
  ['tenants/:id', () => import('./pages/tenant-edit.js')],
  ['categories', () => import('./pages/categories.js')],
  ['media', () => import('./pages/media.js')],
  ['floors', () => import('./pages/floors.js')],
  ['graph', () => import('./pages/graph.js'), { full: true }],
  ['connectors', () => import('./pages/connectors.js')],
  ['connectors/:id', () => import('./pages/connectors.js')],
  ['ops', () => import('./pages/ops.js')],
  ['kiosks', () => import('./pages/kiosks.js')],
  ['kiosks/:id', () => import('./pages/kiosks.js')],
  ['amenities', () => import('./pages/amenities.js')],
  ['promos', () => import('./pages/promos.js')],
  ['promos/:id', () => import('./pages/promos.js')],
  ['events', () => import('./pages/events.js')],
  ['featured', () => import('./pages/featured.js')],
  ['i18n', () => import('./pages/i18n.js')],
  ['publish', () => import('./pages/publish.js')],
  ['analytics', () => import('./pages/analytics.js')],
  ['audit', () => import('./pages/audit.js')],
  ['users', () => import('./pages/system.js')],
  ['settings', () => import('./pages/system.js')],
];

let appEl, mainEl, navEl, liveEl, unpubEl, closureCount = 0;

function buildShell() {
  const lockup = h('div.lockup', { role: 'img', 'aria-label': 'e-Walk & Pentacity' },
    h('img', { src: assetUrl('assets/brand/ewalk.webp'), alt: '' }), h('i'), h('img', { src: assetUrl('assets/brand/pentacity.webp'), alt: '' }));
  navEl = h('nav.sb-nav', { 'aria-label': 'Navigasi utama' });
  const me = state.me.user;
  const sidebar = h('aside.sidebar',
    h('a.sb-brand', { href: '#/', title: 'Dashboard' }, lockup, h('span.cms-tag', 'CMS')),
    navEl,
    h('div.sb-foot', h('div.avatar', initials(me.name)), h('div.sb-user', h('b', me.name), h('span', ROLE_LABEL[me.role] || me.role)),
      h('button.btn.ghost.sm.icon', { title: 'Ganti password', 'aria-label': 'Ganti password', onclick: changePassword }, ic('key-round')),
      h('button.btn.ghost.sm.icon', { title: 'Keluar', 'aria-label': 'Keluar', onclick: logout }, ic('log-out'))));

  // global tenant search
  const gs = h('div.gsearch');
  const gin = h('input', { type: 'search', placeholder: 'Cari tenant…', 'aria-label': 'Cari tenant', autocomplete: 'off' });
  const pop = h('div.gs-pop', { hidden: true, role: 'listbox' });
  let items = [], idx = 0;
  const show = () => { [...pop.children].forEach((c, i) => c.classList.toggle('on', i === idx)); };
  const run = debounce(async () => {
    const q = gin.value.trim(); if (q.length < 2) { pop.hidden = true; return; }
    const all = await lookups.tenantsLite().catch(() => []);
    const ql = q.toLowerCase();
    items = all.filter(t => (t.displayName + ' ' + t.id + ' ' + (t.unitNo || '')).toLowerCase().includes(ql)).slice(0, 8);
    clear(pop); idx = 0;
    if (!items.length) pop.append(h('div.gs-item.muted', 'Tidak ada tenant cocok'));
    items.forEach((t, i) => pop.append(h('div.gs-item', { role: 'option', onmousedown: e => { e.preventDefault(); go(t); } },
      t.brand && t.brand.logo ? h('img', { src: assetUrl(t.brand.logo.url), alt: '' }) : h('span.logo-ph', initials(t.displayName)),
      h('div.grow', h('div', { style: { fontWeight: 650 } }, t.displayName), h('div.small.muted', t.id)))));
    pop.hidden = false; show();
  }, 120);
  const go = t => { pop.hidden = true; gin.value = ''; gin.blur(); location.hash = '#/tenants/' + encodeURIComponent(t.id); };
  gin.addEventListener('input', run);
  gin.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { idx = Math.min(items.length - 1, idx + 1); show(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); show(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[idx]) go(items[idx]);
    else if (e.key === 'Escape') { pop.hidden = true; gin.blur(); }
  });
  gin.addEventListener('blur', () => setTimeout(() => pop.hidden = true, 150));
  gs.append(ic('search'), gin, h('kbd', '/'), pop);

  liveEl = h('span.tb-live');
  unpubEl = h('span.row');
  const topbar = h('header.topbar',
    h('button.btn.ghost.icon.tb-menu', { 'aria-label': 'Menu', onclick: () => appEl.classList.toggle('nav-open') }, ic('ellipsis')),
    h('a.tb-brand', { href: '#/', 'aria-label': 'Dashboard' }, h('div.lockup', { style: { '--lk-h': '24px' } }, h('img', { src: assetUrl('assets/brand/ewalk.webp'), alt: '' }), h('i'), h('img', { src: assetUrl('assets/brand/pentacity.webp'), alt: '' }))),
    gs,
    h('div.tb-status', MOCK ? h('span.mockflag', { title: 'Data contoh dari cms/mock — tidak tersimpan ke server' }, 'MODE MOCK') : null, unpubEl, liveEl,
      h('a.btn.primary.tb-pub', { href: '#/publish', 'aria-label': 'Publish' }, ic('rocket'), h('span', 'Publish'))));
  mainEl = h('main.main', { id: 'main' });
  appEl = h('div.app', sidebar, topbar, mainEl);
  appEl.addEventListener('click', e => { if (e.target === appEl) appEl.classList.remove('nav-open'); });
  document.body.append(appEl);
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !e.target.closest('input,textarea,select,[contenteditable]')) { e.preventDefault(); gin.focus(); }
  });
  renderNav(); renderStatus();
  onMe(renderStatus);
}

function renderNav() {
  clear(navEl);
  const cur = currentPath();
  for (const g of NAV) {
    const items = g.items.filter(it => !it.perm || can(it.perm));
    if (!items.length) continue;
    const grp = h('div.sb-group', h('div.kicker', g.group));
    for (const it of items) {
      const active = it.path === '' ? cur === '' : cur === it.path || cur.startsWith(it.path + '/');
      grp.append(h('a', { class: 'sb-link' + (active ? ' active' : ''), href: '#/' + it.path, 'aria-current': active ? 'page' : null, onclick: () => appEl.classList.remove('nav-open') },
        ic(it.icon), h('span', it.label), it.badge === 'closures' && closureCount ? h('span.sb-count', { title: closureCount + ' penutupan aktif' }, String(closureCount)) : null));
    }
    navEl.append(grp);
  }
}

function renderStatus() {
  if (!unpubEl) return;
  const me = state.me; clear(unpubEl);
  const u = me.unpublished || {};
  const parts = [u.content && 'konten', u.map && 'peta', u.promos && 'promo'].filter(Boolean);
  if (parts.length) unpubEl.append(h('a.badge.warn', { href: '#/publish', title: 'Belum dipublish: ' + parts.join(' · ') }, ic('circle-alert'), h('span.hide-sm', 'Belum dipublish: ' + parts.join(' · ')), h('span.show-sm', 'Draft')));
  else unpubEl.append(h('span.badge.ok.hide-sm', ic('circle-check'), 'Semua terpublish'));
  const d = me.live && me.live.directory;
  liveEl.textContent = '';
  if (d) append(liveEl, ['Live ', h('b', { class: 'mono', title: d.version }, d.version.split('-')[0]), d.rolledBackFrom ? h('span.badge.warn', { style: { marginLeft: '6px' } }, 'rollback') : null]);
}

export async function refreshStatus() {
  await loadMe().catch(() => { });
  try { const r = await api.get('/closures', { active: 1 }, { silent: true }); closureCount = r.data.length; renderNav(); } catch (e) { }
}

async function changePassword() {
  const body = h('div.form', field('Password saat ini', input({ type: 'password', name: 'current', autocomplete: 'current-password' }), { name: 'current' }),
    field('Password baru', input({ type: 'password', name: 'new', autocomplete: 'new-password' }), { name: 'new', hint: 'Minimal 10 karakter, bukan password umum.' }));
  await dialog({ title: 'Ganti password', body, actions: [{ label: 'Batal', value: null }, { label: 'Simpan', kind: 'primary', value: true, validate: async () => {
    try { await api.post('/auth/password', { current: body.querySelector('[name=current]').value, new: body.querySelector('[name=new]').value }); toast('Password diganti'); return true; }
    catch (e) { if (e.fields) showFieldErrors(body, e.fields); return false; }
  } }] });
}
async function logout() {
  if (!(await confirmDlg('Keluar dari CMS?', { ok: 'Keluar' }))) return;
  try { await api.post('/auth/logout'); } catch (e) { }
  location.href = 'login.html';
}

// ---------- router ----------
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [p, q] = raw.split('?');
  return { path: decodeURIComponent(p || '').replace(/\/$/, ''), query: new URLSearchParams(q || '') };
}
const currentPath = () => parseHash().path;
function match(path) {
  const segs = path ? path.split('/') : [];
  for (const [pat, loader, opts] of ROUTES) {
    const ps = pat ? pat.split('/') : [];
    if (ps.length !== segs.length) continue;
    const params = {}; let okk = true;
    ps.forEach((s, i) => { if (s.startsWith(':')) params[s.slice(1)] = segs[i]; else if (s !== segs[i]) okk = false; });
    if (okk) return { loader, params, opts: opts || {}, pattern: pat };
  }
  return null;
}

let leaving = null, lastHash = location.hash, renderSeq = 0;
async function route() {
  const saver = currentSaver();
  if (saver && saver.dirty && location.hash !== lastHash) {
    const go = await confirmDlg('Ada perubahan yang belum disimpan. Tinggalkan halaman ini?', { title: 'Perubahan belum disimpan', ok: 'Tinggalkan', danger: true });
    if (!go) { history.replaceState(null, '', lastHash || '#/'); return; }
  }
  lastHash = location.hash;
  clearSaver();
  if (leaving) { try { leaving(); } catch (e) { console.error(e); } leaving = null; }
  const seq = ++renderSeq;
  const { path, query } = parseHash();
  renderNav();
  const m = match(path);
  clear(mainEl);
  const pageEl = h('div', { class: 'page' + (m && m.opts.full ? ' full' : '') });
  mainEl.append(pageEl); mainEl.scrollTop = 0;
  if (!m) { pageEl.append(h('div.empty', ic('circle-alert'), 'Halaman tidak ditemukan. ', h('a', { href: '#/' }, 'Ke Dashboard'))); return; }
  pageEl.append(loading());
  try {
    const mod = await m.loader();
    if (seq !== renderSeq) return;
    clear(pageEl);
    const cleanups = [];
    const ctx = { root: pageEl, params: m.params, query, pattern: m.pattern, path, onLeave: fn => cleanups.push(fn), refreshStatus, setTitle: t => document.title = t + ' · CMS Direktori' };
    document.title = 'CMS Direktori · e-Walk & Pentacity';
    leaving = () => cleanups.forEach(fn => fn());
    await mod.default(ctx);
  } catch (e) {
    console.error(e);
    if (seq !== renderSeq) return;
    clear(pageEl).append(h('div.callout.danger', ic('circle-alert'), h('div', h('b', 'Halaman gagal dimuat. '), e.message || String(e))));
  }
}
window.addEventListener('beforeunload', e => { const s = currentSaver(); if (s && s.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ---------- boot ----------
(async function boot() {
  document.body.append(h('div.loading', { id: 'boot' }, h('span.spinner'), 'Memuat CMS…'));
  try { await loadMe({ noRedirect: true }); }
  catch (e) {
    if (e.status === 401 || e.code === 'unauthenticated') { location.href = 'login.html?next=' + encodeURIComponent(location.hash || ''); return; }
    document.getElementById('boot').replaceWith(h('div.login-wrap', h('div.login-card', h('h1', 'Server tidak terjangkau'),
      h('p.sub', 'API CMS belum siap atau Apache/MySQL mati. ', e.message || ''),
      h('a.btn.primary', { href: 'index.html?mock=1' }, 'Buka mode mock (data contoh)'))));
    return;
  }
  document.getElementById('boot').remove();
  if (state.me.user.mustChangePassword) { location.href = 'login.html?change=1'; return; }
  buildShell();
  if (!location.hash || location.hash === '#') {
    const role = state.me.user.role;
    if (role === 'operations' || role === 'security') history.replaceState(null, '', '#/ops');
  }
  window.addEventListener('hashchange', route);
  route();
  refreshStatus();
  setInterval(refreshStatus, 60000);
})();
export { invalidate };
