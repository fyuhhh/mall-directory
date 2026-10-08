// Users & Settings — §2.1 / §7.2 #20: user CRUD (superadmin), settings (mall hours, connector costs, idle timeout,
// public base, global north, retention), manual backup.
import { h, ic, btn, badge, pageHead, field, input, select, toggle, tabs, table, toast, dialog, confirmDlg, clear, card, showFieldErrors, readForm, fmtDate, relTime, HARI, fmtBytes } from '../ui.js';
import { api } from '../api.js';
import { state, can, ROLE_LABEL } from '../state.js';
import { copyText } from '../widgets.js';

const ROLE_DESC = { superadmin: 'Semua, termasuk user, settings, token kiosk, rollback, backup', map_editor: 'Lantai, graph, eskalator/lift, kiosk, fasilitas, publish', leasing: 'Tenant, kategori, jam, logo, penempatan; publish konten',
  marketing: 'Promo, event, featured, teks; publish promo', operations: 'Status live eskalator/lift, command kiosk', security: 'Pengumuman darurat, lihat status kiosk', viewer: 'Hanya-baca + analitik' };

export default async function system(ctx) {
  const isUsers = ctx.path.startsWith('users');
  ctx.setTitle(isUsers ? 'Pengguna' : 'Pengaturan');
  ctx.root.append(pageHead(isUsers ? 'Pengguna & peran' : 'Pengaturan', isUsers ? 'Satu user = satu peran. Matriks izin di-hardcode di server (lib/Permissions.php).' : 'Nilai global untuk publish & kiosk.'));
  const bar = tabs([{ key: 'users', label: 'Pengguna', icon: 'users' }, { key: 'settings', label: 'Pengaturan', icon: 'settings' }], isUsers ? 'users' : 'settings', k => location.hash = '#/' + k);
  const body = h('div'); ctx.root.append(bar, body);
  if (isUsers) { if (!can('users.manage')) return body.append(h('div.callout.warn', ic('lock'), 'Hanya superadmin.')); await users(body); }
  else { if (!can('settings.edit')) return body.append(h('div.callout.warn', ic('lock'), 'Hanya superadmin.')); await settings(body, ctx); }
}

async function users(body) {
  let list = (await api.get('/users')).data;
  const tbl = table({ rows: list, onRow: edit, columns: [
    { key: 'name', label: 'Nama', sort: true, render: u => h('div', h('div.t-name', u.name, u.id === state.me.user.id ? h('span.muted', ' (Anda)') : null), h('div.t-sub', u.email)) },
    { key: 'role', label: 'Peran', sort: true, render: u => h('div', badge(ROLE_LABEL[u.role], u.role === 'superadmin' ? 'ink' : 'outline'), h('div.t-sub', ROLE_DESC[u.role])) },
    { key: 'status', label: 'Status', render: u => u.lockedUntil && new Date(u.lockedUntil) > new Date() ? badge('Terkunci', 'danger', 'lock') : !u.isActive ? badge('Nonaktif', '') : u.mustChangePassword ? badge('Wajib ganti password', 'warn') : badge('Aktif', 'ok') },
    { key: 'lastLoginAt', label: 'Login terakhir', sort: true, render: u => u.lastLoginAt ? relTime(u.lastLoginAt) : h('span.muted', 'belum pernah') }] });
  body.append(h('div.row', { style: { marginBottom: '12px' } }, h('span.grow'), btn('User baru', { icon: 'user-plus', kind: 'primary', onClick: () => edit(null) })), h('div.card', tbl));
  async function edit(u) {
    const isNew = !u; const v = Object.assign({ email: '', name: '', role: 'viewer', isActive: true }, u || {});
    const pw = input({ type: 'password', name: 'password', autocomplete: 'new-password' });
    const f = h('div.form.cols-2',
      field('Nama', input({ name: 'name', value: v.name }), { name: 'name', required: true }), field('Email (login)', input({ name: 'email', type: 'email', value: v.email }), { name: 'email', required: true }),
      field('Peran', select(Object.entries(ROLE_LABEL), v.role, { name: 'role' }), { name: 'role', hint: 'Lihat matriks izin §1.3' }),
      field('Status', toggle(v.isActive, 'Aktif', { name: 'isActive', disabled: u && u.id === state.me.user.id })),
      isNew ? field('Password awal', pw, { name: 'password', span: 'span-2', hint: 'Min. 10 karakter. User wajib menggantinya saat login pertama.' }) : null);
    const acts = [{ label: 'Batal', value: null }, { label: 'Simpan', kind: 'primary', value: 'save', validate: async () => {
      const o = readForm(f); if (!o.name || !o.email) { showFieldErrors(f, { name: o.name ? undefined : 'required', email: o.email ? undefined : 'required' }); return false; }
      if (isNew && (!o.password || o.password.length < 10)) { showFieldErrors(f, { password: 'Minimal 10 karakter' }); return false; }
      if (isNew) o.mustChangePassword = true;
      try { isNew ? await api.post('/users', o) : await api.put('/users/' + u.id, o, u.etag); return true; } catch (e) { if (e.fields) showFieldErrors(f, e.fields); return false; }
    } }];
    if (!isNew) acts.unshift({ label: 'Reset password', value: 'reset' });
    const res = await dialog({ title: isNew ? 'User baru' : 'Ubah user', body: f, actions: acts });
    if (res === 'reset') {
      if (!(await confirmDlg(`Buat password sementara untuk ${u.name}? Password lama tidak berlaku.`, { ok: 'Reset' }))) return;
      try { const r = await api.post(`/users/${u.id}/reset-password`); await dialog({ title: 'Password sementara', body: h('div.stack', h('p', 'Berikan ke user secara langsung (bukan lewat chat grup). Wajib diganti saat login.'), h('div.inp-group', input({ value: r.data.tempPassword, readOnly: true, class: 'inp mono' }), h('button.addon', { type: 'button', onclick: () => copyText(r.data.tempPassword) }, ic('copy')))) }); } catch (e) { }
    }
    if (res === 'save') { toast('User disimpan'); list = (await api.get('/users')).data; tbl.setRows(list); }
  }
}

async function settings(body, ctx) {
  let s = (await api.get('/settings')).data;
  if (Array.isArray(s)) s = Object.fromEntries(s.map(x => [x.key, x.value]));
  const put = async (key, value) => { await api.put('/settings/' + encodeURIComponent(key), { value }); s[key] = value; toast(`Setting ${key} disimpan`); ctx.refreshStatus(); };
  // mall hours
  const hours = JSON.parse(JSON.stringify(s['mall.hours'] || {}));
  const hg = h('div.hours-grid', { style: { gridTemplateColumns: '90px 1fr 1fr 90px' } }, h('span.kicker', 'Hari'), h('span.kicker', 'Buka'), h('span.kicker', 'Tutup'), h('span'));
  for (let d = 1; d <= 7; d++) {
    const iv = (hours[String(d)] || [])[0] || ['10:00', '22:00']; const closed = !(hours[String(d)] || []).length && hours[String(d)] !== undefined;
    const o = input({ type: 'time', value: iv[0], disabled: closed }), c = input({ type: 'time', value: iv[1], disabled: closed });
    const cb = h('input', { type: 'checkbox', checked: closed });
    const sync = () => { hours[String(d)] = cb.checked ? [] : [[o.value, c.value]]; o.disabled = c.disabled = cb.checked; };
    [o, c, cb].forEach(x => x.addEventListener('change', sync));
    hg.append(h('b', HARI[d - 1]), o, c, h('label.check', cb, 'Tutup'));
  }
  const num = (key, label, hint, step = '0.1') => { const i = input({ type: 'number', step, value: s[key] ?? '' }); i.addEventListener('change', () => put(key, i.value === '' ? null : +i.value)); return field(label, i, { hint }); };
  const txt = (key, label, hint) => { const i = input({ value: s[key] ?? '' }); i.addEventListener('change', () => put(key, i.value || null)); return field(label, i, { hint }); };
  const backupOut = h('div.small');
  body.append(h('div.grid.g2', { style: { alignItems: 'start' } },
    h('div.stack', { style: { gap: '16px' } },
      card('Jam operasional mall (WITA)', h('div.stack', hg, h('div.row', btn('Simpan jam mall', { icon: 'save', kind: 'primary', size: 'sm', onClick: () => put('mall.hours', hours) }), h('span.small.muted', 'Dipakai tenant "ikut jam mall" & default jadwal eskalator.')))),
      card('Kiosk & publik', h('div.form', num('kiosk.idleTimeoutSec', 'Idle timeout kiosk (detik)', 'Kembali ke layar atraksi setelah tidak disentuh.', '1'),
        txt('public.baseUrl', 'Public base URL', 'https://directory.<domain>/bsb-directory — dipakai QR & launch URL.'),
        num('map.northDeg', 'Arah utara global (°)', 'Default bila lantai tidak punya north_deg. Kosong = belum diketahui.', '1')))),
    h('div.stack', { style: { gap: '16px' } },
      card('Biaya konektor per level', h('div.form.cols-2', num('cost.escalatorPerLevel', 'Eskalator', 'Default 19.2'), num('cost.liftPerLevel', 'Lift', 'Default 38.4 (termasuk tunggu)'),
        num('cost.stairsPerLevel', 'Tangga', 'Default 28.8'), num('cost.travelatorPerLevel', 'Travelator', 'Default 9.6'), num('cost.bridge', 'Jembatan', '0 + panjang polyline'))),
      card('Retensi & sistem', h('div.form.cols-2', num('retention.telemetryDays', 'Telemetri mentah (hari)', 'Default 180', '1'), num('retention.auditYears', 'Audit log (tahun)', 'Default 2', '1'),
        txt('media.cwebpPath', 'Path cwebp', 'Fallback encoder WebP bila GD tanpa WebP.'), txt('health.allowCidr', 'Health check CIDR', 'IP yang boleh membuka /api/health.'))),
      can('backup.run') ? card('Backup', h('div.stack', h('p.small.muted', 'mysqldump + media + data/releases (jadwal otomatis 02:30). Tombol ini menjalankan skrip yang sama sekarang.'),
        h('div.row', btn('Jalankan backup sekarang', { icon: 'hard-drive-download', onClick: async e => {
          const b = e.currentTarget; b.disabled = true; clear(backupOut).append(h('span.spinner'), ' Menjalankan backup…');
          try { const r = await api.post('/backup/run'); clear(backupOut).append(h('div.callout.ok', ic('circle-check'), h('div', 'Backup selesai: ', h('span.mono', r.data.file || ''), r.data.bytes ? ` (${fmtBytes(r.data.bytes)})` : ''))); }
          catch (er) { clear(backupOut).append(h('div.callout.danger', ic('circle-alert'), 'Backup gagal: ' + er.message)); }
          b.disabled = false;
        } })), backupOut)) : null)));
}
