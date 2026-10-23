// Peta 3D (docs/3D.md) — lantai yang digambar ulang di Illustrator: sinkron gambar ↔ CMS (tenant & fasilitas dari gambar,
// denah tampak atas), sambung otomatis pin ke jalur, dan editor atap 3D (nama tampil, logo, ukuran/posisi) di satu halaman.
// Nama, logo, aktif/nonaktif & detail tenant tetap diatur di halaman Tenant; jalur di Editor graph (tampak atas).
import { h, ic, btn, badge, pageHead, card, toast, clear, confirmDlg, select } from '../ui.js';
import { api, invalidate, MOCK } from '../api.js';
import { can, floorName } from '../state.js';

export default async function map3d(ctx) {
  ctx.setTitle('Peta 3D');
  ctx.root.append(pageHead('Peta 3D', 'Lantai yang sudah digambar ulang. Tenant (nama, logo, aktif/nonaktif) diatur di halaman Tenant, jalur di Editor graph — semuanya tampil di peta 3D kiosk setelah Publish. Di sini: sinkron gambar ↔ CMS dan tampilan atap.'));
  if (MOCK) { ctx.root.append(h('div.callout.muted', ic('info'), h('div', 'Peta 3D butuh server PHP CMS (tidak tersedia di mode mock).'))); return; }
  let floors = (await api.get('/3d/floors')).data;
  if (!floors.length) {
    ctx.root.append(h('div.callout.muted', ic('info'), h('div', 'Belum ada lantai 3D. Gambar lantai di Illustrator (layer base, tenant, Fasilitas), konversi, lalu daftarkan — lihat docs/3D.md.')));
    return;
  }
  let cur = floors.find(f => f.id === ctx.query.get('floor')) || floors[0];
  const side = h('div.stack', { style: { gap: '16px' } });
  const frameHost = h('div.card', { style: { padding: 0, overflow: 'hidden', height: 'calc(100vh - 190px)', minHeight: '560px' } });
  ctx.root.append(h('div.split.l', { style: { gridTemplateColumns: '380px minmax(0, 1fr)' } }, side, frameHost));

  async function reload() { floors = (await api.get('/3d/floors')).data; cur = floors.find(f => f.id === cur.id) || floors[0]; render(); }
  function pick(f) { cur = f; history.replaceState(null, '', '#/map3d?floor=' + f.id); render(); loadFrame(); }
  function loadFrame() {
    clear(frameHost).append(h('iframe', { src: '../editor3d.html?cms=1&floor=' + encodeURIComponent(cur.id), title: 'Editor atap 3D',
      style: { width: '100%', height: '100%', border: '0', display: 'block' } }));
  }

  function render() {
    clear(side);
    if (floors.length > 1) side.append(h('div.row.wrap', floors.map(f => btn(f.short + ' · ' + f.id, { size: 'sm', kind: f.id === cur.id ? 'primary' : '', onClick: () => pick(f) }))));
    const plan = cur.frame === 'plan';
    const rows = h('dl.kv', { style: { gridTemplateColumns: '130px minmax(0,1fr)' } },
      h('dt', 'Koordinat CMS'), h('dd', plan ? badge('Mengikuti gambar', 'ok', 'circle-check') : badge('Masih gambar lama', 'warn', 'triangle-alert')),
      h('dt', 'Denah tampak atas'), h('dd', !plan ? '—' : cur.planCurrent ? badge('Terbaru', 'ok', 'circle-check') : badge('Gambar berubah', 'warn', 'refresh-cw')),
      h('dt', 'Unit bertenant'), h('dd', `${cur.linked} tenant tertaut · ${cur.named} unit bernama · ${cur.units} unit`),
      h('dt', 'Fasilitas gambar'), h('dd', String(cur.facilities)));
    const actions = h('div.row.wrap');
    if (plan && !cur.planCurrent) actions.append(btn('Perbarui denah dari gambar', { icon: 'refresh-cw', kind: 'primary', size: 'sm', disabled: !can('floors.edit'), onClick: refreshPlan }));
    actions.append(h('a.btn.sm', { href: '#/graph?floor=' + cur.id }, ic('waypoints'), 'Editor graph'), h('a.btn.sm', { href: '#/floors?id=' + cur.id }, ic('layers'), 'Lantai'));
    side.append(card(h('div.row', h('h3', floorName(cur)), h('span.mono.small.muted', cur.id)), h('div.stack', rows,
      plan ? null : h('div.callout.warn', ic('triangle-alert'), h('div', 'Jalur, pin & fasilitas lantai ini masih memakai koordinat gambar lama. Pindahkan sekali dengan ', h('code', `php tools/3d/rebase_floor.php --floor ${cur.id} --apply`), '.')),
      actions)));

    // named units in the drawing that the CMS has no tenant for: link a similarly named CMS tenant, or create one
    if (plan && cur.unlinked.length) {
      const rows = cur.unlinked.map(u => {
        if (u.sameAs) return { u, el: h('div.row', { style: { alignItems: 'flex-start' } }, ic('link'), h('div.grow', h('b', u.name), h('div.small.muted', `Bangunan kedua ${u.sameAs.name} — di kiosk tampil dan bisa diketuk sebagai ${u.sameAs.name}.`))) };
        const opts = [...(u.suggest ? [['link', `Tautkan ke tenant CMS "${u.suggest.name}"`]] : []), ['create', 'Buat tenant CMS baru'], ['skip', 'Biarkan (tenant peta)']];
        const sel = select(opts, u.suggest ? 'link' : 'create', { sm: true, disabled: !(can('tenants.edit') && can('tenants.place')) });
        return { u, sel, el: h('div.stack', { style: { gap: '4px' } }, h('div', h('b', u.name), h('span.small.muted.mono', ' ' + u.id)), sel) };
      });
      const act = rows.filter(r => r.sel);
      side.append(card('Unit bernama tanpa tenant CMS', h('div.stack',
        h('p.small.muted', { style: { margin: 0 } }, 'Ada di gambar tapi belum ditautkan ke tenant CMS. Kalau tenantnya sudah ada di CMS (nama di gambar sedikit beda), tautkan; kalau belum, buat baru supaya nama, logo, kategori & status bisa diatur.'),
        h('div.stack', { style: { gap: '12px' } }, rows.map(r => r.el)),
        act.length ? h('div.row', btn('Terapkan', { icon: 'check', kind: 'primary', size: 'sm', disabled: !(can('tenants.edit') && can('tenants.place')), onClick: async () => {
          const links = {}, create = [];
          act.forEach(r => { if (r.sel.value === 'link') links[r.u.id] = r.u.suggest.id; else if (r.sel.value === 'create') create.push(r.u.id); });
          const linked = Object.keys(links).length ? (await api.post(`/3d/floors/${cur.id}/link-units`, { links })).data : [];
          const made = create.length ? (await api.post(`/3d/floors/${cur.id}/import-units`, { units: create })).data : [];
          invalidate('tenants-lite'); ctx.refreshStatus();
          if (linked.length || made.length) toast(`${linked.length} unit ditautkan, ${made.length} tenant dibuat (kategori ditebak dari nama — periksa di halaman Tenant). Publish untuk mengirim ke kiosk.`);
          warnStraight([...linked.filter(x => !x.viaFloor).map(x => x.id), ...made.filter(x => !x.viaFloor).map(x => x.name)]);
          await reload();
        } })) : null), { cls: '' }));
    }
    // drawn facilities without a CMS facility
    if (plan && cur.unlinkedFacilities.length) {
      const poi = cur.unlinkedFacilities.filter(f => !f.connector), conn = cur.unlinkedFacilities.filter(f => f.connector);
      side.append(card('Fasilitas gambar tanpa data CMS', h('div.stack',
        poi.length ? h('div.stack', { style: { gap: '6px' } }, poi.map(f => h('div.row', ic('map-pin'), h('span.grow', `${f.name || f.type} → ${f.amenityType}`))),
          h('div.row', btn('Buat fasilitas CMS', { icon: 'plus', kind: 'primary', size: 'sm', disabled: !can('amenities.edit'), onClick: async () => {
            const r = (await api.post(`/3d/floors/${cur.id}/import-facilities`, { facilities: poi.map(f => f.id) })).data;
            ctx.refreshStatus(); toast(`${r.length} fasilitas dibuat & disambung ke jalur`); await reload();
          } }))) : null,
        conn.length ? h('div.callout.muted', ic('arrow-up-down'), h('div', `${conn.map(f => f.name || f.type).join(', ')}: lift/eskalator/tangga adalah konektor — tandai stopnya di `, h('a', { href: '#/connectors' }, 'Eskalator & lift'), ' (node di depan ikonnya).')) : null)));
    }
    // reconnect pins to the current paths
    side.append(card('Sambung pin ke jalur', h('div.stack',
      h('p.small.muted', { style: { margin: 0 } }, 'Setelah jalur diubah di Editor graph: pin tenant pindah ke muka tokonya (sisi yang menghadap koridor di gambar) lalu disambung otomatis ke jalur terdekat lewat lantai yang bisa dilalui — tidak menembus toko.'),
      h('div.row.wrap',
        btn('Yang belum tersambung', { icon: 'link', size: 'sm', disabled: !can('tenants.place'), onClick: () => reconnect(false) }),
        btn('Semua tenant & fasilitas', { icon: 'route', size: 'sm', disabled: !(can('graph.edit') || can('tenants.place')), onClick: () => reconnect(true) })))));
    side.append(h('div.callout.muted', ic('info'), h('div', 'Editor di kanan mengatur tampilan atap: nama tampil khusus, logo khusus, timbul/papan, ukuran & posisi. Tersimpan langsung (kiosk memuat ulang ≤ 60 detik). Tanpa isian, atap memakai nama & logo tenant dari CMS; logo berupa foto toko otomatis diganti nama.')));
  }

  function warnStraight(names) {
    if (names.length) toast(`Pintu ${names.join(', ')} tidak menghadap koridor di gambar — disambung garis lurus. Periksa gambar atau atur jalurnya di Editor graph.`, 'warn', 12000);
  }
  async function refreshPlan() {
    const r = (await api.post(`/3d/floors/${cur.id}/plan`)).data;
    invalidate('floors'); ctx.refreshStatus();
    const moved = Object.entries(r.remap || {});
    toast((r.changed ? 'Denah tampak atas diperbarui dari gambar — Publish untuk mengirim ke kiosk' : 'Denah sudah sama dengan gambar') +
      (moved.length ? ` · ${moved.length} unit berganti id, tautan tenant ikut pindah (${moved.map(([a, b]) => a + ' → ' + b).join(', ')})` : ''), 'ok', moved.length ? 9000 : undefined);
    await reload();
  }
  async function reconnect(everything) {
    let tenants = [], amenities = [];
    if (everything) {
      if (!(await confirmDlg('Semua pin tenant & fasilitas di lantai ini dipindah ke muka toko/ruangnya dan disambung ulang ke jalur. Lanjutkan?', { ok: 'Sambung ulang' }))) return;
      const g = (await api.get('/graph', { floor: cur.id })).data;
      tenants = g.attachments.tenants.map(t => t.id); amenities = g.attachments.amenities.map(a => a.id);
    }
    const r = (await api.post('/graph/reconnect', { floor: cur.id, tenants, amenities, all: !everything })).data;
    invalidate('tenants-lite'); ctx.refreshStatus();
    toast(r.connected.length ? `${r.connected.length} pin disambung ke jalur — Publish untuk mengirim ke kiosk` : 'Semua pin sudah tersambung');
    warnStraight(r.connected.filter(x => !x.viaFloor).map(x => x.id));
  }

  render(); loadFrame();
}
