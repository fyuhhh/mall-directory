// Session state shared by shell & pages.
import { api, setCsrf } from './api.js';

export const state = { me: null, perms: new Set(), listeners: new Set() };

export async function loadMe(opts = {}) {
  const r = await api.get('/auth/me', null, Object.assign({ silent: true }, opts));
  state.me = r.data; state.perms = new Set(r.data.permissions || []);
  setCsrf(r.data.csrfToken);
  state.listeners.forEach(fn => fn(state.me));
  return state.me;
}
export const can = p => state.perms.has(p);
export const canAny = (...ps) => ps.some(p => state.perms.has(p));
export const onMe = fn => { state.listeners.add(fn); return () => state.listeners.delete(fn); };

export const ROLE_LABEL = { superadmin: 'Superadmin', map_editor: 'Editor peta', leasing: 'Leasing', marketing: 'Marketing', operations: 'Operasional', security: 'Security', viewer: 'Viewer' };
export const STATUS_LABEL = { open: 'Buka', coming_soon: 'Segera buka', temp_closed: 'Tutup sementara', closed: 'Tutup permanen' };
export const STATUS_TONE = { open: 'ok', coming_soon: 'info', temp_closed: 'warn', closed: 'danger' };
export const BUILDING_LABEL = { pentacity: 'Pentacity', ewalk: 'E-Walk', both: 'Gabungan' };
export const BANK_TYPE = { escalator: 'Eskalator', lift: 'Lift', stairs: 'Tangga', bridge: 'Jembatan', travelator: 'Travelator' };
export const BANK_ICON = { escalator: 'arrow-up-down', lift: 'move-vertical', stairs: 'list-ordered', bridge: 'waypoints', travelator: 'arrow-up-down' };
export const DIR_LABEL = { both: 'Dua arah', up: 'Naik saja', down: 'Turun saja' };
export const HOURS_MODE = { mall: 'Ikut jam mall', custom: 'Jam khusus', '24h': '24 jam', unknown: 'Belum diketahui' };
export const ISSUE_LABEL = { W_NO_LOGO: 'Tanpa logo', W_NO_HOURS: 'Tanpa jam', E_UNPLACED: 'Belum ditempatkan', W_UNIT_MISSING: 'Unit hilang', W_NO_FACING: 'Tanpa arah hadap' };
export const floorName = f => !f ? '—' : f.short + (f.building !== 'both' ? ' · ' + BUILDING_LABEL[f.building] : '');
