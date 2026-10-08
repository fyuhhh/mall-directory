// Login + forced password change (CMS_SPEC §2.1 / §7.2 #1).
import { api, setCsrf, MOCK } from './api.js';
import { showFieldErrors, h } from './ui.js';

const f = document.getElementById('f'), msg = document.getElementById('msg'), go = document.getElementById('go');
const qs = new URLSearchParams(location.search);
const next = qs.get('next') || '';
const showMsg = t => { msg.hidden = !t; msg.textContent = t || ''; };
if (MOCK) document.getElementById('foot').append(h('div', { style: { marginTop: '6px', color: 'var(--warn)', fontWeight: 700 } }, 'MODE MOCK — email & password apa saja'));

function passwordMode() {
  document.getElementById('ttl').textContent = 'Ganti password';
  document.getElementById('sub').textContent = 'Password Anda harus diganti sebelum melanjutkan (minimal 10 karakter).';
  f.innerHTML = '';
  f.append(
    h('div.field', { dataset: { field: 'current' } }, h('label', { for: 'cur' }, 'Password saat ini'), h('input.inp', { id: 'cur', name: 'current', type: 'password', autocomplete: 'current-password', required: true }), h('div.err', { hidden: true })),
    h('div.field', { dataset: { field: 'new' } }, h('label', { for: 'nw' }, 'Password baru'), h('input.inp', { id: 'nw', name: 'new', type: 'password', autocomplete: 'new-password', minlength: 10, required: true }), h('div.err', { hidden: true })),
    h('div.field', { dataset: { field: 'confirm' } }, h('label', { for: 'cf' }, 'Ulangi password baru'), h('input.inp', { id: 'cf', name: 'confirm', type: 'password', autocomplete: 'new-password', required: true }), h('div.err', { hidden: true })),
    msg, h('button.btn.primary', { type: 'submit' }, 'Simpan & lanjutkan'));
  f.onsubmit = async e => {
    e.preventDefault(); showMsg('');
    const cur = f.current.value, nw = f.new.value, cf = f.confirm.value;
    if (nw.length < 10) return showFieldErrors(f, { new: 'Minimal 10 karakter' });
    if (nw !== cf) return showFieldErrors(f, { confirm: 'Tidak sama dengan password baru' });
    try { await api.post('/auth/password', { current: cur, new: nw }, { silent: true }); location.href = 'index.html' + (next ? next : ''); }
    catch (err) { if (err.fields) showFieldErrors(f, err.fields); else showMsg(err.message); }
  };
}

if (qs.get('change') === '1') {
  api.get('/auth/me', null, { silent: true, noRedirect: true }).then(r => { setCsrf(r.data.csrfToken); passwordMode(); }).catch(() => { });
}

f.addEventListener('submit', async e => {
  if (qs.get('change') === '1') return;
  e.preventDefault(); showMsg(''); showFieldErrors(f, {});
  const email = f.email.value.trim(), password = f.password.value;
  const errs = {}; if (!email) errs.email = 'Wajib diisi'; if (!password) errs.password = 'Wajib diisi';
  if (Object.keys(errs).length) return showFieldErrors(f, errs);
  go.disabled = true; go.textContent = 'Memeriksa…';
  try {
    const r = await api.post('/auth/login', { email, password }, { silent: true, noRedirect: true });
    setCsrf(r.data.csrfToken);
    if (r.data.user && r.data.user.mustChangePassword) { passwordMode(); return; }
    location.href = 'index.html' + next;
  } catch (err) {
    if (err.code === 'rate_limited') showMsg('Terlalu banyak percobaan. Akun/IP dikunci sementara (15 menit).');
    else if (err.code === 'network') showMsg('Server tidak terjangkau. Coba lagi, atau buka mode mock: login.html?mock=1');
    else showMsg('Email atau password salah.');
  } finally { go.disabled = false; go.textContent = 'Masuk'; }
});
