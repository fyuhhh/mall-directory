// In-browser mock of the admin API (CMS_SPEC §4.5), enabled with ?mock=1. Fixtures in cms/mock/*.json were
// generated from data/directory.json. State is kept in memory (reset on full page reload). Includes a tiny
// Dijkstra so closures/validation/route-test return realistic results.
const FIX = ['me', 'tenants', 'brands', 'categories', 'floors', 'graph', 'connectors', 'kiosks', 'amenities', 'amenity-types', 'schedules',
  'closures', 'notices', 'promos', 'events', 'featured', 'i18n', 'media', 'users', 'settings', 'releases', 'validate', 'preview',
  'preview-promos', 'analytics', 'audit'];
let S = null, loading = null;
async function load() {
  if (S) return S;
  if (!loading) loading = (async () => {
    const out = {};
    await Promise.all(FIX.map(async k => { out[k] = await (await fetch('mock/' + k + '.json', { cache: 'no-store' })).json(); }));
    // shift fixture timestamps so "now" in fixtures (4 Okt 2026 10:15 WITA) = real now
    const delta = Date.now() - Date.parse('2026-10-04T10:15:00+08:00');
    const shift = v => { if (typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+08:00$/.test(v)) { const d = new Date(Date.parse(v) + delta + 8 * 3600e3); return d.toISOString().slice(0, 19) + '+08:00'; } if (Array.isArray(v)) return v.map(shift); if (v && typeof v === 'object') { for (const k in v) v[k] = shift(v[k]); } return v; };
    for (const k of ['me', 'kiosks', 'closures', 'notices', 'connectors', 'releases', 'validate', 'audit', 'users', 'media', 'tenants']) shift(out[k]);
    out.loggedIn = (() => { try { return sessionStorage.getItem('bsb-mock-auth') === '1'; } catch (e) { return false; } })();
    out.seq = { node: 1000, edge: 5000, stop: 100, leg: 100, closure: 10, media: 1000, promo: 100, event: 10, notice: 10, user: 100, audit: 2000, release: 10 };
    out.statusSeq = 12;
    S = out; return out;
  })();
  return loading;
}
const ok = (data, extra) => ({ status: 200, json: Object.assign({ data }, extra || {}) });
const fail = (status, code, message, fields, details) => ({ status, json: { error: { code, message, fields: fields || null, details: details || null } } });
const nowIso = () => { const d = new Date(Date.now() + (480 + new Date().getTimezoneOffset()) * 60000); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+08:00`; };
const stamp = () => nowIso().slice(0, 19).replace('T', ' ');
const clone = o => JSON.parse(JSON.stringify(o));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function audit(action, entityType, entityId, summary, before, after) {
  S.audit.unshift({ id: ++S.seq.audit, ts: nowIso(), user: S.me.user.name, ip: '127.0.0.1', action, entityType, entityId: entityId == null ? null : String(entityId), summary, before: before || null, after: after || null });
}
const touch = scope => { S.me.unpublished[scope] = true; };
function paginate(list, q) {
  const per = Math.min(500, +q.get('per') || 50), page = Math.max(1, +q.get('page') || 1);
  return { status: 200, json: { data: list.slice((page - 1) * per, page * per), total: list.length, page, per } };
}
function changedFields(before, after) { const b = {}, a = {}; for (const k in after) if (JSON.stringify(before[k]) !== JSON.stringify(after[k]) && k !== 'etag') { b[k] = before[k]; a[k] = after[k]; } return [b, a]; }

// ---------------- routing graph (for impact / validation / route test) ----------------
function floorsById() { const m = {}; S.floors.forEach(f => m[f.id] = f); return m; }
function allNodes() { const m = {}; for (const fid in S.graph) for (const n of S.graph[fid].nodes) m[n.id] = Object.assign({ floor: fid }, n); return m; }
function activeClosures(at = Date.now()) {
  return S.closures.filter(c => !c.endedAt && Date.parse(c.startsAt) <= at && (!c.endsAt || Date.parse(c.endsAt) > at));
}
function buildAdj({ accessible = false, applyClosures = true } = {}) {
  const adj = {}; const add = (a, b, c, t, key) => { (adj[a] = adj[a] || []).push([b, c, t, key]); };
  const closed = applyClosures ? activeClosures() : [];
  const edgeClosed = new Set(closed.filter(c => c.target.type === 'edge').map(c => +c.target.id));
  for (const fid in S.graph) for (const e of S.graph[fid].edges) {
    if (!e.enabled || edgeClosed.has(e.id)) continue;
    add(e.a, e.b, e.cost, 'walk'); add(e.b, e.a, e.cost, 'walk');
  }
  for (const bank of S.connectors) {
    if (!bank.isEnabled) continue;
    const bankCl = closed.filter(c => c.target.type === 'bank' && c.target.id === bank.id);
    for (const leg of bank.legs) {
      if (!leg.isEnabled) continue;
      const lo = bank.stops.find(s => s.id === leg.lowerStopId), up = bank.stops.find(s => s.id === leg.upperStopId);
      if (!lo || !up) continue;
      if (bank.type === 'lift' && (!lo.isServed || !up.isServed)) continue;
      const cl = bankCl.concat(closed.filter(c => c.target.type === 'leg' && +c.target.id === leg.id));
      const shut = d => cl.some(c => c.direction === 'both' || c.direction === d);
      const esc = bank.type === 'escalator' || bank.type === 'travelator';
      if (esc) {
        if (accessible) continue;
        if (leg.direction !== 'down' && !shut('up')) add(lo.nodeId, up.nodeId, leg.cost, 'escalator-up', 'L' + leg.id);
        if (leg.direction !== 'up' && !shut('down')) add(up.nodeId, lo.nodeId, leg.cost, 'escalator-down', 'L' + leg.id);
      } else {
        if (accessible && bank.type === 'stairs') continue;
        if (shut('both') || shut('up') && shut('down')) continue;
        add(lo.nodeId, up.nodeId, leg.cost, bank.type, 'L' + leg.id); add(up.nodeId, lo.nodeId, leg.cost, bank.type, 'L' + leg.id);
      }
    }
  }
  return adj;
}
function dijkstra(adj, src) {
  const dist = { [src]: 0 }, prev = {}, done = new Set(); const pq = [[0, src]];
  while (pq.length) {
    let bi = 0; for (let i = 1; i < pq.length; i++) if (pq[i][0] < pq[bi][0]) bi = i;
    const [d, u] = pq.splice(bi, 1)[0]; if (done.has(u)) continue; done.add(u);
    for (const [v, c] of adj[u] || []) { const nd = d + c; if (dist[v] == null || nd < dist[v]) { dist[v] = nd; prev[v] = u; pq.push([nd, v]); } }
  }
  return { dist, prev };
}
function reachability(opts) {
  const adj = buildAdj(opts);
  const kiosks = S.kiosks.filter(k => k.isActive && k.nodeId);
  const tenants = S.tenants.filter(t => t.isPublished && t.status !== 'closed' && t.nodeId);
  const per = {}; const unreachable = {};
  for (const k of kiosks) {
    const { dist } = dijkstra(adj, k.nodeId); let n = 0;
    for (const t of tenants) { if (dist[t.nodeId] != null) n++; else (unreachable[t.id] = unreachable[t.id] || []).push(k.id); }
    per[k.id] = n;
  }
  return { per, unreachable, total: tenants.length, kiosks };
}
function computeImpact() {
  const d = reachability({ applyClosures: true }), a = reachability({ applyClosures: true, accessible: true });
  const fmt = u => Object.entries(u).filter(([, ks]) => ks.length === d.kiosks.length).map(([tenant, fromKiosks]) => ({ tenant, name: (S.tenants.find(t => t.id === tenant) || {}).displayName, fromKiosks }));
  return { unreachableDefault: fmt(d.unreachable), unreachableAccessible: fmt(a.unreachable) };
}
function runValidation() {
  const base = clone(S.validate);
  const d = reachability({ applyClosures: false }), a = reachability({ applyClosures: false, accessible: true });
  const perKiosk = {};
  for (const k of d.kiosks) perKiosk[k.id] = { total: d.total, default: d.per[k.id], accessible: a.per[k.id], returnFail: 0 };
  const pairs = d.total * d.kiosks.length; const reach = Object.values(d.per).reduce((x, y) => x + y, 0); const acc = Object.values(a.per).reduce((x, y) => x + y, 0);
  base.stats = { pairs, reachable: reach, reachablePct: +(100 * reach / pairs).toFixed(1), accessiblePct: +(100 * acc / pairs).toFixed(1), returnFail: 0, perKiosk };
  base.unreachable = {}; base.unreachableAccessible = {};
  base.errors = [];
  for (const [t, ks] of Object.entries(d.unreachable)) {
    if (ks.length === d.kiosks.length) base.errors.push({ code: 'E_REACH', msg: `${(S.tenants.find(x => x.id === t) || {}).displayName || t} tidak terjangkau dari kiosk mana pun`, ref: { type: 'tenant', id: t } });
    base.unreachable[t] = ks;
  }
  for (const [t, ks] of Object.entries(a.unreachable)) base.unreachableAccessible[t] = ks;
  base.warnings = base.warnings.filter(w => w.code !== 'W_REACH_ACC' && w.code !== 'W_REACH_NOW');
  for (const [t, ks] of Object.entries(a.unreachable).slice(0, 25)) base.warnings.push({ code: 'W_REACH_ACC', msg: `${(S.tenants.find(x => x.id === t) || {}).displayName || t}: tidak terjangkau mode aksesibel dari ${ks.length} kiosk`, ref: { type: 'tenant', id: t } });
  for (const c of activeClosures()) base.warnings.push({ code: 'W_REACH_NOW', msg: `${c.target.label} ditutup${c.direction !== 'both' ? ' (' + (c.direction === 'up' ? '↑' : '↓') + ')' : ''} — ${c.reasonId || ''}`, ref: { type: c.target.type, id: c.target.id, bankId: c.target.bankId } });
  for (const t of S.tenants) if (t.isPublished && !t.nodeId) base.errors.push({ code: 'E_REF', msg: `${t.displayName} belum ditempatkan di peta (node kosong)`, ref: { type: 'tenant', id: t.id } });
  base.ok = base.errors.length === 0; base.ms = 180 + Math.round(Math.random() * 200); base.ranAt = nowIso(); base.by = S.me.user.name;
  S.validate = base;
  return base;
}
function legLabel(bank, leg) {
  const f = floorsById(); return `${bank.nameId} ${f[leg.lowerFloor]?.short || leg.lowerFloor}↔${f[leg.upperFloor]?.short || leg.upperFloor}`;
}
function syncLegClosures() {
  const act = activeClosures();
  for (const b of S.connectors) for (const l of b.legs) {
    l.activeClosures = act.filter(c => (c.target.type === 'leg' && +c.target.id === l.id) || (c.target.type === 'bank' && c.target.id === b.id))
      .map(c => ({ id: c.id, direction: c.direction, startsAt: c.startsAt, endsAt: c.endsAt, reasonEn: c.reasonEn, reasonId: c.reasonId, createdBy: c.createdBy, scope: c.target.type }));
  }
}
function bumpStatus() { S.statusSeq++; const v = 'S' + String(S.statusSeq).padStart(4, '0') + '-' + nowIso().replace(/[-T:]/g, '').slice(0, 12); S.me.live.status = { version: v, publishedAt: nowIso() }; return v; }
function graphStopsRefresh() {
  for (const fid in S.graph) S.graph[fid].attachments.stops = [];
  for (const b of S.connectors) for (const s of b.stops) {
    const g = S.graph[s.floorId]; if (!g) continue;
    const legs = b.legs.filter(l => l.lowerStopId === s.id || l.upperStopId === s.id).map(l => ({ id: l.id, toFloor: l.lowerStopId === s.id ? l.upperFloor : l.lowerFloor, direction: l.direction, enabled: l.isEnabled }));
    g.attachments.stops.push({ id: s.id, bankId: b.id, type: b.type, publicId: s.publicId, nodeId: s.nodeId, x: s.x, y: s.y, legs });
  }
}
const COST = { escalator: 19.2, lift: 38.4, stairs: 28.8, travelator: 9.6, bridge: 0 };

// ---------------- handlers ----------------
const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

on('POST', '/admin/auth/login', (p, q, b) => {
  if (!b.email || !b.password) return fail(422, 'validation', 'Email dan password wajib', { email: !b.email ? 'required' : undefined, password: !b.password ? 'required' : undefined });
  if (b.password === 'salah') return fail(401, 'unauthenticated', 'Email atau password salah');
  S.loggedIn = true; try { sessionStorage.setItem('bsb-mock-auth', '1'); } catch (e) { }
  return ok({ user: S.me.user, permissions: S.me.permissions, csrfToken: S.me.csrfToken });
});
on('POST', '/admin/auth/logout', () => { S.loggedIn = false; try { sessionStorage.setItem('bsb-mock-auth', '0'); } catch (e) { } return ok(true); });
on('GET', '/admin/auth/me', () => S.loggedIn ? ok(S.me) : fail(401, 'unauthenticated', 'Belum login'));
on('POST', '/admin/auth/password', (p, q, b) => (b.new || '').length < 10 ? fail(422, 'validation', 'Password minimal 10 karakter', { new: 'Minimal 10 karakter' }) : (S.me.user.mustChangePassword = false, ok(true)));

// tenants
function tenantFilter(q) {
  let l = S.tenants;
  const s = (q.get('q') || '').toLowerCase();
  if (s) l = l.filter(t => (t.displayName + ' ' + t.id + ' ' + (t.unitNo || '') + ' ' + (t.brand.keywordsEn || '') + ' ' + (t.brand.keywordsId || '')).toLowerCase().includes(s));
  if (q.get('floor')) l = l.filter(t => t.floorId === q.get('floor'));
  if (q.get('building')) l = l.filter(t => t.building === q.get('building'));
  if (q.get('category')) l = l.filter(t => t.brand.categoryId === q.get('category'));
  if (q.get('status')) l = l.filter(t => t.status === q.get('status'));
  const m = q.get('missing');
  if (m === 'logo') l = l.filter(t => !t.brand.logo && !t.logoOverride);
  if (m === 'hours') l = l.filter(t => t.hoursMode === 'unknown');
  if (m === 'placement') l = l.filter(t => !t.nodeId);
  if (m === 'unit') l = l.filter(t => !t.unitShapeId);
  return l;
}
function tenantIssues(t) {
  const i = []; if (!t.brand.logo && !t.logoOverride) i.push('W_NO_LOGO'); if (t.hoursMode === 'unknown') i.push('W_NO_HOURS'); if (!t.nodeId) i.push('E_UNPLACED'); return i;
}
function displayName(t) {
  if (t.nameOverride) return t.nameOverride;
  const outlets = S.tenants.filter(x => x.brandId === t.brandId && x.isPublished);
  if (outlets.length <= 1) return t.brand.name;
  const fl = floorsById()[t.floorId]; const bname = t.building === 'ewalk' ? 'E-Walk' : 'Pentacity';
  const same = outlets.filter(x => x.building === t.building).length > 1;
  return `${t.brand.name} · ${bname}${same ? ' ' + (fl ? fl.short : '') : ''}`;
}
on('GET', '/admin/tenants', (p, q) => paginate(tenantFilter(q), q));
on('GET', '/admin/tenants/:id', p => { const t = S.tenants.find(x => x.id === p.id); return t ? ok(t) : fail(404, 'not_found', 'Tenant tidak ditemukan'); });
on('PUT', '/admin/tenants/:id', (p, q, b, o) => {
  const t = S.tenants.find(x => x.id === p.id); if (!t) return fail(404, 'not_found', 'Tenant tidak ditemukan');
  if (o.etag && o.etag !== t.etag) return fail(409, 'conflict', 'Data diubah oleh pengguna lain', null, { current: t, by: 'Rina Leasing', at: t.updatedAt });
  const errs = {};
  if (b.brand && b.brand.url && !/^https:\/\//.test(b.brand.url)) errs['brand.url'] = 'https';
  if (b.urlOverride && !/^https:\/\//.test(b.urlOverride)) errs.urlOverride = 'https';
  if (b.brand && !b.brand.name) errs['brand.name'] = 'required';
  if (Object.keys(errs).length) return fail(422, 'validation', 'Isian tidak valid', errs);
  const before = clone(t);
  Object.assign(t, b, { id: t.id });
  if (b.brand) { const br = S.brands.find(x => x.id === t.brandId); Object.assign(br, b.brand); S.tenants.filter(x => x.brandId === t.brandId).forEach(x => x.brand = Object.assign({}, br, { outletCount: S.tenants.filter(y => y.brandId === br.id).length })); }
  t.displayName = displayName(t); t.issues = tenantIssues(t); t.etag = stamp(); t.updatedAt = nowIso();
  const g = S.graph[t.floorId]; if (g) { const a = g.attachments.tenants.find(x => x.id === t.id); if (a) Object.assign(a, { x: t.x, y: t.y, nodeId: t.nodeId, unitShapeId: t.unitShapeId, name: t.displayName }); }
  const [bf, af] = changedFields(before, t);
  audit('update', 'tenant', t.id, 'Ubah ' + Object.keys(af).filter(k => !['issues', 'updatedAt', 'displayName'].includes(k)).join(', '), bf, af); touch('content');
  return ok(t);
});
on('POST', '/admin/tenants', (p, q, b) => {
  const errs = {};
  if (!b.id) errs.id = 'required'; else if (S.tenants.some(t => t.id === b.id)) errs.id = 'unique'; else if (!/^[a-z0-9-]+$/.test(b.id)) errs.id = 'Hanya huruf kecil, angka, tanda minus';
  if (!b.floorId) errs.floorId = 'required';
  if (!b.brandId && !(b.brand && b.brand.name)) errs['brand.name'] = 'required';
  if (Object.keys(errs).length) return fail(422, 'validation', 'Isian tidak valid', errs);
  let br = b.brandId ? S.brands.find(x => x.id === +b.brandId) : null;
  if (!br) { br = Object.assign({ id: S.brands.length + 1, slug: b.brand.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), logo: null, outletCount: 0 }, b.brand); S.brands.push(br); }
  br.outletCount = (br.outletCount || 0) + 1;
  const t = Object.assign({ status: 'open', hoursMode: 'unknown', hours: [], isPublished: true, x: null, y: null, nodeId: null, unitShapeId: null, logoOverride: null }, b, { brandId: br.id, brand: Object.assign({}, br) });
  t.displayName = displayName(t); t.issues = tenantIssues(t); t.etag = stamp(); t.updatedAt = nowIso();
  S.tenants.push(t); audit('create', 'tenant', t.id, 'Tenant baru ' + t.displayName); touch('content');
  return { status: 201, json: { data: t } };
});
on('DELETE', '/admin/tenants/:id', p => { const i = S.tenants.findIndex(x => x.id === p.id); if (i < 0) return fail(404, 'not_found', 'Tidak ditemukan'); const [t] = S.tenants.splice(i, 1); audit('delete', 'tenant', t.id, 'Hapus ' + t.displayName); touch('content'); return ok(true); });
on('POST', '/admin/tenants/bulk', (p, q, b) => {
  for (const id of b.ids || []) { const t = S.tenants.find(x => x.id === id); if (!t) continue; if (b.set.status) t.status = b.set.status; if (b.set.categoryId) { t.brand.categoryId = b.set.categoryId; S.brands.find(x => x.id === t.brandId).categoryId = b.set.categoryId; } t.etag = stamp(); }
  audit('update', 'tenant', null, `Ubah massal ${b.ids.length} tenant`, null, b.set); touch('content'); return ok({ updated: (b.ids || []).length });
});
on('GET', '/admin/brands', (p, q) => { const s = (q.get('q') || '').toLowerCase(); return ok(S.brands.filter(b => !s || b.name.toLowerCase().includes(s)).slice(0, 30)); });

// generic collections
function crud(name, key = 'id', scope = 'content', label = name) {
  const coll = () => S[name];
  on('GET', `/admin/${name}`, (p, q) => ok(coll()));
  on('GET', `/admin/${name}/:id`, p => { const x = coll().find(r => String(r[key]) === p.id); return x ? ok(x) : fail(404, 'not_found', 'Tidak ditemukan'); });
  on('PUT', `/admin/${name}/:id`, (p, q, b, o) => {
    const x = coll().find(r => String(r[key]) === p.id); if (!x) return fail(404, 'not_found', 'Tidak ditemukan');
    if (o.etag && x.etag && o.etag !== x.etag) return fail(409, 'conflict', 'Data diubah oleh pengguna lain', null, { current: x, by: 'Budi Santoso' });
    const before = clone(x); Object.assign(x, b); x[key] = before[key]; x.etag = stamp();
    const [bf, af] = changedFields(before, x); audit('update', label, p.id, 'Ubah ' + Object.keys(af).join(', '), bf, af); touch(scope); return ok(x);
  });
  on('POST', `/admin/${name}`, (p, q, b) => {
    const x = Object.assign({}, b); if (key === 'id' && (x.id == null || x.id === '')) x.id = ++S.seq[name === 'promos' ? 'promo' : name === 'events' ? 'event' : name === 'users' ? 'user' : 'media'];
    if (coll().some(r => String(r[key]) === String(x[key]))) return fail(422, 'validation', 'ID sudah dipakai', { [key]: 'unique' });
    x.etag = stamp(); coll().push(x); audit('create', label, x[key], 'Buat ' + label + ' ' + x[key]); touch(scope); return { status: 201, json: { data: x } };
  });
  on('DELETE', `/admin/${name}/:id`, p => {
    const i = coll().findIndex(r => String(r[key]) === p.id); if (i < 0) return fail(404, 'not_found', 'Tidak ditemukan');
    if (name === 'categories' && S.tenants.some(t => t.brand.categoryId === p.id)) return fail(409, 'conflict', 'Kategori masih dipakai tenant', null, { refs: S.tenants.filter(t => t.brand.categoryId === p.id).length });
    coll().splice(i, 1); audit('delete', label, p.id, 'Hapus ' + label + ' ' + p.id); touch(scope); return ok(true);
  });
}
crud('categories', 'id', 'content', 'category');
crud('floors', 'id', 'map', 'floor');
crud('kiosks', 'id', 'map', 'kiosk');
crud('amenities', 'id', 'map', 'amenity');
crud('amenity-types', 'id', 'map', 'amenity_type');
crud('schedules', 'id', 'map', 'schedule');
crud('promos', 'id', 'promos', 'promo');
crud('events', 'id', 'promos', 'event');
crud('users', 'id', 'none', 'user');
on('GET', '/admin/featured', () => ok(S.featured));
on('PUT', '/admin/featured', (p, q, b) => { S.featured = (b.items || b).map((x, i) => Object.assign({}, x, { sortOrder: i + 1 })); audit('update', 'featured', null, `Urutan featured (${S.featured.length})`); touch('promos'); return ok(S.featured); });
on('GET', '/admin/i18n', () => ok(S.i18n));
on('PUT', '/admin/i18n/:key', (p, q, b) => {
  let x = S.i18n.find(r => r.key === p.key);
  if (!b.en && !b.id) { S.i18n = S.i18n.filter(r => r.key !== p.key); audit('delete', 'i18n', p.key, 'Hapus override ' + p.key); touch('content'); return ok(null); }
  if (!x) { x = { key: p.key }; S.i18n.push(x); } Object.assign(x, b, { key: p.key }); audit('update', 'i18n', p.key, 'Override ' + p.key); touch('content'); return ok(x);
});
on('GET', '/admin/settings', () => ok(S.settings));
on('PUT', '/admin/settings/:key', (p, q, b) => { const k = decodeURIComponent(p.key); const before = S.settings[k]; S.settings[k] = b.value; audit('update', 'setting', k, 'Ubah setting ' + k, { value: before }, { value: b.value }); return ok({ key: k, value: b.value }); });
on('POST', '/admin/backup/run', async () => { await sleep(900); audit('backup', 'system', null, 'Backup manual'); return ok({ file: 'D:\\bsb-backup\\db\\bsb_' + nowIso().replace(/[-T:]/g, '').slice(0, 12) + '.sql.gz', bytes: 1843200, ms: 860 }); });
on('POST', '/admin/users/:id/reset-password', p => ok({ tempPassword: 'Bsb-' + Math.random().toString(36).slice(2, 8) + '-26' }));

// floors svg replace
on('POST', '/admin/floors/:id/svg', async p => {
  await sleep(500); const f = S.floors.find(x => x.id === p.id);
  return ok({ uploadToken: 'tok-' + p.id, report: { bytesIn: 532110, bytesOut: 498771, removed: { script: 0, foreignObject: 0, 'on*': 0, externalHref: 2, image: 1, aipgf: 1 }, viewBoxOld: f.viewBox, viewBoxNew: f.viewBox, viewBoxChanged: false, shapes: 412, missingUnitShapes: f.unitShapes ? ['unit-kfc-lg-penta'] : [] }, previewUrl: f.svgUrl });
});
on('POST', '/admin/floors/:id/svg/confirm', p => { audit('update', 'floor', p.id, 'Ganti SVG lantai'); touch('map'); return ok(S.floors.find(x => x.id === p.id)); });

// kiosks extra
on('POST', '/admin/kiosks/:id/token', p => {
  const k = S.kiosks.find(x => x.id === p.id); const tok = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('');
  k.tokenHint = tok.slice(-4); audit('provision', 'kiosk', k.id, 'Buat token kiosk');
  const url = `${S.settings['public.baseUrl']}/?kiosk=${k.id}&key=${tok}`;
  return ok({ token: tok, launchUrl: url, bat: `@echo off\r\nrem start-kiosk.bat — ${k.name}\r\nstart "" "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --kiosk "${url}" --edge-kiosk-type=fullscreen --user-data-dir=C:\\kiosk\\edge --no-first-run`, qrSvg: null });
});
on('POST', '/admin/kiosks/:id/commands', (p, q, b) => { audit('command', 'kiosk', p.id, 'Command ' + b.cmd); return ok({ id: ++S.seq.audit, cmd: b.cmd, createdAt: nowIso(), deliveredAt: null }); });

// graph
on('GET', '/admin/graph', (p, q) => { const g = S.graph[q.get('floor')]; graphStopsRefresh(); return g ? ok(g) : fail(404, 'not_found', 'Lantai tidak ditemukan'); });
on('POST', '/admin/graph/ops', (p, q, b) => {
  const idMap = {}; const res = id => (typeof id === 'string' && idMap[id] != null) ? idMap[id] : (typeof id === 'string' && /^\d+$/.test(id) ? +id : id);
  const findNode = id => { for (const f in S.graph) { const n = S.graph[f].nodes.find(x => x.id === id); if (n) return [f, n]; } return [null, null]; };
  const floorsTouched = new Set();
  const rev = Object.values(S.graph)[0].revision;
  if (b.revision != null && b.revision !== rev) return fail(409, 'conflict', 'Graph sudah diubah orang lain (revisi ' + rev + ')', null, { revision: rev });
  for (const op of b.ops || []) {
    if (op.op === 'addNode') { const id = ++S.seq.node; idMap[op.tmp] = id; S.graph[op.floor].nodes.push({ id, x: op.x, y: op.y, label: op.label || null }); floorsTouched.add(op.floor); }
    else if (op.op === 'moveNode') { const [f, n] = findNode(res(op.id)); if (n) { n.x = op.x; n.y = op.y; floorsTouched.add(f); } }
    else if (op.op === 'updateNode') { const [, n] = findNode(res(op.id)); if (n) n.label = op.label ?? n.label; }
    else if (op.op === 'addEdge') {
      const a = res(op.a), bb = res(op.b); const [f, na] = findNode(a); const [f2, nb] = findNode(bb);
      if (f !== f2) return fail(422, 'validation', 'Edge lintas lantai tidak diizinkan', null, { op });
      const id = ++S.seq.edge; if (op.tmp) idMap[op.tmp] = id;
      const fl = floorsById()[f]; const len = Math.hypot(na.x - nb.x, na.y - nb.y) * fl.unitScale;
      S.graph[f].edges.push({ id, a: Math.min(a, bb), b: Math.max(a, bb), enabled: op.enabled ?? true, costOverride: op.costOverride ?? null, cost: op.costOverride ?? +len.toFixed(2), scheduleId: op.scheduleId ?? null, label: op.label ?? null });
    }
    else if (op.op === 'updateEdge') { for (const f in S.graph) { const e = S.graph[f].edges.find(x => x.id === res(op.id)); if (e) { ['enabled', 'costOverride', 'scheduleId', 'label'].forEach(k => { if (k in op) e[k] = op[k]; }); if ('costOverride' in op && op.costOverride != null) e.cost = op.costOverride; } } }
    else if (op.op === 'deleteEdge') { for (const f in S.graph) S.graph[f].edges = S.graph[f].edges.filter(x => x.id !== res(op.id)); }
    else if (op.op === 'deleteNode') {
      const id = res(op.id); const [f] = findNode(id); if (!f) continue;
      const refs = [...S.tenants.filter(t => t.nodeId === id).map(t => ({ type: 'tenant', id: t.id })), ...S.kiosks.filter(k => k.nodeId === id).map(k => ({ type: 'kiosk', id: k.id })),
        ...S.amenities.filter(a => a.nodeId === id).map(a => ({ type: 'amenity', id: a.id })), ...S.connectors.flatMap(bk => bk.stops.filter(s => s.nodeId === id).map(s => ({ type: 'stop', id: s.publicId })))];
      if (refs.length && (!op.force || refs.some(r => r.type === 'stop' || r.type === 'kiosk'))) return fail(409, 'conflict', 'Node masih dipakai', null, { refs, op });
      S.tenants.filter(t => t.nodeId === id).forEach(t => { t.nodeId = null; t.issues = tenantIssues(t); });
      S.amenities.filter(a => a.nodeId === id).forEach(a => a.nodeId = null);
      S.graph[f].nodes = S.graph[f].nodes.filter(n => n.id !== id); S.graph[f].edges = S.graph[f].edges.filter(e => e.a !== id && e.b !== id);
    }
    else if (op.op === 'mergeNodes') {
      const keep = res(op.keep), rem = res(op.remove); const [f] = findNode(rem); if (!f) continue;
      for (const e of S.graph[f].edges) { if (e.a === rem) e.a = keep; if (e.b === rem) e.b = keep; const a = Math.min(e.a, e.b), bb = Math.max(e.a, e.b); e.a = a; e.b = bb; }
      const seen = new Set(); S.graph[f].edges = S.graph[f].edges.filter(e => { const k = e.a + '-' + e.b; if (e.a === e.b || seen.has(k)) return false; seen.add(k); return true; });
      S.graph[f].nodes = S.graph[f].nodes.filter(n => n.id !== rem);
      [...S.tenants, ...S.kiosks, ...S.amenities].forEach(x => { if (x.nodeId === rem) x.nodeId = keep; });
    }
    else if (op.op === 'splitEdge') {
      for (const f in S.graph) { const e = S.graph[f].edges.find(x => x.id === op.edge); if (!e) continue; const id = ++S.seq.node; idMap[op.tmp] = id; S.graph[f].nodes.push({ id, x: op.x, y: op.y, label: null }); S.graph[f].edges = S.graph[f].edges.filter(x => x !== e); const fl = floorsById()[f]; [[e.a, id], [id, e.b]].forEach(([a, bb]) => { const na = S.graph[f].nodes.find(n => n.id === a), nb = S.graph[f].nodes.find(n => n.id === bb); S.graph[f].edges.push({ id: ++S.seq.edge, a: Math.min(a, bb), b: Math.max(a, bb), enabled: e.enabled, costOverride: null, cost: +(Math.hypot(na.x - nb.x, na.y - nb.y) * fl.unitScale).toFixed(2), scheduleId: e.scheduleId, label: e.label }); }); }
    }
    else if (op.op === 'attach') {
      const node = res(op.node); const coll = op.entity === 'tenant' ? S.tenants : op.entity === 'kiosk' ? S.kiosks : S.amenities;
      const x = coll.find(r => r.id === op.id); if (x) { x.nodeId = node; if (op.entity === 'tenant') x.issues = tenantIssues(x); }
      for (const f in S.graph) { const list = S.graph[f].attachments[op.entity === 'tenant' ? 'tenants' : op.entity === 'kiosk' ? 'kiosks' : 'amenities']; const a = list.find(r => r.id === op.id); if (a) a.nodeId = node; }
    }
  }
  for (const f in S.graph) S.graph[f].revision = rev + 1;
  audit('update', 'graph', null, `Graph: ${(b.ops || []).length} operasi`, null, { ops: (b.ops || []).map(o => o.op) }); touch('map');
  return ok({ revision: rev + 1, idMap });
});

// connectors
const bankById = id => S.connectors.find(b => b.id === id);
const legById = id => { for (const b of S.connectors) { const l = b.legs.find(x => x.id === +id); if (l) return [b, l]; } return [null, null]; };
on('GET', '/admin/connectors', () => { syncLegClosures(); return ok(S.connectors); });
on('GET', '/admin/connectors/:id', p => { syncLegClosures(); const b = bankById(p.id); return b ? ok(b) : fail(404, 'not_found', 'Bank tidak ditemukan'); });
on('PUT', '/admin/connectors/:id', (p, q, b, o) => {
  const bk = bankById(p.id); if (!bk) return fail(404, 'not_found', 'Bank tidak ditemukan');
  if (o.etag && bk.etag && o.etag !== bk.etag) return fail(409, 'conflict', 'Bank diubah orang lain', null, { current: bk });
  const before = clone(bk); ['type', 'building', 'code', 'nameEn', 'nameId', 'landmarkEn', 'landmarkId', 'isEnabled', 'scheduleId', 'notes', 'sortOrder'].forEach(k => { if (k in b) bk[k] = b[k]; });
  bk.etag = stamp(); const [bf, af] = changedFields(before, bk); delete bf.stops; delete af.stops; delete bf.legs; delete af.legs;
  audit('update', 'bank', bk.id, 'Ubah bank ' + bk.nameId, bf, af); touch('map'); return ok(bk);
});
on('POST', '/admin/connectors', (p, q, b) => {
  if (!b.id || bankById(b.id)) return fail(422, 'validation', 'ID bank wajib & unik', { id: b.id ? 'unique' : 'required' });
  const bk = Object.assign({ isEnabled: true, scheduleId: null, notes: null, stops: [], legs: [], sortOrder: S.connectors.length + 1 }, b, { etag: stamp() });
  S.connectors.push(bk); audit('create', 'bank', bk.id, 'Bank baru ' + bk.nameId); touch('map'); return { status: 201, json: { data: bk } };
});
on('POST', '/admin/connectors/:id/stops', (p, q, b) => {
  const bk = bankById(p.id); const fl = floorsById()[b.floorId]; let nodeId = b.nodeId, x = b.x, y = b.y;
  if (!nodeId) { nodeId = ++S.seq.node; S.graph[b.floorId].nodes.push({ id: nodeId, x, y, label: null });
    // connect to nearest node on the floor
    let best = null; for (const n of S.graph[b.floorId].nodes) { if (n.id === nodeId) continue; const d = Math.hypot(n.x - x, n.y - y); if (!best || d < best[0]) best = [d, n]; }
    if (best) S.graph[b.floorId].edges.push({ id: ++S.seq.edge, a: Math.min(best[1].id, nodeId), b: Math.max(best[1].id, nodeId), enabled: true, costOverride: null, cost: +(best[0] * fl.unitScale).toFixed(2), scheduleId: null, label: null });
  } else { const n = S.graph[b.floorId].nodes.find(n => n.id === +nodeId); x = n.x; y = n.y; }
  const n = bk.stops.filter(s => s.floorId === b.floorId).length;
  const st = { id: ++S.seq.stop, publicId: `${bk.id}-${b.floorId}${n ? '-' + (n + 1) : ''}`, floorId: b.floorId, level: fl.level, nodeId: +nodeId, isServed: true, labelEn: null, labelId: null, x, y };
  bk.stops.push(st); audit('create', 'stop', st.publicId, `Stop baru ${st.publicId}`); touch('map'); graphStopsRefresh(); return { status: 201, json: { data: st } };
});
on('PUT', '/admin/connector-stops/:id', (p, q, b) => {
  for (const bk of S.connectors) { const s = bk.stops.find(x => x.id === +p.id); if (s) { Object.assign(s, b, { id: s.id }); audit('update', 'stop', s.publicId, 'Ubah stop ' + s.publicId, null, b); touch('map'); return ok(s); } }
  return fail(404, 'not_found', 'Stop tidak ditemukan');
});
on('DELETE', '/admin/connector-stops/:id', p => {
  for (const bk of S.connectors) { const i = bk.stops.findIndex(x => x.id === +p.id); if (i >= 0) { const [s] = bk.stops.splice(i, 1); bk.legs = bk.legs.filter(l => l.lowerStopId !== s.id && l.upperStopId !== s.id); audit('delete', 'stop', s.publicId, 'Hapus stop ' + s.publicId); touch('map'); graphStopsRefresh(); return ok(true); } }
  return fail(404, 'not_found', 'Stop tidak ditemukan');
});
on('POST', '/admin/connectors/:id/legs', (p, q, b) => {
  const bk = bankById(p.id); const lo = bk.stops.find(s => s.id === +b.lowerStopId), up = bk.stops.find(s => s.id === +b.upperStopId);
  if (!lo || !up) return fail(422, 'validation', 'Stop tidak valid', { lowerStopId: 'required' });
  if (bk.type !== 'bridge' && lo.level >= up.level) return fail(422, 'validation', 'Level stop bawah harus lebih rendah dari stop atas (E_LEG_LEVEL)', { upperStopId: 'E_LEG_LEVEL' });
  const span = Math.max(1, up.level - lo.level);
  const leg = { id: ++S.seq.leg, lowerStopId: lo.id, upperStopId: up.id, lowerFloor: lo.floorId, upperFloor: up.floorId, direction: bk.type === 'escalator' || bk.type === 'travelator' ? (b.direction || 'both') : 'both', isEnabled: true, scheduleId: null, costOverride: null, cost: +(COST[bk.type] * span).toFixed(2), srcKey: null, verifiedAt: null, verifiedBy: null, fieldNote: null, activeClosures: [] };
  bk.legs.push(leg); audit('create', 'leg', leg.id, 'Leg baru ' + legLabel(bk, leg)); touch('map'); graphStopsRefresh(); return { status: 201, json: { data: leg } };
});
on('PUT', '/admin/connector-legs/:id', (p, q, b) => {
  const [bk, l] = legById(p.id); if (!l) return fail(404, 'not_found', 'Leg tidak ditemukan');
  const before = clone(l);
  ['direction', 'isEnabled', 'scheduleId', 'costOverride', 'fieldNote'].forEach(k => { if (k in b) l[k] = b[k]; });
  if (bk.type !== 'escalator' && bk.type !== 'travelator') l.direction = 'both';
  if (b.verified === true) { l.verifiedAt = nowIso(); l.verifiedBy = S.me.user.name; } else if (b.verified === false) { l.verifiedAt = null; l.verifiedBy = null; }
  if (l.costOverride != null) l.cost = l.costOverride;
  const [bf, af] = changedFields(before, l); delete bf.activeClosures; delete af.activeClosures;
  audit('update', 'leg', l.id, 'Ubah leg ' + legLabel(bk, l), bf, af); touch('map'); graphStopsRefresh(); return ok(l);
});
on('DELETE', '/admin/connector-legs/:id', p => { const [bk, l] = legById(p.id); if (!l) return fail(404, 'not_found', 'Leg tidak ditemukan'); bk.legs = bk.legs.filter(x => x !== l); audit('delete', 'leg', l.id, 'Hapus leg ' + legLabel(bk, l)); touch('map'); graphStopsRefresh(); return ok(true); });
on('POST', '/admin/connectors/:id/regenerate-lift-legs', p => {
  const bk = bankById(p.id); const served = bk.stops.filter(s => s.isServed).sort((a, b) => a.level - b.level);
  const old = bk.legs; bk.legs = [];
  for (let i = 0; i + 1 < served.length; i++) {
    const lo = served[i], up = served[i + 1]; const prev = old.find(l => l.lowerStopId === lo.id && l.upperStopId === up.id);
    bk.legs.push(prev || { id: ++S.seq.leg, lowerStopId: lo.id, upperStopId: up.id, lowerFloor: lo.floorId, upperFloor: up.floorId, direction: 'both', isEnabled: true, scheduleId: null, costOverride: null, cost: +(COST.lift * Math.max(1, up.level - lo.level)).toFixed(2), srcKey: null, verifiedAt: null, verifiedBy: null, fieldNote: null, activeClosures: [] });
  }
  audit('update', 'bank', bk.id, `Regenerate leg lift (${bk.legs.length} leg)`); touch('map'); graphStopsRefresh(); return ok(bk);
});

// closures & notices
on('GET', '/admin/closures', (p, q) => { const act = q.get('active') === '1'; return ok(act ? activeClosures(Date.now() + 365 * 864e5).filter(c => !c.endedAt) : S.closures); });
on('POST', '/admin/closures', async (p, q, b) => {
  await sleep(250);
  const t = b.target || {}; let label = t.id, bankId = null;
  if (t.type === 'leg') { const [bk, l] = legById(t.id); if (!l) return fail(422, 'validation', 'Leg tidak ditemukan', { target: 'not_found' }); label = legLabel(bk, l); bankId = bk.id; }
  if (t.type === 'bank') { const bk = bankById(t.id); label = bk.nameId + ' (semua leg)'; bankId = bk.id; }
  const c = { id: ++S.seq.closure, target: { type: t.type, id: String(t.id), bankId, label }, direction: b.direction || 'both', startsAt: b.startsAt || nowIso(), endsAt: b.endsAt || null, reasonEn: b.reasonEn || null, reasonId: b.reasonId || null, createdBy: S.me.user.name, createdAt: nowIso(), endedAt: null };
  S.closures.unshift(c); syncLegClosures();
  audit('closure_start', t.type, t.id, `Tutup ${c.direction === 'both' ? '' : (c.direction === 'up' ? '↑ ' : '↓ ')}${label} (${c.reasonId || '-'})`, null, { direction: c.direction, endsAt: c.endsAt });
  const statusVersion = bumpStatus();
  return ok({ closure: c, statusVersion, impact: computeImpact() });
});
on('POST', '/admin/closures/:id/end', p => {
  const c = S.closures.find(x => x.id === +p.id); if (!c) return fail(404, 'not_found', 'Closure tidak ditemukan');
  c.endedAt = nowIso(); c.endsAt = c.endedAt; syncLegClosures();
  audit('closure_end', c.target.type, c.target.id, `Buka kembali ${c.target.label}`); const statusVersion = bumpStatus();
  return ok({ closure: c, statusVersion, impact: computeImpact() });
});
on('GET', '/admin/notices', () => { S.notices.forEach(n => n.active = !n.endedAt && (!n.endsAt || Date.parse(n.endsAt) > Date.now()) && Date.parse(n.startsAt) <= Date.now()); return ok(S.notices); });
on('POST', '/admin/notices', (p, q, b) => {
  if (!b.textId || !b.textEn) return fail(422, 'validation', 'Teks ID & EN wajib', { textId: !b.textId ? 'required' : undefined, textEn: !b.textEn ? 'required' : undefined });
  S.notices.forEach(n => { if (n.active) { n.endedAt = nowIso(); n.active = false; } });
  const n = Object.assign({ id: ++S.seq.notice, startsAt: nowIso(), createdBy: S.me.user.name, active: true, allKiosks: true, kioskIds: null }, b);
  S.notices.unshift(n); audit('notice', 'notice', n.id, `Pengumuman ${n.level}: ${n.textId.slice(0, 40)}`); bumpStatus(); return ok(n);
});
on('POST', '/admin/notices/:id/end', p => { const n = S.notices.find(x => x.id === +p.id); n.endedAt = nowIso(); n.endsAt = n.endedAt; n.active = false; audit('notice_end', 'notice', n.id, 'Akhiri pengumuman'); bumpStatus(); return ok(n); });

// validation & publish
on('GET', '/admin/validate/last', () => ok(S.validate));
on('POST', '/admin/validate', async () => { await sleep(500); return ok(runValidation()); });
on('POST', '/admin/validate/route', (p, q, b) => {
  const adj = buildAdj({ accessible: !!b.accessible, applyClosures: b.now !== false });
  const { dist, prev } = dijkstra(adj, +b.from); if (dist[+b.to] == null) return ok({ ok: false, reason: 'noroute', path: [] });
  const nodes = allNodes(); const path = []; let u = +b.to; while (u != null) { path.unshift(u); u = prev[u]; }
  return ok({ ok: true, cost: +dist[+b.to].toFixed(2), path: path.map(id => ({ id, floor: nodes[id].floor, x: nodes[id].x, y: nodes[id].y })) });
});
on('GET', '/admin/publish/preview', async (p, q) => {
  await sleep(300);
  if (q.get('channel') === 'promos') return ok(S['preview-promos']);
  const pv = clone(S.preview); pv.validation = runValidation(); pv.canPublish = pv.validation.ok; pv.blockers = pv.validation.ok ? [] : ['Validasi gagal: ' + pv.validation.errors.length + ' error'];
  pv.sectionsChanged = ['content', 'map'].filter(s => S.me.unpublished[s]);
  return ok(pv);
});
on('POST', '/admin/publish', async (p, q, b) => {
  await sleep(700);
  const ch = b.channel === 'promos' ? 'promos' : 'directory'; const pre = ch === 'promos' ? 'P' : 'D';
  const list = S.releases.filter(r => r.channel === ch); const seq = Math.max(...list.map(r => r.seq)) + 1;
  const v = pre + String(seq).padStart(4, '0') + '-' + nowIso().replace(/[-T:]/g, '').slice(0, 12);
  list.forEach(r => r.isLive = false);
  const rel = { id: ++S.seq.release, channel: ch, version: v, seq, bytes: 214000 + seq * 13, sha256: Math.random().toString(16).slice(2).padEnd(64, '0'), notes: b.notes || null, isLive: true, rolledBackFrom: null, createdBy: S.me.user.name, createdAt: nowIso(), stats: {} };
  S.releases.unshift(rel); S.me.live[ch] = { version: v, publishedAt: rel.createdAt };
  if (ch === 'promos') S.me.unpublished.promos = false; else { S.me.unpublished.content = false; S.me.unpublished.map = false; }
  audit('publish', 'release', v, 'Publish ' + ch + ' ' + v); return ok({ release: rel });
});
on('GET', '/admin/releases', (p, q) => ok(S.releases.filter(r => !q.get('channel') || r.channel === q.get('channel'))));
on('GET', '/admin/releases/:id', p => ok(S.releases.find(r => r.id === +p.id)));
on('POST', '/admin/releases/:id/rollback', async p => {
  await sleep(500); const src = S.releases.find(r => r.id === +p.id); const list = S.releases.filter(r => r.channel === src.channel);
  const seq = Math.max(...list.map(r => r.seq)) + 1; const v = src.version[0] + String(seq).padStart(4, '0') + '-' + nowIso().replace(/[-T:]/g, '').slice(0, 12);
  list.forEach(r => r.isLive = false);
  const rel = Object.assign({}, src, { id: ++S.seq.release, version: v, seq, isLive: true, rolledBackFrom: src.id, rolledBackFromVersion: src.version, notes: 'Rollback ke ' + src.version, createdBy: S.me.user.name, createdAt: nowIso() });
  S.releases.unshift(rel); S.me.live[src.channel] = { version: v, publishedAt: rel.createdAt, rolledBackFrom: src.version };
  audit('rollback', 'release', v, 'Rollback ke ' + src.version); return ok({ release: rel });
});

// media
on('GET', '/admin/media', (p, q) => { const k = q.get('kind'), s = (q.get('q') || '').toLowerCase(); return ok(S.media.filter(m => (!k || m.kind === k) && (!s || (m.originalName || '').toLowerCase().includes(s) || m.usedBy.some(u => (u.label || '').toLowerCase().includes(s))))); });
on('POST', '/admin/media', async (p, q, b) => {
  await sleep(400); const file = b instanceof FormData ? b.get('file') : null; const kind = b instanceof FormData ? b.get('kind') || 'image' : 'image';
  if (file && kind === 'logo' && /svg/.test(file.type)) return fail(422, 'validation', 'Logo SVG ditolak — unggah PNG transparan (≥ 600 px).', { file: 'Logo harus PNG/JPG/WebP' });
  const url = file ? URL.createObjectURL(file) : '';
  const m = { id: ++S.seq.media, kind, url, url2x: null, mime: 'image/webp', bytes: file ? Math.round(file.size * .4) : 0, width: kind === 'logo' ? 320 : 1040, height: kind === 'logo' ? 120 : 760, durationSec: null, originalName: file ? file.name : 'upload', altText: null, createdAt: nowIso(), createdBy: S.me.user.name, usedBy: [], encoder: 'png-fallback', warnings: ['GD tanpa WebP — disimpan PNG (mock)'] };
  S.media.unshift(m); audit('upload', 'media', m.id, 'Unggah ' + m.originalName); return { status: 201, json: { data: m } };
});
on('DELETE', '/admin/media/:id', p => { const m = S.media.find(x => x.id === +p.id); if (m.usedBy.length) return fail(409, 'conflict', 'Media masih dipakai', null, { usedBy: m.usedBy }); S.media = S.media.filter(x => x !== m); audit('delete', 'media', m.id, 'Hapus media ' + m.originalName); return ok(true); });

// analytics & audit
on('GET', '/admin/analytics/summary', () => ok(S.analytics.summary));
on('GET', '/admin/analytics/searches', (p, q) => ok(q.get('zero') === '1' ? S.analytics.searchesZero : S.analytics.searches));
['tenants', 'routes', 'qr', 'promos', 'uptime'].forEach(k => on('GET', '/admin/analytics/' + k, () => ok(S.analytics[k])));
on('GET', '/admin/audit', (p, q) => {
  let l = S.audit; const e = q.get('entity'), u = q.get('user'), id = q.get('id');
  if (e) l = l.filter(x => x.entityType === e); if (u) l = l.filter(x => (x.user || '').toLowerCase().includes(u.toLowerCase())); if (id) l = l.filter(x => x.entityId === id);
  return paginate(l, q);
});

export async function mockFetch(method, path, body, opts = {}) {
  await load();
  await sleep(60 + Math.random() * 80);
  const [p, qstr] = path.split('?'); const q = new URLSearchParams(qstr || '');
  if (!S.loggedIn && !p.startsWith('/admin/auth/')) return fail(401, 'unauthenticated', 'Belum login');
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(p); if (!m) continue;
    const params = {}; for (const k in m.groups || {}) params[k] = decodeURIComponent(m.groups[k]);
    try { const res = await r.fn(params, q, body || {}, opts); return clone(res); }
    catch (e) { console.error('[mock]', e); return fail(500, 'server', 'Mock error: ' + e.message); }
  }
  if (path === '/health') return ok({ ok: true });
  return fail(404, 'not_found', `Mock: ${method} ${p} belum ada`);
}
