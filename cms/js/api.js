// API client — CMS_SPEC §4. Session cookie + X-CSRF-Token on every non-GET, If-Match for PUT, error toasts, ?mock=1 fixtures.
import { toast } from './ui.js';

const qs = new URLSearchParams(location.search);
try {
  if (qs.has('mock')) sessionStorage.setItem('bsb-mock', qs.get('mock') === '0' ? '0' : '1');
} catch (e) { /* storage blocked */ }
export const MOCK = (() => { try { return sessionStorage.getItem('bsb-mock') === '1'; } catch (e) { return qs.get('mock') === '1'; } })();
export const API_BASE = new URL('../api', location.href).pathname.replace(/\/$/, ''); // e.g. /bsb-directory/api

let csrf = null;
let useR = false; // fallback ?r= routing when mod_rewrite is off (§4.1)
try { useR = sessionStorage.getItem('bsb-api-r') === '1'; } catch (e) { }
export const setCsrf = t => { csrf = t; };

export class ApiError extends Error {
  constructor(status, err) {
    super((err && err.message) || 'Kesalahan server');
    this.status = status; this.code = (err && err.code) || 'server';
    this.fields = (err && err.fields) || null; this.details = (err && err.details) || null;
  }
}

/** Build a URL for direct links (CSV export, release download). */
export function apiUrl(path) {
  if (MOCK) return 'javascript:void(0)';
  const [p, q] = path.split('?');
  return useR ? `${API_BASE}/index.php?r=${encodeURIComponent(p)}${q ? '&' + q : ''}` : API_BASE + path;
}

let mockMod = null;
async function mockCall(method, path, body, opts) {
  if (!mockMod) mockMod = await import('./mock.js');
  return mockMod.mockFetch(method, path, body, opts);
}

const MSG = {
  unauthenticated: 'Sesi berakhir — silakan login lagi.',
  forbidden: 'Anda tidak punya izin untuk tindakan ini.',
  not_found: 'Data tidak ditemukan.',
  conflict: 'Data sudah diubah orang lain.',
  validation: 'Periksa kembali isian yang ditandai.',
  rate_limited: 'Terlalu banyak permintaan — coba lagi sebentar.',
  server: 'Terjadi kesalahan server.',
};

/**
 * request(method, '/admin/tenants', body?, {etag, silent, query}) → parsed JSON body ({data, …}).
 * Throws ApiError. Shows a toast unless opts.silent (validation/conflict are left to callers by default).
 */
export async function request(method, path, body, opts = {}) {
  if (opts.query) {
    const q = new URLSearchParams();
    for (const k in opts.query) if (opts.query[k] != null && opts.query[k] !== '') q.set(k, opts.query[k]);
    const s = q.toString(); if (s) path += (path.includes('?') ? '&' : '?') + s;
  }
  let status, json;
  try {
    if (MOCK) {
      ({ status, json } = await mockCall(method, path, body, opts));
    } else {
      const headers = { Accept: 'application/json' };
      let payload;
      if (body instanceof FormData) payload = body;
      else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
      if (method !== 'GET') headers['X-CSRF-Token'] = csrf || '';
      if (opts.etag) headers['If-Match'] = opts.etag;
      let res = await fetch(apiUrl(path), { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
      let ct = res.headers.get('content-type') || '';
      if (res.status === 404 && !ct.includes('json') && !useR) {
        // mod_rewrite not active → retry with ?r= once and remember
        useR = true; try { sessionStorage.setItem('bsb-api-r', '1'); } catch (e) { }
        res = await fetch(apiUrl(path), { method, headers, body: payload, credentials: 'same-origin', cache: 'no-store' });
        ct = res.headers.get('content-type') || '';
      }
      status = res.status;
      json = status === 204 ? {} : ct.includes('json') ? await res.json() : { error: { code: 'server', message: `HTTP ${status}` } };
    }
  } catch (e) {
    if (!opts.silent) toast('Server tidak terjangkau. Periksa koneksi LAN / Apache.', 'err');
    throw new ApiError(0, { code: 'network', message: e.message });
  }
  if (status >= 200 && status < 300) return json || {};
  const err = new ApiError(status, json && json.error);
  if (status === 401 && !opts.noRedirect) {
    const here = location.pathname.endsWith('login.html');
    if (!here) { location.href = 'login.html?next=' + encodeURIComponent(location.hash || ''); }
    throw err;
  }
  const quietCodes = opts.quiet || ['validation', 'conflict'];
  if (!opts.silent && !quietCodes.includes(err.code)) toast(err.message && err.code !== 'server' ? err.message : (MSG[err.code] || err.message), 'err');
  else if (!opts.silent && err.code === 'validation') toast(MSG.validation, 'warn');
  throw err;
}

export const api = {
  get: (p, query, o = {}) => request('GET', '/admin' + p, undefined, Object.assign({ query }, o)),
  post: (p, body, o) => request('POST', '/admin' + p, body === undefined ? {} : body, o),
  put: (p, body, etag, o = {}) => request('PUT', '/admin' + p, body, Object.assign({ etag: etag || '*' }, o)), // no etag known → explicit overwrite (If-Match: *)
  del: (p, o) => request('DELETE', '/admin' + p, undefined, o),
  upload: (p, file, fields = {}, o) => { const fd = new FormData(); fd.append('file', file); for (const k in fields) fd.append(k, fields[k]); return request('POST', '/admin' + p, fd, o); },
  pub: (p, o) => request('GET', p, undefined, o),
};

// ---------- small cache for lookups (floors, categories, kiosks, schedules, banks…) ----------
const cache = new Map();
export async function cached(key, loader, ttlMs = 60000) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttlMs) return c.p;
  const p = loader().then(r => r, e => { cache.delete(key); throw e; });
  cache.set(key, { t: Date.now(), p });
  return p;
}
export const invalidate = (...keys) => keys.length ? keys.forEach(k => cache.delete(k)) : cache.clear();

export const lookups = {
  floors: () => cached('floors', () => api.get('/floors').then(r => r.data.slice().sort((a, b) => a.level - b.level || (a.sortOrder || 0) - (b.sortOrder || 0)))),
  categories: () => cached('categories', () => api.get('/categories').then(r => r.data.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)))),
  kiosks: () => cached('kiosks', () => api.get('/kiosks').then(r => r.data), 15000),
  schedules: () => cached('schedules', () => api.get('/schedules').then(r => r.data)),
  amenityTypes: () => cached('amenity-types', () => api.get('/amenity-types').then(r => r.data)),
  connectors: () => cached('connectors', () => api.get('/connectors').then(r => r.data), 5000),
  tenantsLite: () => cached('tenants-lite', () => api.get('/tenants', { per: 500 }).then(r => r.data), 30000),
};
