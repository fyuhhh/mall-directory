# CMS_SPEC — BSB Directory CMS (e-Walk & Pentacity, Balikpapan Superblock)

Versi spec: 1.0 · 4 Okt 2026 · Status: **siap dibangun (v1)**
Pemilik produk: PT WBL / PAM Group · Lokasi kode: `htdocs/bsb-directory/`
Bahasa dokumen: Indonesia; identifier teknis dalam bahasa Inggris.

> Dokumen ini adalah kontrak untuk agen pembangun. Bagian §3 (DDL), §4 (API JSON) dan §5 (format snapshot) adalah
> **kontrak bersama** antar paket kerja. Jangan diubah sepihak; perubahan harus ditulis balik ke dokumen ini.

---

## 0. Ringkasan keputusan

| # | Keputusan | Alasan singkat |
|---|---|---|
| D1 | **PHP 8 native + PDO + router mini buatan sendiri** (±150 baris, `lib/Router.php`). Tanpa framework/Composer di v1. | Sama dengan proyek lain user (XAMPP). Endpoint ±60, cukup router + middleware sederhana. Composer tidak tersedia di PC kiosk/server Windows tanpa setup ekstra. |
| D2 | DB **MariaDB 10.4** (XAMPP saat ini) / MySQL 8 kompatibel. `utf8mb4_unicode_ci`, InnoDB. Kolom `JSON` = alias LONGTEXT + `json_valid` di MariaDB. Jangan pakai fitur khusus MySQL 8 (functional index, `CHECK` kompleks, `JSON_TABLE`). | XAMPP mac dev: PHP 8.0.28 + MariaDB 10.4.28. |
| D3 | MySQL = sumber kebenaran. **Publish** menulis snapshot statis. Ada **3 kanal** terpisah: `directory.json` (konten + peta + graph, lewat validasi), `promos.json` (promo, event, featured — kanal marketing), `status.json` (overlay operasional live: eskalator/lift rusak, pengumuman darurat — tanpa antre publish). | Eskalator rusak tidak boleh menunggu siklus publish konten; marketing tidak boleh terblokir oleh graph yang sedang diedit. |
| D4 | Model penghubung antar-lantai: **bank → stop → leg**. Tiap leg (satu ruas antara dua stop) punya `is_enabled`, `direction` (both/up/down), `schedule_id` (jam operasi), dan bisa ditutup sementara lewat tabel `closures`. Lift = bank dengan stop yang `is_served`; leg dibuat antar stop yang dilayani. | Temuan lapangan: Eskalator A Pentacity hanya GF↔UG; eskalator bisa satu arah; Lift E-Walk diduga tidak sampai 2F. |
| D5 | Export graph tetap `[from, to, cost, type]` (kompatibel `js/route.js` lama) + elemen ke-5 opsional `ruleKey` untuk jam operasi/penutupan. Leg nonaktif **tidak diekspor**; eskalator satu arah diekspor sebagai **satu edge berarah** saja. | Kiosk lama tetap benar untuk kasus statis; kiosk baru menghormati jadwal & penutupan. |
| D6 | **Server pusat di LAN mall** (XAMPP Windows/Linux) melayani kiosk lewat LAN; **domain asli + sertifikat Let's Encrypt (DNS-01)** + **DNS internal (MikroTik static DNS)** agar kiosk di LAN memakai HTTPS (syarat Service Worker). Publik (HP pengunjung) dijangkau lewat **Cloudflare Tunnel** ke server yang sama dengan hostname yang sama. | Internet putus ≠ kiosk mati. HP butuh HTTPS untuk kompas. Satu URL untuk semua. |
| D7 | Kiosk offline-first: **Service Worker** (app shell + snapshot terakhir + SVG lantai + logo). Fallback tanpa SW: snapshot di `localStorage`, tidak pernah reload kecuali server terbukti terjangkau. | Konsern user: "kalau internet putus kiosk mati". |
| D8 | Admin UI = **halaman statis + vanilla JS** di `cms/` yang hanya bicara ke `api/admin/*` (JSON). Tidak ada PHP di `cms/`. | Memisahkan paket kerja UI vs backend tanpa konflik file; auth sepenuhnya di API. |
| D9 | Dua profil klien kiosk: `windows_pc` (Edge --kiosk, mode `full`) dan `smart_tv` (browser TV / Android TV + Fully Kiosk, mode `lite`). `perf_mode` = `auto|full|lite` dikelola di CMS. | Permintaan tambahan user (lihat §6.8). |
| D10 | Zona waktu tunggal **Asia/Makassar (WITA, UTC+8)**. Semua jam di DB = waktu lokal WITA (`DATETIME`), snapshot menyertakan `meta.tzOffsetMin = 480`. | Jadwal promo/eskalator dihitung di kiosk; jam PC harus sinkron NTP. |

---

## 1. Stakeholder, peran, dan matriks izin

### 1.1 Peran (satu user = satu peran)

| Role key | Siapa | Tanggung jawab |
|---|---|---|
| `superadmin` | IT PT WBL | Semua. User & role, settings, provisioning kiosk, rollback, backup. |
| `map_editor` | IT / tim GIS / drafter Engineering yang ditunjuk | Lantai (SVG), graph, bank eskalator/lift (struktur, arah, jadwal), posisi kiosk, fasilitas (POI), publish directory. |
| `leasing` | Tenant Relations / Leasing | Brand & outlet tenant, kategori, jam buka, logo, status (open/coming soon/tutup), penempatan tenant di peta (klik), publish directory **jika diff hanya berisi seksi konten**. |
| `marketing` | Marketing / Promo | Promo & iklan, event, featured tenant, string i18n atraksi; publish kanal promos. Lihat analitik. |
| `operations` | Engineering / Building Management | Status live eskalator/lift (tutup/buka, arah sementara), command kiosk (reload/identify), lihat status kiosk. Halaman Ops **wajib mobile-friendly**. |
| `security` | Security / Safety | Pengumuman darurat (notice di `status.json`), lihat status kiosk. |
| `viewer` | Manajemen / Customer Service | Read-only + analitik. |

### 1.2 Permission keys

`tenants.edit`, `tenants.place`, `categories.edit`, `floors.edit`, `graph.edit`, `connectors.edit`, `amenities.edit`, `kiosks.edit`, `kiosks.provision`, `kiosks.command`, `promos.edit`, `events.edit`, `featured.edit`, `i18n.edit`, `media.upload`, `media.delete`, `status.closures`, `status.notice`, `publish.content`, `publish.map`, `publish.promos`, `releases.rollback`, `analytics.view`, `audit.view`, `users.manage`, `settings.edit`, `backup.run`.

### 1.3 Matriks izin

| Permission | superadmin | map_editor | leasing | marketing | operations | security | viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| tenants.edit | ✓ | ✓ | ✓ | – | – | – | – |
| tenants.place (klik peta / unit shape) | ✓ | ✓ | ✓ | – | – | – | – |
| categories.edit | ✓ | – | ✓ | – | – | – | – |
| floors.edit | ✓ | ✓ | – | – | – | – | – |
| graph.edit | ✓ | ✓ | – | – | – | – | – |
| connectors.edit (struktur, arah permanen, jadwal) | ✓ | ✓ | – | – | – | – | – |
| amenities.edit | ✓ | ✓ | – | – | – | – | – |
| kiosks.edit (posisi, facing, bahasa, profil) | ✓ | ✓ | – | – | – | – | – |
| kiosks.provision (token) | ✓ | – | – | – | – | – | – |
| kiosks.command (reload, identify, clear cache) | ✓ | ✓ | – | – | ✓ | – | – |
| promos.edit / events.edit / featured.edit | ✓ | – | – | ✓ | – | – | – |
| i18n.edit | ✓ | – | – | ✓ | – | – | – |
| media.upload | ✓ | ✓ | ✓ | ✓ | – | – | – |
| media.delete (yang tidak terpakai) | ✓ | – | – | – | – | – | – |
| status.closures (tutup/buka leg, live) | ✓ | ✓ | – | – | ✓ | – | – |
| status.notice (pengumuman darurat) | ✓ | – | – | – | ✓ | ✓ | – |
| publish.content | ✓ | ✓ | ✓ | – | – | – | – |
| publish.map | ✓ | ✓ | – | – | – | – | – |
| publish.promos | ✓ | – | – | ✓ | – | – | – |
| releases.rollback | ✓ | ✓ | – | – | – | – | – |
| analytics.view | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ |
| audit.view | ✓ | – | – | – | – | – | – |
| users.manage / settings.edit / backup.run | ✓ | – | – | – | – | – | – |

**Aturan publish per seksi**: diff directory dibagi seksi `content` (tenants, brands, categories, hours, i18n) dan `map` (floors, graph, connectors, kiosks, amenities). User boleh publish hanya jika ia punya `publish.<seksi>` untuk **setiap seksi yang berubah**. Contoh: leasing tidak bisa publish bila ada perubahan graph yang belum dipublish oleh map_editor — UI menampilkan "Ada perubahan peta oleh X yang belum ditinjau".

Matriks ini di-hardcode di `lib/Permissions.php` (konstanta array role → permissions), bukan di DB.

---

## 2. Modul & prioritas v1 (MoSCoW)

Legenda: **M** = Must v1, **S** = Should v1 (dikerjakan bila waktu cukup, sudah ada di DDL), **C** = Could (v2 kandidat), **W** = Won't v1.

| # | Modul | Prioritas |
|---|---|---|
| 2.1 | Auth, user, role | M |
| 2.2 | Tenant (brand + outlet) | M |
| 2.3 | Kategori | M |
| 2.4 | Lantai (SVG, focus, north) | M (upload/replace SVG: S) |
| 2.5 | Graph editor | M |
| 2.6 | Bank eskalator/lift/tangga/jembatan (leg) | M |
| 2.7 | Status live / closures + notice | M (notice: S) |
| 2.8 | Kiosk (posisi, profil, heartbeat, command) | M |
| 2.9 | Fasilitas/POI (toilet, musholla, …) | M |
| 2.10 | Promo/iklan | M (video & fullscreen takeover: S; panel-banner & phone-arrival: C) |
| 2.11 | Event | S |
| 2.12 | Featured tenant | M |
| 2.13 | i18n strings | S |
| 2.14 | Publish workflow (validate, diff, history, rollback) | M |
| 2.15 | Validasi (port verify_routes.py) | M |
| 2.16 | Analitik | M (ingest + 6 laporan dasar); dashboard grafik lanjutan: S |
| 2.17 | Audit log | M |
| 2.18 | Media library | M |
| 2.19 | Backup | M (skrip + jadwal) |
| 2.20 | Import CSV tenant, export CSV | S (export M) |
| 2.21 | Re-registrasi SVG (affine 3 titik saat denah berubah) | C |
| 2.22 | Multi-kategori per tenant, menu/F&B detail, deals per tenant | C |
| 2.23 | Portal self-service tenant, 2FA TOTP, approval berjenjang | W (v2) |

### 2.1 Auth, user, role (M)
- Field user: email (login), nama, role, aktif, password hash, `failed_count`, `locked_until`, `last_login_at`, `must_change_password`.
- Login email+password; lockout 5 gagal / 15 menit per akun **dan** 20 gagal / 15 menit per IP. Password min 10 karakter, tolak 20 password umum (list hardcode).
- Superadmin pertama dibuat oleh `php tools/create_admin.php email nama` (CLI).
- Session timeout idle 30 menit, absolut 12 jam. Logout menghancurkan session.

### 2.2 Tenant (M)
Model dua tingkat: **brand** (identitas) dan **tenant = outlet** (lokasi fisik). UI menggabungkan keduanya dalam satu form; mayoritas brand punya satu outlet.

Brand (`brands`): `name`, `slug`, `category_id`, `logo_media_id`, `desc_en`, `desc_id`, `keywords_en`, `keywords_id` (teks dipisah koma), `url` (https saja), `instagram`, `tiktok`, `facebook`, `whatsapp`.

Outlet (`tenants`): `id` (slug publik stabil, mis. `uniqlo-gf` — **tidak boleh berubah** setelah publish karena dipakai QR `t=` dan featured), `brand_id`, `name_override` (opsional; default otomatis), `floor_id`, `building` (otomatis dari titik bila floor `both`, bisa di-override), `unit_no` (mis. `UG-12A`), `x`,`y` (koordinat SVG lantai), `node_id` (node graph pintu masuk), `unit_shape_id` (id elemen SVG unit), `phone`, `url_override`, `logo_override_media_id`, `status` (`open` | `coming_soon` | `temp_closed` | `closed`), `status_note_en/id`, `status_until` (tanggal), `opening_date`, `hours_mode` (`mall` | `custom` | `24h` | `unknown`), jam per hari (`tenant_hours`), `hours_note_en/id`, `is_published`, `src_id` (Mapplic, read-only).

Perilaku:
- **Nama tampilan otomatis**: jika brand punya >1 outlet terpublish → `"<Brand> · <Gedung>"`; jika gedung sama → `"<Brand> · <Gedung> <Lantai>"` (sama dengan aturan importer: "Matahari · E-Walk 2F"). `name_override` menang.
- **Keywords** saat publish = keywords_id ∪ keywords_en ∪ sinonim kategori (tabel kecil di `lib/Keywords.php`, port dari `build_data.py`) ∪ `[floor.short lowercase, building label lowercase]`. Huruf kecil, unik.
- **Logo**: upload PNG/JPG/WebP/SVG(→ditolak untuk logo; minta PNG) → re-encode WebP, sisi terpanjang **320 px**, transparan dipertahankan, kualitas 85; simpan juga 640 px (`@2x`). Tampilkan preview di kartu kiosk (latar putih & latar krem).
- **Penempatan di peta**: lihat §7.3 — klik lantai → pin; sistem menyarankan node terdekat di koridor (proyeksi ke edge terdekat, buat node spur bila jarak > 3 unit) dan menampilkan garis putus-putus pin→node.
- **Unit shape**: mode "Pilih unit" → klik bentuk di SVG → `unit_shape_id` diisi id elemen; kiosk menyorot `#unit-<tenantId>`.
- Status: `closed` → tidak diekspor; `temp_closed`/`coming_soon` diekspor dengan badge; `coming_soon` tetap bisa dirutekan (ke hoarding).
- Duplikasi: tombol "Tambah outlet" (salin brand, lantai kosong).
- Daftar tenant: filter lantai/gedung/kategori/status/"tanpa logo"/"tanpa jam"/"belum ditempatkan"/"unit belum ditautkan"; bulk set kategori & status; export CSV (M), import CSV (S).

### 2.3 Kategori (M)
`id` (slug), `name_en`, `name_id`, `icon` (hanya nama ikon yang ada di `js/icons.js` — picker membaca `BSB.ICONS`), `color` (#RRGGBB, dipakai kiosk sebagai pengganti `B.CAT_COLORS`), `sort_order`, `is_active`. Hapus hanya jika tidak dipakai. Seed: 8 kategori sekarang + warna dari `B.CAT_COLORS` di `js/kiosk.js`.

### 2.4 Lantai (M; upload/replace SVG = S)
`id` (`lg-penta`, `gf`, …), `level` (-1 LG, 0 GF, 1 UG, 2 1F, 3 2F), `short`, `name_en`, `name_id`, `building` (`pentacity|ewalk|both`), SVG sumber (media), `viewBox`, `unit_scale` (bisa diedit; ±30 % perkiraan), `north_deg` (per lantai — denah isometrik bisa berbeda rotasi; null = pakai `settings.map.northDeg`), focus box per gedung (drag rectangle di peta), `sort_order`.
- **Replace SVG**: upload → sanitasi (§8.2) → laporan pratinjau: viewBox lama vs baru, jumlah elemen dihapus, jumlah shape, **daftar `unit_shape_id` yang tidak ditemukan lagi**, overlay node graph di atas SVG baru (agar terlihat bila bergeser). Konfirmasi baru disimpan. Jika viewBox berbeda → peringatan keras ("koordinat tenant/graph tidak otomatis dipindah"; re-registrasi = C).
- Elemen tanpa `id` bertipe path/rect/polygon/ellipse mendapat id `shp-<n>` saat sanitasi supaya bisa ditautkan ke tenant.

### 2.5 Graph editor (M)
Node: `id` (INT, diekspor `n<id>`), `floor_id`, `x`, `y`, `label` opsional. Edge (dalam satu lantai): `type` = `walk`, `is_enabled`, `cost_override` (null = otomatis panjang × unit_scale), `schedule_id` (koridor yang tutup malam, mis. akses hotel), `label`. Detail UI di §7.4. Penghubung antar-lantai **tidak** dibuat sebagai edge biasa, melainkan lewat modul 2.6.

### 2.6 Bank eskalator / lift / tangga / jembatan (M)
- **Bank** (`connector_banks`): `id` (mis. `esc-a-penta`), `type` (`escalator|lift|stairs|bridge|travelator`), `building`, `code` (A/B/C), `name_en/id` (mis. "Escalator A · Pentacity"), `landmark_en/id` ("depan Sociolla"), `is_enabled`, `schedule_id`, `notes`.
- **Stop** (`connector_stops`): titik naik/turun bank di satu lantai = satu node graph. Satu bank boleh punya >1 stop di lantai yang sama (contoh data: Eskalator A E-Walk di GF punya titik ke LG `n250` dan titik ke UG `n251`). Field: `public_id` (id amenity ekspor, mis. `esc-a-ewalk-gf-2`), `floor_id`, `node_id`, `is_served` (lift: berhenti di lantai ini?), `label_en/id`.
- **Leg** (`connector_legs`): ruas antara `lower_stop_id` dan `upper_stop_id`. Field: `is_enabled` (ada & dipakai), `direction` (`both` = sepasang unit naik+turun; `up` = hanya naik; `down` = hanya turun), `schedule_id` (jam operasi; null = ikut bank → ikut mall), `cost_override`, `src_key` (Mapplic endpoint, mis. `esc-a-penta-2`), `verified_at`, `verified_by`, `field_note`.
  - Bila unit naik dan turun berada jauh terpisah (scissor), buat **dua leg** (`up` dan `down`) dengan stop berbeda.
  - Untuk `bridge` (dua sheet berbeda di level sama): `lower_stop` = stop sheet pertama, `upper_stop` = stop sheet kedua, `direction` wajib `both`.
  - Lift: leg otomatis di-generate antar stop `is_served=1` yang berurutan per level (tombol "Regenerate legs" di panel); leg lift selalu `both`.
- **Biaya** default per level: eskalator 19.2, lift 38.4 (sudah termasuk waktu tunggu), tangga 28.8, travelator 9.6, jembatan 0 + panjang polyline (settings `cost.*`). Leg lift yang melompati level: biaya × jumlah level.
- Panel UI "tumpukan lantai" di §7.5.

### 2.7 Status live / closures + notice (M; notice S)
- **Closure**: target salah satu dari leg / bank (= semua leg-nya) / edge koridor / amenity; `direction` (`both|up|down`, hanya relevan eskalator), `starts_at` (default sekarang), `ends_at` (null = sampai dibuka manual), `reason_en/id` (pilihan cepat: "Perawatan", "Rusak", "Pembersihan", "Acara"), pembuat.
- Setiap create/end closure **langsung** menulis ulang `status.json` (kanal status, versi naik) — tanpa validasi blocking, tetapi API mengembalikan **dampak**: daftar tenant yang menjadi tidak terjangkau dari kiosk mana pun (mode default & aksesibel) agar Ops sadar.
- **Notice** (S): satu pesan aktif `{level: info|warning|emergency, text_en, text_id, until}`; kiosk menampilkan banner (emergency = layar penuh merah, menimpa attract).
- Halaman Ops: daftar bank per gedung dengan saklar besar per leg/arah, bisa dari HP teknisi.

### 2.8 Kiosk (M)
Field: `id` (slug; dipakai `?kiosk=`), `name`, `floor_id`, `building`, `x`,`y`, `node_id`, `facing_deg` (arah layar menghadap, derajat dari "atas" peta, 0–359; diatur dengan dial di peta), `default_lang` (`en|id`), `attract_lang` (default `en`), **`client_type`** (`windows_pc|smart_tv|android_box|other`), **`perf_mode`** (`auto|full|lite`), `is_active`, token (hash), catatan hardware (merk/model, OS, resolusi, lokasi fisik), runtime: `last_seen_at`, versi data/promo/status yang dipakai, `app_build`, `user_agent`, `perf_active` (mode yang benar-benar aktif), `sw_active`, `screen`, `uptime_sec`, `last_error`, `ip_last`.
- **Online** = heartbeat < 3 menit; **stale** = online tapi versi data ≠ live > 15 menit; **offline** = > 3 menit tanpa heartbeat.
- Command (M): `reload`, `identify` (overlay besar ID kiosk 15 dtk), `clear_cache` (hapus cache SW + reload). (C: `screenshot`.)
- Provisioning (M): tombol "Buat token" → token 32 byte acak ditampilkan **sekali** beserta URL peluncuran `https://<host>/bsb-directory/?kiosk=<id>&key=<token>` + snippet `start-kiosk.bat` + QR (untuk diketik/di-scan saat setup TV).
- Uptime harian dihitung dari tabel heartbeat per menit.

### 2.9 Fasilitas / POI (M)
`amenity_types` seed: `toilet`, `toilet-accessible`, `musholla`, `atm`, `info-desk`, `parking-entrance`, `lobby-exit`, `nursery` (ruang laktasi/ibu & anak), `first-aid`, `charging`, `smoking-area`, `lost-found`, `wheelchair-rental`, `drop-off` (taksi/ojol). Field type: `name_en/id`, `icon` (dari `js/icons.js` — WP-C menambah ikon yang diperlukan, §6.6), `color`, `show_in_home` (tombol "terdekat" di panel kiosk, maks 6), `sort_order`.
Amenity: `id` (slug), `type_id`, `floor_id`, `building`, `x`,`y`, `node_id`, `name_en/id` (opsional, default nama tipe), `detail_en/id` ("Pria & Wanita, ada difabel"), `is_wheelchair`, `gender` (`all|male|female|family`), `schedule_id`, `is_published`.
Aturan: node POI tidak boleh sama dengan node stop konektor (validasi).

### 2.10 Promo / iklan (M)
Field: `title_en/id`, `sub_en/id`, `kind` (`text` = kartu warna seperti placeholder sekarang | `image` | `video`), `media_id`, `poster_media_id` (video; dipakai di mode lite), `bg_color`, `slot`, `link_type` (`none|tenant|category|event|url`) + `link_ref` (tap promo → buka detail tenant/kategori; `url` → tampilkan QR), `starts_at`, `ends_at`, `days_mask` (bit0=Senin … bit6=Minggu), `time_from`/`time_to`, `duration_sec` (default 8; video = durasi video, maks 30), `weight` 1–10 (prioritas = frekuensi tampil), `status` (`draft|active|paused|archived`), target (`all_kiosks` atau daftar kiosk), `advertiser_tenant_id` / `advertiser_name`, `max_impressions` (C).

Slot & ukuran (kanvas kiosk 1920×1080 CSS px):

| Slot | Lokasi | Ukuran tampil | File yang diminta | v1 |
|---|---|---|---|---|
| `attract-hero` | Kartu promo layar atraksi (`.att-promo`, 520×380, radius 34) | 520×380 | **1040×760** JPG/PNG/WebP atau MP4 H.264 ≤ 15 MB, ≤ 30 dtk, tanpa audio; teks penting jauhi 40 px tepi | M |
| `attract-fullscreen` | Takeover layar penuh tiap N putaran atraksi (default tiap 4 promo) | 1920×1080 | **1920×1080** gambar atau MP4 ≤ 30 MB ≤ 30 dtk | S |
| `panel-banner` | Banner di panel kiri beranda | 676×200 | 1352×400 | C |
| `phone-arrival` | Layar "Anda sudah sampai" di HP | 360×180 | 1080×540 | C |

Rotasi di kiosk: filter (status aktif, tanggal, hari, jam, target kiosk, slot) → **smooth weighted round-robin** berdasar `weight`. Bila kosong → `config.promos` placeholder. Impresi dihitung bila promo terlihat ≥ 1 dtk di layar atraksi.

### 2.11 Event (S)
`title_en/id`, `desc_en/id`, `media_id`, `starts_at`, `ends_at`, lokasi (`tenant` | `amenity` | `point` (floor+x,y+node) | `text`), `show_on_attract` (dirender sebagai kartu promo `kind:event` di slot `attract-hero`), `is_published`. Diekspor di `promos.json`. Event berlokasi node bisa dirutekan.

### 2.12 Featured tenant (M)
Daftar urut tenant untuk marquee logo di layar atraksi (menggantikan `config.featured`), opsional periode `starts_at/ends_at`. Validasi: tenant terpublish & punya logo. Diekspor di `promos.json.featured`.

### 2.13 i18n strings (S)
Tabel override per key untuk `en`/`id` (key sama dengan `js/i18n.js`, mis. `welcome`, `touchStart`). `js/i18n.js` tetap menjadi default; snapshot membawa hanya override. UI: daftar key default (dibaca dari `BSB` di browser admin dengan memuat `../js/i18n.js`) + kolom override + preview.

### 2.14 Publish workflow (M)
Alur: **Draft (DB) → Validasi → Pratinjau diff → Publish → Riwayat → Rollback**.
- Draft = isi DB saat ini. Tidak ada salinan draft terpisah.
- **Validasi** dijalankan otomatis sebelum publish (§2.15); error memblokir, warning tidak.
- **Diff** = bandingkan JSON kandidat dengan rilis live: per seksi, jumlah + daftar id (tenant ditambah/dihapus/berubah per field; kategori; lantai; node/edge ±; leg berubah arah/aktif; kiosk dipindah; amenity). Ditampilkan sebelum tombol Publish; disimpan di `releases.diff`.
- **Publish**: tulis `data/releases/<version>/directory.json`, SVG lantai hasil publish ke `media/pub/floors/<floorId>.<sha8>.svg`, lalu ganti atomik `data/directory.json` (tulis `*.tmp` lalu `rename`), lalu `data/version.json`. Semua dalam lock file (`data/.publish.lock`, `flock`) agar tidak ada publish ganda.
- **Versi**: `D<seq 4 digit>-<YYYYMMDDHHmm>` (directory), `P…` (promos), `S…` (status). Monoton; kiosk cukup membandingkan string.
- **Rollback**: pilih rilis lama → salin file rilis ke live sebagai **rilis baru** (`rolled_back_from`), versi naik → kiosk reload. DB tidak di-rollback; dashboard menampilkan banner "Live = rollback ke D0041; draft berbeda" sampai publish berikutnya. (C: "Pulihkan draft dari rilis".)
- Retensi: semua rilis disimpan (± 250 KB/rilis).

### 2.15 Validasi (M) — port `tools/verify_routes.py` ke PHP (`lib/Validator.php`, `lib/RouteCheck.php`)
Jalankan terhadap **JSON kandidat** (bukan langsung DB) supaya yang diuji = yang akan dipublish. Dijkstra PHP dengan `SplPriorityQueue` (prioritas negatif). Semantik edge identik `js/route.js`: walk/lift/stairs/crossing tak berarah; `escalator-*` berarah; mode aksesibel membuang `escalator*` dan `stairs`.

| Kode | Level | Aturan |
|---|---|---|
| `E_REF` | error | id unik; semua referensi (floor, category, node, media) ada |
| `E_BOUNDS` | error | titik tenant/kiosk/amenity di dalam viewBox lantainya |
| `E_NODE_FLOOR` | error | node milik tenant/kiosk/amenity berada di lantai yang sama |
| `E_EDGE_FLOOR` | error | edge walk menghubungkan node satu lantai |
| `E_LEG_LEVEL` | error | leg: level lower < level upper (bridge: level sama, sheet beda); stop milik bank yang sama |
| `E_URL` | error | url tenant harus `https://` |
| `E_REACH` | error | tenant `open` tidak terjangkau dari **minimal satu** kiosk aktif (mode default, semua jadwal dianggap buka) |
| `W_REACH_RETURN` | warning | tenant → kiosk tidak terjangkau (penting untuk eskalator satu arah) |
| `W_REACH_ACC` | warning | tidak terjangkau mode aksesibel (daftar per tenant) |
| `W_REACH_NOW` | warning | tidak terjangkau **saat ini** karena closure aktif/di luar jam operasi |
| `W_ESC_SPAN` | warning | leg eskalator melompati > 1 level |
| `W_STOP_DANGLING` | warning | stop tanpa leg aktif (contoh data: `esc-c-ewalk-3` UG, `esc-b-ewalk-4` 1F) |
| `W_COMPONENT` | warning | komponen graph terisolasi (node tanpa jalur ke kiosk mana pun) |
| `W_POI_NODE` | warning | node POI = node stop konektor |
| `W_UNIT_MISSING` | warning | `unit_shape_id` tidak ditemukan di SVG |
| `W_NO_LOGO` / `W_NO_HOURS` / `W_NO_FACING` / `W_NO_NORTH` | warning | kelengkapan data |
| `W_SCHEDULE_GAP` | warning | leg dengan jadwal yang tutup di jam buka mall |

Output: `{ok, errors:[{code,msg,ref}], warnings:[…], stats:{pairs, reachable, reachablePct, accessiblePct, returnFail}, unreachable:{tenantId:[kioskIds]}, ms}`. Target waktu < 2 dtk (7 kiosk × 2 mode + 210 Dijkstra balik, ±614 node).
CLI: `php tools/validate.php [--accessible] [--json out.json]` — hasil harus sama dengan `python3 tools/verify_routes.py` untuk data seed (1470/1470 default, 1449 aksesibel sebelum koreksi).

### 2.16 Analitik (M)
Event kiosk (batch) & HP (beacon). Laporan v1: (1) pencarian teratas, (2) **pencarian tanpa hasil** (bahan keyword), (3) tenant paling dilihat, (4) rute diminta (per tenant, per kiosk, % aksesibel), (5) scan QR & konversi rute→scan→"arrived", (6) uptime kiosk per hari, (7) impresi & tap promo per promo (laporan untuk pengiklan, export CSV). Filter tanggal & kiosk. Raw disimpan 180 hari; rollup harian selamanya (cron 02:00).
Tidak ada data pribadi: IP HP di-hash (SHA-256 + salt harian), tidak disimpan mentah (selaras UU PDP 27/2022).

### 2.17 Audit log (M)
Semua write admin: waktu, user, IP, aksi, entitas, id, ringkasan, `before`/`after` JSON (hanya field berubah). Read-only; filter entitas/user/tanggal. Retensi 2 tahun.

### 2.18 Media library (M)
Grid dengan filter tipe (logo/gambar/video/svg), pencarian nama, "dipakai oleh" (reverse reference), hapus hanya jika tidak dipakai. Dedupe via SHA-256. Upload: §8.2.

### 2.19 Backup (M)
Lihat §8.6.

---

## 3. Data model — DDL (kontrak bersama, dimiliki WP-A)

File: `db/schema.sql` (persis seperti di bawah) + `db/seed_reference.sql` (role tidak perlu; amenity_types, settings default). Konvensi: semua `DATETIME` = waktu lokal WITA; `created_by/updated_by` → `users.id` `ON DELETE SET NULL`.

```sql
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
CREATE DATABASE IF NOT EXISTS bsb_directory CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE bsb_directory;

-- ========== users & security ==========
CREATE TABLE users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  role ENUM('superadmin','map_editor','leasing','marketing','operations','security','viewer') NOT NULL DEFAULT 'viewer',
  password_hash VARCHAR(255) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  failed_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME NULL,
  last_login_at DATETIME NULL,
  password_changed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE login_attempts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NULL,
  ip VARCHAR(45) NOT NULL,
  success TINYINT(1) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ip_time (ip, created_at),
  KEY idx_email_time (email, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE rate_limits (
  bucket VARCHAR(120) NOT NULL,          -- mis. 'tele:kiosk:gf-pentacity', 'phone:ip:<hash>', 'login:ip:1.2.3.4'
  window_start INT UNSIGNED NOT NULL,    -- unix time dibulatkan ke awal window
  hits INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settings (
  `key` VARCHAR(80) PRIMARY KEY,         -- 'mall.hours', 'map.northDeg', 'cost.escalatorPerLevel', 'kiosk.idleTimeoutSec', 'public.baseUrl', ...
  value JSON NOT NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- revisi per scope untuk optimistic locking & deteksi "ada perubahan belum dipublish"
CREATE TABLE revisions (
  scope ENUM('content','map','promos') PRIMARY KEY,
  rev INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== media ==========
CREATE TABLE media (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('logo','image','video','svg','other') NOT NULL,
  path VARCHAR(255) NOT NULL,            -- relatif ke app root: 'media/logos/3f9a….webp' atau seed 'assets/logos/uniqlo-gf.webp'
  path_2x VARCHAR(255) NULL,
  mime VARCHAR(64) NOT NULL,
  bytes INT UNSIGNED NOT NULL,
  width SMALLINT UNSIGNED NULL,
  height SMALLINT UNSIGNED NULL,
  duration_sec DECIMAL(6,2) NULL,
  sha256 CHAR(64) NOT NULL,
  original_name VARCHAR(190) NULL,
  alt_text VARCHAR(190) NULL,
  meta JSON NULL,                        -- laporan sanitasi SVG, encoder dipakai, dll.
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_media_sha_kind (sha256, kind),
  KEY idx_media_kind (kind),
  CONSTRAINT fk_media_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== floors ==========
CREATE TABLE floors (
  id VARCHAR(32) PRIMARY KEY,            -- 'lg-penta','lg-ewalk','gf','ug','ff-penta','ff-ewalk','sf-penta','sf-ewalk'
  level TINYINT NOT NULL,                -- -1 LG, 0 GF, 1 UG, 2 1F, 3 2F
  short VARCHAR(8) NOT NULL,
  name_en VARCHAR(80) NOT NULL,
  name_id VARCHAR(80) NOT NULL,
  building ENUM('pentacity','ewalk','both') NOT NULL,
  svg_media_id INT UNSIGNED NOT NULL,
  vb_x DECIMAL(10,3) NOT NULL DEFAULT 0,
  vb_y DECIMAL(10,3) NOT NULL DEFAULT 0,
  vb_w DECIMAL(10,3) NOT NULL,
  vb_h DECIMAL(10,3) NOT NULL,
  unit_scale DECIMAL(8,4) NOT NULL DEFAULT 1.0000,
  north_deg DECIMAL(5,1) NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_floor_level (level),
  CONSTRAINT fk_floor_svg FOREIGN KEY (svg_media_id) REFERENCES media(id),
  CONSTRAINT fk_floor_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE floor_focus (
  floor_id VARCHAR(32) NOT NULL,
  building ENUM('pentacity','ewalk') NOT NULL,
  x DECIMAL(10,2) NOT NULL, y DECIMAL(10,2) NOT NULL, w DECIMAL(10,2) NOT NULL, h DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (floor_id, building),
  CONSTRAINT fk_focus_floor FOREIGN KEY (floor_id) REFERENCES floors(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== schedules (jam operasi reusable: eskalator, koridor, fasilitas) ==========
CREATE TABLE schedules (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL UNIQUE,      -- 'Jam mall', '24 jam', 'Eskalator LG 10:00-21:30'
  note VARCHAR(255) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE schedule_rules (
  schedule_id INT UNSIGNED NOT NULL,
  dow TINYINT UNSIGNED NOT NULL,         -- 1=Senin … 7=Minggu (ISO)
  open_time TIME NOT NULL,
  close_time TIME NOT NULL,              -- close < open = lewat tengah malam; 00:00-24:00 ditulis 00:00-23:59:59
  PRIMARY KEY (schedule_id, dow, open_time),
  CONSTRAINT fk_rule_sched FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE,
  CONSTRAINT chk_rule_dow CHECK (dow BETWEEN 1 AND 7)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== graph ==========
CREATE TABLE graph_nodes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,   -- diekspor sebagai 'n<id>'; seed mempertahankan nomor (n348 -> 348)
  floor_id VARCHAR(32) NOT NULL,
  x DECIMAL(10,2) NOT NULL,
  y DECIMAL(10,2) NOT NULL,
  label VARCHAR(80) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_node_floor (floor_id),
  CONSTRAINT fk_node_floor FOREIGN KEY (floor_id) REFERENCES floors(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE graph_edges (                       -- hanya jalan kaki di dalam satu lantai
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  node_a INT UNSIGNED NOT NULL,                  -- disimpan node_a < node_b
  node_b INT UNSIGNED NOT NULL,
  type ENUM('walk') NOT NULL DEFAULT 'walk',
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  cost_override DECIMAL(10,2) NULL,
  schedule_id INT UNSIGNED NULL,
  label VARCHAR(80) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_edge (node_a, node_b),
  KEY idx_edge_b (node_b),
  CONSTRAINT chk_edge_order CHECK (node_a < node_b),
  CONSTRAINT fk_edge_a FOREIGN KEY (node_a) REFERENCES graph_nodes(id) ON DELETE CASCADE,
  CONSTRAINT fk_edge_b FOREIGN KEY (node_b) REFERENCES graph_nodes(id) ON DELETE CASCADE,
  CONSTRAINT fk_edge_sched FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== connectors: bank -> stop -> leg ==========
CREATE TABLE connector_banks (
  id VARCHAR(48) PRIMARY KEY,                    -- 'esc-a-penta','lift-ewalk','cross-ff'
  type ENUM('escalator','lift','stairs','bridge','travelator') NOT NULL,
  building ENUM('pentacity','ewalk','both') NOT NULL,
  code VARCHAR(8) NULL,                          -- 'A','B','C'
  name_en VARCHAR(80) NOT NULL,                  -- 'Escalator A · Pentacity'
  name_id VARCHAR(80) NOT NULL,                  -- 'Eskalator A · Pentacity'
  landmark_en VARCHAR(120) NULL,
  landmark_id VARCHAR(120) NULL,                 -- 'depan Sociolla'
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  schedule_id INT UNSIGNED NULL,
  notes TEXT NULL,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_bank_sched FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL,
  CONSTRAINT fk_bank_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE connector_stops (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  bank_id VARCHAR(48) NOT NULL,
  floor_id VARCHAR(32) NOT NULL,
  node_id INT UNSIGNED NOT NULL,
  public_id VARCHAR(64) NOT NULL UNIQUE,         -- id amenity di snapshot: 'esc-a-ewalk-gf-2'
  is_served TINYINT(1) NOT NULL DEFAULT 1,       -- lift berhenti di lantai ini?
  label_en VARCHAR(80) NULL,
  label_id VARCHAR(80) NULL,
  notes VARCHAR(255) NULL,
  UNIQUE KEY uq_stop (bank_id, node_id),
  KEY idx_stop_floor (floor_id),
  CONSTRAINT fk_stop_bank FOREIGN KEY (bank_id) REFERENCES connector_banks(id) ON DELETE CASCADE,
  CONSTRAINT fk_stop_floor FOREIGN KEY (floor_id) REFERENCES floors(id),
  CONSTRAINT fk_stop_node FOREIGN KEY (node_id) REFERENCES graph_nodes(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE connector_legs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,    -- ruleKey ekspor: 'L<id>'
  bank_id VARCHAR(48) NOT NULL,
  lower_stop_id INT UNSIGNED NOT NULL,
  upper_stop_id INT UNSIGNED NOT NULL,
  direction ENUM('both','up','down') NOT NULL DEFAULT 'both',  -- up = lower->upper saja
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  schedule_id INT UNSIGNED NULL,                 -- null = ikut bank, lalu ikut mall
  cost_override DECIMAL(10,2) NULL,
  src_key VARCHAR(48) NULL,                      -- Mapplic endpoint 'esc-a-penta-2'
  verified_at DATETIME NULL,
  verified_by INT UNSIGNED NULL,
  field_note VARCHAR(255) NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_leg_bank (bank_id),
  KEY idx_leg_lower (lower_stop_id),
  KEY idx_leg_upper (upper_stop_id),
  CONSTRAINT chk_leg_stops CHECK (lower_stop_id <> upper_stop_id),
  CONSTRAINT fk_leg_bank FOREIGN KEY (bank_id) REFERENCES connector_banks(id) ON DELETE CASCADE,
  CONSTRAINT fk_leg_lower FOREIGN KEY (lower_stop_id) REFERENCES connector_stops(id) ON DELETE CASCADE,
  CONSTRAINT fk_leg_upper FOREIGN KEY (upper_stop_id) REFERENCES connector_stops(id) ON DELETE CASCADE,
  CONSTRAINT fk_leg_sched FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL,
  CONSTRAINT fk_leg_verifier FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_leg_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== categories, brands, tenants ==========
CREATE TABLE categories (
  id VARCHAR(48) PRIMARY KEY,
  name_en VARCHAR(80) NOT NULL,
  name_id VARCHAR(80) NOT NULL,
  icon VARCHAR(48) NOT NULL,
  color CHAR(7) NOT NULL DEFAULT '#857B70',
  sort_order SMALLINT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE brands (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  slug VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  category_id VARCHAR(48) NOT NULL,
  logo_media_id INT UNSIGNED NULL,
  desc_en TEXT NULL,
  desc_id TEXT NULL,
  keywords_en VARCHAR(500) NULL,
  keywords_id VARCHAR(500) NULL,
  url VARCHAR(500) NULL,
  instagram VARCHAR(120) NULL,
  tiktok VARCHAR(120) NULL,
  facebook VARCHAR(255) NULL,
  whatsapp VARCHAR(32) NULL,                     -- E.164
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_brand_name (name),
  KEY idx_brand_cat (category_id),
  CONSTRAINT fk_brand_cat FOREIGN KEY (category_id) REFERENCES categories(id),
  CONSTRAINT fk_brand_logo FOREIGN KEY (logo_media_id) REFERENCES media(id) ON DELETE SET NULL,
  CONSTRAINT fk_brand_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tenants (
  id VARCHAR(64) PRIMARY KEY,                    -- slug publik stabil: 'uniqlo-gf'
  brand_id INT UNSIGNED NOT NULL,
  name_override VARCHAR(120) NULL,
  floor_id VARCHAR(32) NOT NULL,
  building ENUM('pentacity','ewalk') NOT NULL,
  unit_no VARCHAR(32) NULL,
  x DECIMAL(10,2) NULL,
  y DECIMAL(10,2) NULL,
  node_id INT UNSIGNED NULL,                     -- null = belum ditempatkan (tidak boleh publish bila is_published)
  unit_shape_id VARCHAR(128) NULL,
  phone VARCHAR(32) NULL,
  url_override VARCHAR(500) NULL,
  logo_override_media_id INT UNSIGNED NULL,
  status ENUM('open','coming_soon','temp_closed','closed') NOT NULL DEFAULT 'open',
  status_note_en VARCHAR(160) NULL,
  status_note_id VARCHAR(160) NULL,
  status_until DATE NULL,
  opening_date DATE NULL,
  hours_mode ENUM('mall','custom','24h','unknown') NOT NULL DEFAULT 'unknown',
  hours_note_en VARCHAR(160) NULL,
  hours_note_id VARCHAR(160) NULL,
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  src_id VARCHAR(120) NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_tenant_brand (brand_id),
  KEY idx_tenant_floor (floor_id),
  KEY idx_tenant_status (status, is_published),
  CONSTRAINT fk_tenant_brand FOREIGN KEY (brand_id) REFERENCES brands(id),
  CONSTRAINT fk_tenant_floor FOREIGN KEY (floor_id) REFERENCES floors(id),
  CONSTRAINT fk_tenant_node FOREIGN KEY (node_id) REFERENCES graph_nodes(id) ON DELETE SET NULL,
  CONSTRAINT fk_tenant_logo FOREIGN KEY (logo_override_media_id) REFERENCES media(id) ON DELETE SET NULL,
  CONSTRAINT fk_tenant_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tenant_hours (
  tenant_id VARCHAR(64) NOT NULL,
  dow TINYINT UNSIGNED NOT NULL,                 -- 1=Senin … 7=Minggu
  open_time TIME NULL,
  close_time TIME NULL,
  is_closed TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, dow),
  CONSTRAINT fk_th_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT chk_th_dow CHECK (dow BETWEEN 1 AND 7)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== amenities (POI) ==========
CREATE TABLE amenity_types (
  id VARCHAR(32) PRIMARY KEY,                    -- 'toilet','musholla','atm','info-desk',...
  name_en VARCHAR(60) NOT NULL,
  name_id VARCHAR(60) NOT NULL,
  icon VARCHAR(48) NOT NULL,
  color CHAR(7) NOT NULL DEFAULT '#2F5BEA',
  show_in_home TINYINT(1) NOT NULL DEFAULT 0,
  sort_order SMALLINT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE amenities (
  id VARCHAR(64) PRIMARY KEY,                    -- 'toilet-gf-penta-1'
  type_id VARCHAR(32) NOT NULL,
  floor_id VARCHAR(32) NOT NULL,
  building ENUM('pentacity','ewalk') NOT NULL,
  x DECIMAL(10,2) NOT NULL,
  y DECIMAL(10,2) NOT NULL,
  node_id INT UNSIGNED NULL,
  name_en VARCHAR(80) NULL,
  name_id VARCHAR(80) NULL,
  detail_en VARCHAR(160) NULL,
  detail_id VARCHAR(160) NULL,
  is_wheelchair TINYINT(1) NOT NULL DEFAULT 0,
  gender ENUM('all','male','female','family') NOT NULL DEFAULT 'all',
  schedule_id INT UNSIGNED NULL,
  is_published TINYINT(1) NOT NULL DEFAULT 1,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_am_floor (floor_id),
  KEY idx_am_type (type_id),
  CONSTRAINT fk_am_type FOREIGN KEY (type_id) REFERENCES amenity_types(id),
  CONSTRAINT fk_am_floor FOREIGN KEY (floor_id) REFERENCES floors(id),
  CONSTRAINT fk_am_node FOREIGN KEY (node_id) REFERENCES graph_nodes(id) ON DELETE SET NULL,
  CONSTRAINT fk_am_sched FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL,
  CONSTRAINT fk_am_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== closures (status live) ==========
CREATE TABLE closures (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  leg_id INT UNSIGNED NULL,
  bank_id VARCHAR(48) NULL,
  edge_id INT UNSIGNED NULL,
  amenity_id VARCHAR(64) NULL,
  direction ENUM('both','up','down') NOT NULL DEFAULT 'both',
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NULL,                         -- null = sampai diakhiri manual
  reason_en VARCHAR(160) NULL,
  reason_id VARCHAR(160) NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_by INT UNSIGNED NULL,
  ended_at DATETIME NULL,                        -- diisi saat diakhiri manual (ends_at juga diset = ended_at)
  KEY idx_cl_active (ends_at, starts_at),
  CONSTRAINT chk_cl_target CHECK ((leg_id IS NOT NULL) + (bank_id IS NOT NULL) + (edge_id IS NOT NULL) + (amenity_id IS NOT NULL) = 1),
  CONSTRAINT fk_cl_leg FOREIGN KEY (leg_id) REFERENCES connector_legs(id) ON DELETE CASCADE,
  CONSTRAINT fk_cl_bank FOREIGN KEY (bank_id) REFERENCES connector_banks(id) ON DELETE CASCADE,
  CONSTRAINT fk_cl_edge FOREIGN KEY (edge_id) REFERENCES graph_edges(id) ON DELETE CASCADE,
  CONSTRAINT fk_cl_am FOREIGN KEY (amenity_id) REFERENCES amenities(id) ON DELETE CASCADE,
  CONSTRAINT fk_cl_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_cl_user2 FOREIGN KEY (ended_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notices (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  level ENUM('info','warning','emergency') NOT NULL,
  text_en VARCHAR(300) NOT NULL,
  text_id VARCHAR(300) NOT NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NULL,
  all_kiosks TINYINT(1) NOT NULL DEFAULT 1,
  kiosk_ids JSON NULL,                           -- ["gf-pentacity",...] bila all_kiosks=0
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_notice_active (ends_at, starts_at),
  CONSTRAINT fk_notice_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== kiosks ==========
CREATE TABLE kiosks (
  id VARCHAR(48) PRIMARY KEY,                    -- 'gf-pentacity'
  name VARCHAR(80) NOT NULL,
  floor_id VARCHAR(32) NOT NULL,
  building ENUM('pentacity','ewalk') NOT NULL,
  x DECIMAL(10,2) NOT NULL,
  y DECIMAL(10,2) NOT NULL,
  node_id INT UNSIGNED NULL,
  facing_deg SMALLINT NULL,                      -- 0..359, relatif "atas" peta lantai
  default_lang ENUM('en','id') NOT NULL DEFAULT 'en',
  attract_lang ENUM('en','id') NOT NULL DEFAULT 'en',
  client_type ENUM('windows_pc','smart_tv','android_box','other') NOT NULL DEFAULT 'windows_pc',
  perf_mode ENUM('auto','full','lite') NOT NULL DEFAULT 'auto',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  token_hash CHAR(64) NULL,                      -- SHA-256(token); token plaintext hanya ditampilkan sekali
  token_hint CHAR(4) NULL,                       -- 4 char terakhir untuk identifikasi
  hw_note VARCHAR(255) NULL,                     -- merk/model/OS/resolusi/lokasi fisik
  src_id VARCHAR(64) NULL,
  -- runtime (diisi heartbeat)
  last_seen_at DATETIME NULL,
  ip_last VARCHAR(45) NULL,
  app_build VARCHAR(32) NULL,
  data_version VARCHAR(32) NULL,
  promos_version VARCHAR(32) NULL,
  status_version VARCHAR(32) NULL,
  user_agent VARCHAR(400) NULL,
  perf_active ENUM('full','lite') NULL,
  perf_reason VARCHAR(120) NULL,                 -- 'cms', 'auto:deviceMemory<=2', 'auto:fps', 'url'
  sw_active TINYINT(1) NULL,
  screen VARCHAR(40) NULL,                       -- '1920x1080@1'
  uptime_sec INT UNSIGNED NULL,
  last_error VARCHAR(500) NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_kiosk_seen (last_seen_at),
  CONSTRAINT fk_kiosk_floor FOREIGN KEY (floor_id) REFERENCES floors(id),
  CONSTRAINT fk_kiosk_node FOREIGN KEY (node_id) REFERENCES graph_nodes(id) ON DELETE SET NULL,
  CONSTRAINT fk_kiosk_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE kiosk_commands (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kiosk_id VARCHAR(48) NOT NULL,
  command ENUM('reload','identify','clear_cache') NOT NULL,
  payload JSON NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at DATETIME NULL,
  acked_at DATETIME NULL,
  result VARCHAR(255) NULL,
  KEY idx_cmd_pending (kiosk_id, delivered_at),
  CONSTRAINT fk_cmd_kiosk FOREIGN KEY (kiosk_id) REFERENCES kiosks(id) ON DELETE CASCADE,
  CONSTRAINT fk_cmd_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE kiosk_heartbeats (                  -- satu baris per kiosk per menit; raw 30 hari
  kiosk_id VARCHAR(48) NOT NULL,
  minute DATETIME NOT NULL,                      -- dibulatkan ke menit
  perf_active ENUM('full','lite') NULL,
  PRIMARY KEY (kiosk_id, minute),
  CONSTRAINT fk_hb_kiosk FOREIGN KEY (kiosk_id) REFERENCES kiosks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== promos, events, featured, i18n ==========
CREATE TABLE promos (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title_en VARCHAR(120) NOT NULL,
  title_id VARCHAR(120) NOT NULL,
  sub_en VARCHAR(200) NULL,
  sub_id VARCHAR(200) NULL,
  kind ENUM('text','image','video') NOT NULL DEFAULT 'image',
  media_id INT UNSIGNED NULL,
  poster_media_id INT UNSIGNED NULL,
  bg_color CHAR(7) NULL,
  slot ENUM('attract-hero','attract-fullscreen','panel-banner','phone-arrival') NOT NULL DEFAULT 'attract-hero',
  link_type ENUM('none','tenant','category','event','url') NOT NULL DEFAULT 'none',
  link_ref VARCHAR(500) NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  days_mask TINYINT UNSIGNED NOT NULL DEFAULT 127,  -- bit0=Senin … bit6=Minggu
  time_from TIME NULL,
  time_to TIME NULL,
  duration_sec TINYINT UNSIGNED NOT NULL DEFAULT 8,
  weight TINYINT UNSIGNED NOT NULL DEFAULT 5,
  status ENUM('draft','active','paused','archived') NOT NULL DEFAULT 'draft',
  all_kiosks TINYINT(1) NOT NULL DEFAULT 1,
  advertiser_tenant_id VARCHAR(64) NULL,
  advertiser_name VARCHAR(120) NULL,
  max_impressions INT UNSIGNED NULL,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_promo_window (status, starts_at, ends_at),
  CONSTRAINT chk_promo_weight CHECK (weight BETWEEN 1 AND 10),
  CONSTRAINT fk_promo_media FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE SET NULL,
  CONSTRAINT fk_promo_poster FOREIGN KEY (poster_media_id) REFERENCES media(id) ON DELETE SET NULL,
  CONSTRAINT fk_promo_adv FOREIGN KEY (advertiser_tenant_id) REFERENCES tenants(id) ON DELETE SET NULL,
  CONSTRAINT fk_promo_cb FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_promo_ub FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE promo_targets (
  promo_id INT UNSIGNED NOT NULL,
  kiosk_id VARCHAR(48) NOT NULL,
  PRIMARY KEY (promo_id, kiosk_id),
  CONSTRAINT fk_pt_promo FOREIGN KEY (promo_id) REFERENCES promos(id) ON DELETE CASCADE,
  CONSTRAINT fk_pt_kiosk FOREIGN KEY (kiosk_id) REFERENCES kiosks(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE events (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  title_en VARCHAR(120) NOT NULL,
  title_id VARCHAR(120) NOT NULL,
  desc_en TEXT NULL,
  desc_id TEXT NULL,
  media_id INT UNSIGNED NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  location_type ENUM('tenant','amenity','point','text') NOT NULL DEFAULT 'text',
  tenant_id VARCHAR(64) NULL,
  amenity_id VARCHAR(64) NULL,
  floor_id VARCHAR(32) NULL,
  x DECIMAL(10,2) NULL,
  y DECIMAL(10,2) NULL,
  node_id INT UNSIGNED NULL,
  location_text_en VARCHAR(160) NULL,
  location_text_id VARCHAR(160) NULL,
  show_on_attract TINYINT(1) NOT NULL DEFAULT 1,
  is_published TINYINT(1) NOT NULL DEFAULT 0,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_event_window (is_published, starts_at, ends_at),
  CONSTRAINT fk_ev_media FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE SET NULL,
  CONSTRAINT fk_ev_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL,
  CONSTRAINT fk_ev_am FOREIGN KEY (amenity_id) REFERENCES amenities(id) ON DELETE SET NULL,
  CONSTRAINT fk_ev_floor FOREIGN KEY (floor_id) REFERENCES floors(id) ON DELETE SET NULL,
  CONSTRAINT fk_ev_node FOREIGN KEY (node_id) REFERENCES graph_nodes(id) ON DELETE SET NULL,
  CONSTRAINT fk_ev_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE featured_tenants (
  tenant_id VARCHAR(64) PRIMARY KEY,
  sort_order SMALLINT NOT NULL DEFAULT 0,
  starts_at DATETIME NULL,
  ends_at DATETIME NULL,
  CONSTRAINT fk_ft_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE i18n_strings (
  `key` VARCHAR(64) PRIMARY KEY,                 -- sama dengan key di js/i18n.js
  en VARCHAR(500) NULL,
  id VARCHAR(500) NULL,
  note VARCHAR(160) NULL,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_i18n_user FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== publish ==========
CREATE TABLE releases (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  channel ENUM('directory','promos','status') NOT NULL,
  version VARCHAR(32) NOT NULL,                  -- 'D0042-202610051530'
  seq INT UNSIGNED NOT NULL,
  sha256 CHAR(64) NOT NULL,
  bytes INT UNSIGNED NOT NULL,
  path VARCHAR(255) NOT NULL,                    -- 'data/releases/D0042-202610051530/directory.json'
  revs JSON NULL,                                -- {"content":12,"map":7,"promos":3} saat publish
  stats JSON NULL,
  diff JSON NULL,
  validation JSON NULL,
  notes VARCHAR(500) NULL,
  is_live TINYINT(1) NOT NULL DEFAULT 0,
  rolled_back_from INT UNSIGNED NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rel (channel, version),
  UNIQUE KEY uq_rel_seq (channel, seq),
  KEY idx_rel_live (channel, is_live),
  CONSTRAINT fk_rel_rb FOREIGN KEY (rolled_back_from) REFERENCES releases(id) ON DELETE SET NULL,
  CONSTRAINT fk_rel_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE validation_runs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ok TINYINT(1) NOT NULL,
  errors SMALLINT UNSIGNED NOT NULL,
  warnings SMALLINT UNSIGNED NOT NULL,
  report JSON NOT NULL,
  revs JSON NULL,
  ms INT UNSIGNED NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_vr_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ========== audit & analytics ==========
CREATE TABLE audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ts DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INT UNSIGNED NULL,
  ip VARCHAR(45) NULL,
  action VARCHAR(40) NOT NULL,                   -- 'create','update','delete','publish','rollback','login','login_fail','closure_start',...
  entity_type VARCHAR(40) NOT NULL,
  entity_id VARCHAR(64) NULL,
  summary VARCHAR(255) NULL,
  before_json JSON NULL,
  after_json JSON NULL,
  KEY idx_audit_entity (entity_type, entity_id),
  KEY idx_audit_ts (ts),
  KEY idx_audit_user (user_id, ts),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE telemetry_events (                  -- raw, retensi 180 hari (tanpa FK agar ingest cepat)
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source ENUM('kiosk','phone') NOT NULL,
  kiosk_id VARCHAR(48) NULL,
  session_id CHAR(12) NULL,
  ts DATETIME(3) NOT NULL,                       -- waktu klien (WITA)
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  type VARCHAR(32) NOT NULL,
  tenant_id VARCHAR(64) NULL,
  promo_id INT UNSIGNED NULL,
  query VARCHAR(100) NULL,
  value INT NULL,                                -- jumlah hasil, durasi ms, dll.
  lang CHAR(2) NULL,
  accessible TINYINT(1) NULL,
  ip_hash CHAR(16) NULL,
  payload JSON NULL,
  KEY idx_te_type_ts (type, ts),
  KEY idx_te_kiosk_ts (kiosk_id, ts),
  KEY idx_te_tenant_ts (tenant_id, ts),
  KEY idx_te_promo_ts (promo_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stats_daily (
  day DATE NOT NULL,
  kiosk_id VARCHAR(48) NOT NULL DEFAULT '*',
  metric VARCHAR(32) NOT NULL,                   -- 'search','search_zero','tenant_view','route','route_acc','qr_shown','qr_scan','nav_arrived','promo_imp','promo_tap','session','uptime_min'
  dim VARCHAR(100) NOT NULL DEFAULT '',          -- tenant_id / query / promo_id / ''
  value INT UNSIGNED NOT NULL,
  PRIMARY KEY (day, kiosk_id, metric, dim),
  KEY idx_sd_metric (metric, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;

INSERT INTO revisions (scope, rev) VALUES ('content',0),('map',0),('promos',0);
```

Catatan model:
- **Revisi**: setiap write di seksi content (`brands`, `tenants`, `tenant_hours`, `categories`, `i18n_strings`) menaikkan `revisions.content`; seksi map (`floors`, `floor_focus`, `graph_*`, `connector_*`, `kiosks` posisi/profil, `amenities`, `amenity_types`, `schedules`) menaikkan `revisions.map`; promo/event/featured menaikkan `revisions.promos`. Naikkan di transaksi yang sama (`lib/Revisions::bump($pdo,'map')`). "Ada perubahan belum dipublish" = `revisions.rev > releases(live).revs[scope]`.
- Penempatan tenant (`x,y,node_id`) termasuk seksi **content** (leasing boleh), tetapi bila penempatan membuat node/edge spur baru, perubahan graph itu menaikkan **map** juga → aturan publish §1.3 berlaku. Untuk menghindari blokir, spur otomatis dari penempatan tenant ditandai `graph_nodes.label = 'spur:<tenantId>'` dan **dikecualikan** dari seksi map pada diff (diff menghitungnya sebagai bagian tenant).
- Seed importer (§10) memetakan `n<k>` → `graph_nodes.id = k` (pakai `INSERT` eksplisit id, lalu `ALTER TABLE graph_nodes AUTO_INCREMENT = max+1`).

---

## 4. API

### 4.1 Struktur & konvensi
- Front controller: `api/index.php`; `api/.htaccess`:
  `RewriteEngine On` · `RewriteCond %{REQUEST_FILENAME} !-f` · `RewriteRule ^ index.php [QSA,L]`. Router juga menerima `?r=/admin/tenants` sebagai fallback bila mod_rewrite mati.
- Base path: `/bsb-directory/api` (dihitung dari `SCRIPT_NAME`, jangan hardcode).
- JSON UTF-8, `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store` kecuali dinyatakan lain.
- Sukses: `{"data": …}` (list: `{"data":[…], "total":n, "page":p, "per":k}`). Error: `{"error":{"code":"validation|not_found|forbidden|unauthenticated|conflict|rate_limited|server","message":"…","fields":{"name":"required"},"details":{}}}` dengan HTTP 422/404/403/401/409/429/500.
- Optimistic locking: resource yang bisa diedit mengembalikan `"etag": "<updated_at|rev>"`; PUT wajib header `If-Match`; mismatch → 409 dengan `details.current`.
- Pagination `?page=1&per=50` (maks 500). Sort `?sort=name|-updated_at`.
- Waktu dalam JSON: string ISO 8601 dengan offset `+08:00`.

### 4.2 Auth
| Klien | Mekanisme |
|---|---|
| Admin (`/api/admin/*`) | Session PHP (cookie `BSBSESSID`, `HttpOnly`, `Secure` bila HTTPS, `SameSite=Strict`, path `/bsb-directory/`). Semua method non-GET wajib header `X-CSRF-Token` = token session (synchronizer token, dari `/auth/me`). Cek `Origin`/`Referer` = host sendiri sebagai lapis kedua. |
| Kiosk (`/api/kiosk/*`, `/api/telemetry`) | Header `X-Kiosk-Id` + `X-Kiosk-Key` (token 32 byte base64url). Server membandingkan `hash_equals(sha256(key), token_hash)`. Kiosk tanpa token valid tetap boleh GET publik, tetapi ping/telemetry ditolak 401. |
| HP | Tanpa auth; hanya `POST /api/telemetry/phone` dengan whitelist tipe event + rate limit IP. |

### 4.3 Rate limit (tabel `rate_limits`, fixed window)
| Bucket | Batas |
|---|---|
| login per IP | 20 / 15 menit; per email 5 / 15 menit (→ lock akun 15 menit) |
| `/api/admin/*` per user | 600 / menit |
| `/api/kiosk/ping` per kiosk | 6 / menit |
| `/api/telemetry` per kiosk | 30 / menit, body ≤ 128 KB, ≤ 500 event |
| `/api/telemetry/phone` per IP-hash | 30 / menit, body ≤ 4 KB |
| `/api/version` per IP | 120 / menit |
Window lama dibersihkan oleh cron harian.

### 4.4 Endpoint publik
| Method & path | Keterangan |
|---|---|
| `GET /api/version` | `{"directory":{"version":"D0042-202610051530","sha256":"…","url":"data/directory.json?v=D0042-202610051530","publishedAt":"…"},"promos":{…},"status":{…},"serverTime":"2026-10-05T15:31:02+08:00","minAppBuild":"2026.10.1"}`. Dibaca dari `data/version.json` (file statis yang juga bisa diambil langsung). |
| `GET /api/directory.json` | Passthrough `data/directory.json` dengan `ETag` = sha256, dukung `If-None-Match` → 304. `?v=<version>` → `Cache-Control: public, max-age=31536000, immutable` (dilayani dari `data/releases/<v>/`). |
| `GET /api/promos.json`, `GET /api/status.json` | Sama. |
| `GET /api/health` | `{"ok":true,"db":true,"disk_free_mb":…,"live":{…}}` — untuk monitoring; batasi ke IP LAN (`settings.health.allowCidr`). |
| `POST /api/kiosk/ping` | Heartbeat + pengambilan command. Request: `{"appBuild":"2026.10.1","versions":{"directory":"D0042-…","promos":"P0007-…","status":"S0120-…"},"uptimeSec":3600,"screen":"1920x1080@1","clientType":"windows_pc","perfActive":"full","perfReason":"cms","swActive":true,"queueLen":12,"lastError":null,"ua":"…"}`. Response: `{"data":{"versions":{…sama dengan /api/version…},"commands":[{"id":17,"cmd":"reload","payload":null}],"kiosk":{"perfMode":"auto","clientType":"smart_tv","defaultLang":"en"},"serverTime":"…"}}`. Server upsert `kiosk_heartbeats` per menit, update kolom runtime `kiosks`, tandai command `delivered_at`. |
| `POST /api/kiosk/ack` | `{"commandId":17,"result":"ok"}` → `acked_at`. |
| `POST /api/telemetry` | Batch kiosk: `{"kioskId":"gf-pentacity","events":[{"ts":1759649462123,"type":"search","sid":"a1b2c3d4e5f6","q":"sepatu","n":14,"lang":"id"}, …]}`. Response `{"data":{"accepted":n,"rejected":m}}`. |
| `POST /api/telemetry/phone` | `{"type":"qr_scan","k":"gf-pentacity","t":"uniqlo-gf","a":0,"lang":"en","sid":"a1b2c3d4e5f6","psid":"<id sesi HP>"}`; dikirim `navigator.sendBeacon`. Tipe yang diterima: `qr_scan`, `nav_start`, `compass_on`, `compass_denied`, `arrived`, `abandon`. Response 204. |

**Tipe event kiosk** (whitelist): `session_start`, `session_end` (`value`=durasi ms), `search` (`q`, `n`), `category_open` (`cat`), `az_open`, `tenant_view` (`t`), `route` (`t`, `a`, `ok`, `cost`), `route_fail` (`t`, `a`, `reason`), `amenity_route` (`type`), `qr_shown` (`t`), `promo_imp` (`p`, `ms`), `promo_tap` (`p`), `lang_switch` (`lang`), `floor_switch`, `error` (`msg`), `perf_switch` (`mode`, `reason`).

### 4.5 Endpoint admin (`/api/admin`, session + CSRF)
Auth:
- `POST /auth/login` `{email,password}` → `{data:{user, permissions, csrfToken}}`; `POST /auth/logout`; `GET /auth/me` → `{data:{user:{id,email,name,role,mustChangePassword}, permissions:[…], csrfToken, live:{directory,promos,status}, unpublished:{content:bool,map:bool,promos:bool}}}`; `POST /auth/password` `{current,new}`.

CRUD generik (list/get/create/update/delete) untuk: `brands`, `tenants`, `categories`, `floors`, `kiosks`, `amenities`, `amenity-types`, `schedules`, `promos`, `events`, `featured` (PUT seluruh daftar urut), `i18n` (PUT per key), `users`, `settings` (GET semua / PUT per key).

**DTO kontrak** (bentuk yang dipakai WP-B; camelCase):

```json
// GET /api/admin/tenants/uniqlo-gf
{"data":{
  "id":"uniqlo-gf","brandId":31,"brand":{"id":31,"slug":"uniqlo","name":"Uniqlo","categoryId":"fashion",
    "logo":{"id":88,"url":"assets/logos/uniqlo-gf.webp","url2x":null},
    "descEn":null,"descId":null,"keywordsEn":"clothes, apparel","keywordsId":"baju, pakaian","url":"https://www.uniqlo.com/id/",
    "instagram":null,"tiktok":null,"facebook":null,"whatsapp":null,"outletCount":1},
  "nameOverride":null,"displayName":"Uniqlo","floorId":"gf","building":"pentacity","unitNo":null,
  "x":1012.4,"y":640.2,"nodeId":266,"unitShapeId":null,"phone":null,"urlOverride":null,"logoOverride":null,
  "status":"open","statusNoteEn":null,"statusNoteId":null,"statusUntil":null,"openingDate":null,
  "hoursMode":"mall","hours":[{"dow":1,"open":"10:00","close":"22:00","closed":false}],
  "hoursNoteEn":null,"hoursNoteId":null,"isPublished":true,"srcId":"Uniqlo",
  "issues":["W_NO_HOURS"],"etag":"2026-10-05 15:02:11"}}
```
`POST /api/admin/tenants` menerima objek yang sama tanpa `etag/issues/displayName`; bila `brandId` null dan ada `brand:{…}` → brand baru dibuat dalam transaksi yang sama. List mendukung `?q=&floor=&building=&category=&status=&missing=logo|hours|placement|unit`.

```json
// Kiosk DTO
{"id":"gf-pentacity","name":"GF Pentacity","floorId":"gf","building":"pentacity","x":966.14,"y":656.74,"nodeId":266,
 "facingDeg":null,"defaultLang":"en","attractLang":"en","clientType":"windows_pc","perfMode":"auto","isActive":true,
 "tokenHint":"x9Qa","hwNote":"…",
 "runtime":{"state":"online|stale|offline","lastSeenAt":"…","ip":"10.30.5.21","appBuild":"2026.10.1","dataVersion":"D0042-…",
   "promosVersion":"P0007-…","statusVersion":"S0120-…","userAgent":"…","perfActive":"lite","perfReason":"auto:deviceMemory<=2",
   "swActive":true,"screen":"1920x1080@1","uptimeSec":86400,"lastError":null,"uptime7d":[99.1,100,…]},
 "etag":"…"}
```

Graph:
- `GET /api/admin/graph?floor=gf` →
```json
{"data":{"revision":57,"floor":{"id":"gf","viewBox":[0,0,1920,1080],"svgUrl":"media/…/gf.svg","unitScale":1.0},
 "nodes":[{"id":342,"x":1240.1,"y":480.3,"label":null}],
 "edges":[{"id":1201,"a":341,"b":342,"enabled":true,"costOverride":null,"cost":7.61,"scheduleId":null,"label":null}],
 "attachments":{
   "tenants":[{"id":"uniqlo-gf","name":"Uniqlo","x":1012.4,"y":640.2,"nodeId":266}],
   "kiosks":[{"id":"gf-pentacity","x":966.14,"y":656.74,"nodeId":266}],
   "amenities":[{"id":"toilet-gf-penta-1","typeId":"toilet","x":…,"y":…,"nodeId":…}],
   "stops":[{"id":12,"bankId":"esc-a-penta","publicId":"esc-a-penta-gf","nodeId":101,"legs":[{"id":5,"toFloor":"ug","direction":"both","enabled":true}]}]}}}
```
- `POST /api/admin/graph/ops` — batch transaksional:
```json
{"revision":57,"ops":[
  {"op":"addNode","tmp":"t1","floor":"gf","x":1250,"y":482},
  {"op":"moveNode","id":342,"x":1241,"y":480},
  {"op":"splitEdge","edge":1201,"tmp":"t2","x":1245,"y":481},
  {"op":"addEdge","tmp":"e1","a":"t1","b":342},
  {"op":"updateEdge","id":1201,"enabled":false,"costOverride":null,"scheduleId":null,"label":"Tutup renovasi"},
  {"op":"deleteEdge","id":1188},
  {"op":"deleteNode","id":399,"force":false},
  {"op":"mergeNodes","keep":342,"remove":343},
  {"op":"attach","entity":"tenant|kiosk|amenity","id":"uniqlo-gf","node":"t1"}
]}
```
Response: `{"data":{"revision":58,"idMap":{"t1":615,"t2":616,"e1":1300}}}`. Revision mismatch → 409. `deleteNode` dengan referensi (tenant/kiosk/amenity/stop) → 409 `details.refs` kecuali `force:true` (melepas referensi tenant/amenity ke null, tetapi tidak pernah menghapus stop — stop harus dihapus via konektor).

Konektor:
- `GET /api/admin/connectors` → daftar bank: `{"id":"esc-a-penta","type":"escalator","building":"pentacity","code":"A","nameEn":"…","nameId":"…","landmarkId":"depan Sociolla","isEnabled":true,"scheduleId":null,"notes":"…","stops":[{"id":12,"publicId":"esc-a-penta-gf","floorId":"gf","level":0,"nodeId":101,"isServed":true}],"legs":[{"id":5,"lowerStopId":12,"upperStopId":13,"lowerFloor":"gf","upperFloor":"ug","direction":"both","isEnabled":true,"scheduleId":null,"costOverride":null,"cost":19.2,"srcKey":"esc-a-penta-2","verifiedAt":null,"verifiedBy":null,"fieldNote":null,"activeClosures":[]}]}`.
- `PUT /connectors/{bankId}`, `POST /connectors` (bank baru), `POST /connectors/{bankId}/stops` `{floorId, nodeId}` atau `{floorId, x, y}` (server membuat node + menyambung ke koridor terdekat), `DELETE /connector-stops/{id}`, `POST /connectors/{bankId}/legs` `{lowerStopId, upperStopId, direction}`, `PUT /connector-legs/{id}` `{direction,isEnabled,scheduleId,costOverride,fieldNote,verified:true}`, `DELETE /connector-legs/{id}`, `POST /connectors/{bankId}/regenerate-lift-legs`.

Status live:
- `GET /api/admin/closures?active=1` · `POST /api/admin/closures` `{"target":{"type":"leg|bank|edge|amenity","id":"5"},"direction":"down","startsAt":null,"endsAt":"2026-10-05T18:00:00+08:00","reasonEn":"Maintenance","reasonId":"Perawatan"}` → `{"data":{"closure":{…},"statusVersion":"S0121-…","impact":{"unreachableDefault":[{"tenant":"…","fromKiosks":["…"]}],"unreachableAccessible":[…]}}}` · `POST /api/admin/closures/{id}/end`.
- `GET/POST /api/admin/notices`, `POST /api/admin/notices/{id}/end`.

Publish:
- `POST /api/admin/validate` → laporan §2.15 (juga disimpan di `validation_runs`).
- `GET /api/admin/publish/preview?channel=directory` → `{"data":{"candidateVersion":"D0043-…","diff":{"content":{"tenants":{"added":["…"],"removed":[],"changed":[{"id":"uniqlo-gf","fields":["hours","logo"]}]},"categories":{…}},"map":{"nodes":{"added":3,"removed":0,"moved":5},"edges":{"added":4,"removed":1,"changed":2},"legs":{"changed":[{"id":5,"label":"Esc A Penta GF↔UG","fields":["direction: both→up"]}]},"kiosks":{…},"amenities":{…},"floors":{…}}},"sectionsChanged":["content","map"],"validation":{…},"canPublish":false,"blockers":["Butuh izin publish.map (perubahan oleh Budi, 5 Okt 14:10)"]}}`.
- `POST /api/admin/publish` `{"channel":"directory|promos","notes":"…"}` → `{"data":{"release":{…}}}`.
- `GET /api/admin/releases?channel=directory` · `GET /api/admin/releases/{id}` · `GET /api/admin/releases/{id}/download` · `POST /api/admin/releases/{id}/rollback`.

Media:
- `POST /api/admin/media` (multipart: `file`, `kind`) → `{"data":{"id":91,"kind":"logo","url":"media/logos/3f9a….webp","url2x":"…","width":320,"height":120,"bytes":8211,"encoder":"gd|cwebp|png-fallback","warnings":[]}}`.
- `GET /api/admin/media?kind=&q=` (dengan `usedBy`), `DELETE /api/admin/media/{id}` (409 jika dipakai).
- Lantai: `POST /api/admin/floors/{id}/svg` (multipart) → `{"data":{"uploadToken":"…","report":{"bytesIn":…,"bytesOut":…,"removed":{"script":0,"foreignObject":0,"on*":0,"externalHref":2,"image":1,"aipgf":1},"viewBoxOld":[…],"viewBoxNew":[…],"viewBoxChanged":false,"shapes":412,"missingUnitShapes":["unit-kfc-lg-penta"]},"previewUrl":"media/tmp/….svg"}}` → `POST /api/admin/floors/{id}/svg/confirm {"uploadToken":"…"}`.

Kiosk: `POST /api/admin/kiosks/{id}/token` → `{"data":{"token":"<plaintext sekali>","launchUrl":"https://directory…/bsb-directory/?kiosk=gf-pentacity&key=…","bat":"…","qrSvg":"<svg…>"}}` · `POST /api/admin/kiosks/{id}/commands {"cmd":"reload|identify|clear_cache"}`.

Analitik: `GET /api/admin/analytics/summary?from=&to=&kiosk=` (kartu angka), `/analytics/searches?zero=1`, `/analytics/tenants`, `/analytics/routes`, `/analytics/qr`, `/analytics/promos`, `/analytics/uptime`, `/analytics/export.csv?report=…`.
Audit: `GET /api/admin/audit?entity=&id=&user=&from=&to=`.
Ekspor/impor: `GET /api/admin/tenants/export.csv` (M), `POST /api/admin/tenants/import.csv?dryRun=1` (S).
Backup: `POST /api/admin/backup/run` (superadmin; memanggil skrip yang sama dengan cron).

---

## 5. Format snapshot (kontrak publish ↔ kiosk/HP)

### 5.1 File yang ditulis publisher
```
data/directory.json             ← live (dibaca js/data.js lama & baru)
data/promos.json                ← live kanal promo
data/status.json                ← live kanal status
data/version.json               ← {"directory":{…},"promos":{…},"status":{…}} (sama dengan /api/version tanpa serverTime)
data/releases/<version>/…       ← arsip semua rilis
media/pub/floors/<floorId>.<sha8>.svg   ← SVG lantai hasil publish (nama ber-hash → cache immutable)
```

### 5.2 `directory.json` — field yang WAJIB tetap ada (dipakai `js/data.js`, `js/route.js`, `js/map.js`, `js/kiosk.js`, `js/phone.js`, `js/search.js`, `js/i18n.js`)
| Objek | Field lama (tipe sama, makna sama) |
|---|---|
| `meta` | `generated` (ISO), `source` (`"cms"`), `mapNorthDeg` (number\|null), `notes` (array) |
| `floors[]` | `id`, `name` (=name_en), `short`, `level`, `building`, `svg` (path relatif app root, sekarang `media/pub/floors/…`), `viewBox` [x,y,w,h], `unitScale`, `focus` {building:[x,y,w,h]} |
| `categories[]` | `id`, `name` (=name_en), `icon` |
| `tenants[]` | `id`, `name` (nama tampilan), `brand`, `category`, `floor`, `building`, `x`, `y`, `node` (`"n<id>"`), `logo` (path\|null), `phone` (E.164\|null), `url` (https\|null), `desc` (string\|null = desc_en ?? desc_id), `hours` (string tampilan\|null, mis. `"10:00–22:00"` atau `"Sen–Jum 10:00–22:00 · Sab–Min 10:00–23:00"`), `keywords` (array), `srcId` |
| `kiosks[]` | `id`, `name`, `floor`, `building`, `x`, `y`, `node`, `facingDeg`, `srcId` |
| `amenities[]` | `id`, `type`, `name`, `floor`, `building`, `x`, `y`, `node`, `toFloors` (array), `connectors` (array) |
| `graph.nodes[]` | `{id:"n<id>", floor, x, y}` |
| `graph.edges[]` | `[from, to, cost, type]` dengan `type ∈ walk, lift, stairs, crossing, escalator-up, escalator-down` |

Semua koordinat dibulatkan 2 desimal, cost 2 desimal. Urutan array stabil (sort id) agar diff ringan.

### 5.3 Field baru (additive; klien lama mengabaikannya)
```jsonc
{
  "meta": { "schema": 2, "version": "D0042-202610051530", "publishedAt": "…", "tzOffsetMin": 480,
            "mallHours": {"1":[["10:00","22:00"]], "…":[]},
            "config": { "idleTimeoutSec": 60, "metersPerUnit": 0.7, "walkSpeedMps": 1.2,
                        "escalatorSecPerLevel": 25, "liftSecPerTrip": 60, "publicBase": "https://directory.<domain>/bsb-directory" } },
  "floors":     [{ "…lama…", "nameEn": "…", "nameId": "…", "northDeg": null }],
  "categories": [{ "…lama…", "nameEn": "…", "nameId": "…", "color": "#E07A3F", "sort": 1 }],
  "tenants":    [{ "…lama…", "unit": "UG-12A", "status": "open|coming_soon|temp_closed",
                   "statusNote": {"en":"…","id":"…"} | null, "descEn": null, "descId": null,
                   "hoursWeek": {"1":[["10:00","22:00"]], "7":[]} | null, "hoursNote": {"en","id"} | null,
                   "social": {"instagram":"…","tiktok":null,"facebook":null,"whatsapp":null},
                   "openingDate": null, "hasUnit": true, "logo2x": "…" | null }],
  "kiosks":     [{ "…lama…", "defaultLang": "en", "attractLang": "en", "clientType": "windows_pc", "perfMode": "auto" }],
  "amenities":  [{ "…lama…", "kind": "connector|poi", "bank": "esc-a-penta" /*connector*/,
                   "nameEn": "…", "nameId": "…", "icon": "bath", "detail": {"en","id"} | null,
                   "wheelchair": false, "gender": "all", "ruleKey": "A12" | null }],
  "amenityTypes": [{ "id": "toilet", "nameEn": "Toilets", "nameId": "Toilet", "icon": "bath", "color": "#2F5BEA", "home": true, "sort": 1 }],
  "graph": {
    "nodes": [ … ],
    "edges": [ ["n18","n110",19.2,"escalator-up","L3"], ["n1","n2",7.61,"walk"] ],
    "rules": { "L3": { "label": {"en":"Escalator B · Pentacity LG→GF","id":"Eskalator B · Pentacity LG→GF"},
                       "hours": {"1":[["10:00","21:30"]], "2":[["10:00","21:30"]], "…":[]} },
               "E1201": { "label": {…}, "hours": {…} } }
  },
  "i18n": { "en": { "welcome": "Welcome to" }, "id": {} }
}
```

### 5.4 Aturan ekspor graph & konektor (publisher)
1. Edge walk: ekspor hanya `is_enabled=1`; cost = `cost_override ?? round(len × floor.unit_scale, 2)`. Elemen ke-5 `"E<id>"` diberikan bila edge punya `schedule_id` **atau** punya closure yang belum berakhir; edge lain diekspor 4 elemen (hemat ukuran). Closure edge yang dibuat setelah publish terakhir ditangani instan lewat `status.json.edgeOverrides` (catatan 7).
2. Leg nonaktif (`is_enabled=0`) atau bank nonaktif → **tidak diekspor**.
3. Leg eskalator/travelator: `both` → dua edge: `[lower, upper, c, "escalator-up", "L<id>"]` dan `[upper, lower, c, "escalator-down", "L<id>"]`; `up` → hanya yang pertama; `down` → hanya yang kedua. Travelator diekspor sebagai `escalator-*` (aksesibel mengecualikannya; konservatif).
4. Leg lift: satu edge `[lower, upper, c, "lift", "L<id>"]` (tak berarah). Leg tangga: `"stairs"`. Leg bridge: `"crossing"`.
5. **Setiap leg selalu mendapat ruleKey `L<id>`** (agar closure live dari `status.json` bisa menarget tanpa publish ulang directory). `graph.rules["L<id>"]` selalu berisi `label`; `hours` hanya jika jadwal efektif (leg → bank) ada.
6. Stop → `amenities[]` dengan `kind:"connector"`, `id = public_id`, `type` = `escalator|lift|stairs|crossing` (bridge diekspor sebagai `crossing` demi kompatibilitas), `name` = bank.name_en, `toFloors` = floor id stop seberang dari leg yang **diekspor** (unik, urut level), `connectors` = `src_key` leg terkait (atau `"L<id>"` bila null). **Stop tanpa leg yang diekspor tidak diekspor** (kiosk lama tidak lagi diarahkan ke eskalator buntu).
7. Closure pada edge koridor: publisher status selalu menulis pasangan node edge tsb ke `status.json.edgeOverrides: [["n12","n13"]]` selama closure aktif (efek instan, tidak bergantung key). Router baru menangani `edgeOverrides` dan key `E<id>`.
8. POI → `amenities[]` `kind:"poi"`, `toFloors: []`, `connectors: []`, `ruleKey: "A<n>"` bila punya jadwal. Node POI tidak boleh sama dengan node stop (validator), dan `js/data.js` baru hanya mengindeks `amenityByNode` untuk `kind !== 'poi'`.
9. Tenant `status=closed` atau `is_published=0` → tidak diekspor. Logo = brand logo kecuali override.
10. SVG publish: muat SVG sumber (sudah tersanitasi), untuk setiap tenant terpublish dengan `unit_shape_id`: set elemen itu `id="unit-<tenantId>"`, `data-tenant="<tenantId>"`, tambah class `unit`; hapus atribut `data-tenant`/id `unit-*` dari elemen yang tidak lagi ditautkan; prefiks semua id lain yang belum berprefiks dengan `<floorId>--` (perbarui `url(#…)` & `href="#…"` yang merujuk). Simpan ke `media/pub/floors/<floorId>.<sha8>.svg`.

### 5.5 `promos.json`
```json
{ "version":"P0007-202610051200","generated":"…",
  "featured":["uniqlo-gf","h-and-m-gf","starbucks-gf-penta"],
  "promos":[{"id":12,"slot":"attract-hero","kind":"image|video|text|event",
    "media":"media/promos/9ac1….webp","poster":"media/promos/….webp","bg":"#2F5BEA",
    "title":{"en":"Weekend Fashion Week","id":"Weekend Fashion Week"},"sub":{"en":"…","id":"…"},
    "link":{"type":"tenant","ref":"uniqlo-gf"},
    "from":"2026-10-01T00:00:00+08:00","to":"2026-10-31T23:59:59+08:00",
    "days":[1,2,3,4,5,6,7],"time":["10:00","22:00"],"durationSec":8,"weight":5,"targets":"*"}],
  "events":[{"id":3,"title":{…},"desc":{…},"media":"…","from":"…","to":"…",
    "location":{"type":"tenant","ref":"fun-world-ff-penta"} ,"onAttract":true}] }
```
`targets` = `"*"` atau array id kiosk. Promo yang `to` sudah lewat tidak diekspor. Event `onAttract` diekspor juga sebagai promo `kind:"event"`.

### 5.6 `status.json`
```json
{ "version":"S0121-202610051531","generated":"…",
  "closures":[{"key":"L5","dir":"down","from":"2026-10-05T10:00:00+08:00","to":null,
     "label":{"en":"Escalator A · Pentacity GF↔UG","id":"Eskalator A · Pentacity GF↔UG"},
     "reason":{"en":"Maintenance","id":"Perawatan"}}],
  "edgeOverrides":[],
  "amenityClosures":["toilet-gf-penta-1"],
  "notice":{"level":"warning","text":{"en":"…","id":"…"},"to":"…","kiosks":"*"} }
```
Hanya closure yang `to` null atau di masa depan. Closure bank diekspand ke semua `L<id>` miliknya.

### 5.7 Perubahan kecil yang dibutuhkan `js/route.js` (WP-C)
Tetap kompatibel dengan snapshot lama (tanpa elemen ke-5 & tanpa `rules`).

```js
// Router(D, opts) — opts.status = isi status.json (boleh null)
function Router(D, opts) {
  this.D = D; this.cfg = window.BSB_CONFIG || {};
  this.status = (opts && opts.status) || null;
  this.tz = ((D.meta && D.meta.tzOffsetMin) != null ? D.meta.tzOffsetMin : 480) * 60000;
  this._rebuild(Date.now());
}
Router.prototype._rebuild = function (now) {
  this.now = now;
  this.closedSig = this._closedSignature(now);
  this.adj = { false: this._build(false, true), true: this._build(true, true) };
  this.adjAll = { false: this._build(false, false), true: this._build(true, false) }; // abaikan jadwal/closure (untuk alasan gagal)
  this.cache = {};
};
// panggil tiap 60 dtk & sebelum plan(); rebuild hanya jika set edge tertutup berubah
Router.prototype.refresh = function (now) {
  now = now || Date.now();
  if (this._closedSignature(now) !== this.closedSig) this._rebuild(now);
};
Router.prototype.setStatus = function (status) { this.status = status; this._rebuild(Date.now()); };

function edgeDir(t) { return t === 'escalator-up' ? 'up' : t === 'escalator-down' ? 'down' : 'both'; }
Router.prototype.edgeOpen = function (e, now) {
  var key = e[4], rules = this.D.graph.rules || {}, st = this.status;
  if (st && st.edgeOverrides) for (var i = 0; i < st.edgeOverrides.length; i++) {
    var o = st.edgeOverrides[i]; if ((o[0] === e[0] && o[1] === e[1]) || (o[0] === e[1] && o[1] === e[0])) return false;
  }
  if (!key) return true;
  var r = rules[key];
  if (r && r.hours && !inHours(r.hours, now + this.tz)) return false;
  var cl = st && st.closures || [];
  for (var j = 0; j < cl.length; j++) {
    var c = cl[j]; if (c.key !== key) continue;
    var from = Date.parse(c.from), to = c.to ? Date.parse(c.to) : Infinity;
    if (now >= from && now < to && (c.dir === 'both' || c.dir === edgeDir(e[3]))) return false;
  }
  return true;
};
// hours: {"1":[["10:00","22:00"]],…}; t = epoch ms sudah digeser ke WITA → pakai getUTC*
function inHours(hours, t) {
  var d = new Date(t), dow = d.getUTCDay() || 7, m = d.getUTCHours() * 60 + d.getUTCMinutes();
  var check = function (day, mm) {
    var iv = hours[String(day)] || [];
    for (var i = 0; i < iv.length; i++) {
      var a = toMin(iv[i][0]), b = toMin(iv[i][1]);
      if (b > a ? (mm >= a && mm < b) : (mm >= a || mm < b)) return true; // b<a = lewat tengah malam
    }
    return false;
  };
  return check(dow, m);
}
function toMin(s) { var p = s.split(':'); return +p[0] * 60 + +p[1]; }

Router.prototype._build = function (accessible, filtered) {
  var adj = {}, self = this, now = this.now;
  this.D.graph.nodes.forEach(function (n) { adj[n.id] = []; });
  this.D.graph.edges.forEach(function (e) {
    var a = e[0], b = e[1], c = e[2], t = e[3];
    if (accessible && (t.indexOf('escalator') === 0 || t === 'stairs')) return;
    if (filtered && !self.edgeOpen(e, now)) return;
    adj[a].push([b, c, t]);
    if (t.indexOf('escalator') !== 0) adj[b].push([a, c, t]);
  });
  return adj;
};
// dijkstra(src, accessible, all) memakai this.adjAll bila all=true; cache key menyertakan all.
// plan(): this.refresh(); jika path null → coba path dengan all=true; jika ada → return
//   { ok:false, reason:'closed', closed:[label dari rules/status untuk edge yang tertutup di jalur itu] }
//   kalau tidak ada juga → { ok:false, reason:'noroute' }.
// nearestAmenity(): lewati amenity kind 'poi' yang ada di status.amenityClosures.
```
`_closedSignature(now)` = string gabungan key edge yang tertutup saat `now` (iterasi edge berkey saja; ±80 edge → murah). Kiosk menampilkan `reason:'closed'` sebagai: "Eskalator A · Pentacity sedang perawatan. Rute alternatif tidak tersedia — silakan ke Information Desk." (string i18n baru `routeClosed`).

### 5.8 Perubahan kecil `js/data.js` (WP-C)
- `amenityByNode` hanya untuk `a.kind !== 'poi'` (snapshot lama tanpa `kind` = connector).
- `B.loadData()` juga memuat `data/promos.json` & `data/status.json` (gagal → `null`, jangan blokir) dan menyimpan salinan ketiganya ke `localStorage` (`bsb-snap-directory`, …) sebagai fallback tanpa SW.
- `D.i18n` di-merge ke kamus `js/i18n.js` (override); `B.catName` memakai `cat.nameId/nameEn` bila ada.
- Kategori: `B.CAT_COLORS[c.id]` → fallback `c.color`.

---

## 6. Perubahan sisi kiosk & HP (WP-C)

### 6.1 Identitas kiosk
- Urutan sumber: URL `?kiosk=<id>&key=<token>` → simpan ke `localStorage` (`bsb-kiosk-id`, `bsb-kiosk-key`) → `config.DEFAULT_KIOSK`. URL selalu menang (TV tanpa config lokal cukup memakai URL di launcher).
- Setelah disimpan, `history.replaceState` menghapus `key` dari address bar (tidak tampil di layar).
- Profil (`clientType`, `perfMode`, `defaultLang`) diambil dari `D.kiosks[]` dan dari respons ping (lebih baru).

### 6.2 Sinkronisasi versi (`js/sync.js`, baru)
- Setiap `POLL_SEC` (default 60 dtk, jitter ±10 dtk): `POST /api/kiosk/ping` (dengan token) — respons memuat versi 3 kanal + command. Tanpa token: `GET /api/version`.
- **directory berubah** → prefetch `directory.json?v=<ver>` + semua aset yang dirujuk (SVG lantai, logo) ke cache (`caches.open('bsb-data-<ver>')` atau `fetch` biasa bila tanpa SW). Setelah **semua** prefetch sukses dan kiosk sedang di layar atraksi (idle) → `location.reload()`. Jika pengunjung sedang memakai → tunggu idle berikutnya. Gagal prefetch → coba lagi siklus berikutnya; **tidak pernah reload bila server tidak terjangkau**.
- **promos berubah** → fetch `promos.json`, ganti playlist tanpa reload.
- **status berubah** → fetch `status.json`, `router.setStatus()`, render ulang marker konektor (ikon "dalam perawatan") dan banner notice. Tanpa reload.
- `router.refresh()` dipanggil tiap 60 dtk (jadwal eskalator berganti jam).
- Command: `reload` → reload saat idle (≤ 2 menit, paksa setelahnya); `identify` → overlay id kiosk 15 dtk; `clear_cache` → hapus semua `caches` + unregister SW + reload. Kirim `POST /api/kiosk/ack`.
- `minAppBuild` > `APP_BUILD` lokal → reload saat idle (shell baru).

### 6.3 Offline cache — Service Worker (`sw.js` di root app, scope `/bsb-directory/`)
Syarat: **secure context** (HTTPS atau `localhost`). Di LAN dicapai lewat domain asli + sertifikat valid + DNS internal (§8.4). Tanpa HTTPS, SW tidak terpasang → fallback §6.4.
- Precache app shell (versi `APP_BUILD`): `index.html`, `m/index.html`, `config.js`, `css/*.css`, `js/*.js`, `assets/vendor/*`, `assets/fonts/*`, `assets/brand/*`.
- Strategi:
  - `data/directory.json`, `data/promos.json`, `data/status.json`, `api/version`: **network-first, timeout 3 dtk**, fallback cache.
  - `data/directory.json?v=…`, `media/**`, `assets/logos/**`, `data/floors/**`: **cache-first** (nama/versi immutable).
  - `api/kiosk/*`, `api/telemetry*`, `api/admin/*`, `cms/**`: **network-only** (tidak pernah di-cache).
  - Navigasi (`index.html`, `m/`): network-first 3 dtk → cache.
- Bersihkan cache data lama: simpan 2 versi terakhir.
- HP (`m/`) juga mendapat SW yang sama (berguna saat sinyal lemah di basement/LG).

### 6.4 Fallback tanpa Service Worker (browser TV lama / HTTP)
1. Resiliensi utama = **server di LAN** (internet putus tidak berpengaruh).
2. Snapshot terakhir disimpan di `localStorage` (directory ±210 KB, promos, status). Bila fetch gagal saat runtime, `B.loadData()` memakai salinan ini.
3. Kiosk tidak pernah reload sendiri kecuali `sync.js` sudah memverifikasi server terjangkau (`GET /api/version` sukses **dan** prefetch berhasil).
4. Header HTTP: aset ber-hash `Cache-Control: max-age=31536000, immutable`; shell `max-age=300, stale-while-revalidate=86400` → cache HTTP browser membantu setelah reboot.
5. Boot saat server mati tetap akan gagal di browser tanpa SW → itu sebabnya profil TV merekomendasikan Android + Fully Kiosk (punya cache offline & auto-reload saat jaringan pulih) — §6.8.
6. Halaman error kecil (`offline.html` di-precache bila SW ada; bila tidak, `index.html` menampilkan layar "Menghubungkan…" dengan retry tiap 30 dtk bila `loadData` gagal dan tidak ada salinan lokal).

### 6.5 Telemetri (`js/telemetry.js`, baru)
- `BSB.track(type, fields)` → antrean di IndexedDB (fallback `localStorage` ring buffer), maks 5.000 event (drop terlama).
- Flush tiap 60 dtk atau ≥ 50 event, batch ≤ 500, `POST /api/telemetry`; sukses → hapus. Gagal → backoff (1, 2, 5, 10 menit).
- Sesi: `sid` acak 12 char dibuat saat atraksi ditutup (sentuhan pertama), berakhir saat idle → `session_end`.
- QR "Lanjutkan di HP": URL ditambah `&s=<sid>` untuk mengukur konversi.
- HP (`js/phone.js`): `sendBeacon('/api/telemetry/phone', …)` untuk `qr_scan` (load halaman dengan `k`&`t`), `nav_start`, `compass_on/denied`, `arrived`, `abandon` (pagehide sebelum arrived).

### 6.6 Promo, featured, POI, notice di kiosk (`js/promos.js`, baru + patch kecil `js/kiosk.js`, `js/map.js`, `js/icons.js`)
- Playlist `attract-hero` dari `promos.json` (filter §2.10, smooth WRR). `kind:image` → `<img>` cover; `video` → `<video muted playsinline autoplay>` lalu lanjut saat `ended` (maks `durationSec`); mode lite → poster saja; `text`/`event` → kartu warna seperti sekarang (tanpa label "Placeholder"). Tap promo dengan `link` tenant → buka detail. Impresi ≥ 1 dtk → `promo_imp`.
- `attract-fullscreen` (S): tiap 4 promo hero, takeover 1920×1080 selama `durationSec`.
- Featured: `promos.json.featured` → fallback `config.featured`.
- Beranda "Fasilitas": tombol dari `amenityTypes` dengan `home:true` yang punya amenity terpublish (lift/eskalator/jembatan tetap ada); maks 6.
- `js/map.js`: render POI (`kind:'poi'`) dengan ikon tipe; konektor tertutup (status) diberi badge abu-abu + ikon `wrench`.
- `js/icons.js`: tambah ikon Lucide (lucide-static 0.460.0, ISC): `bath`, `square-parking`, `banknote`, `heart-pulse`, `plug-zap`, `cigarette`, `package-search`, `car-taxi-front`, `door-open` (sudah ada), `wrench`, `info` (sudah ada), `baby` (sudah ada) dan SVG kustom `musholla` (kubah sederhana, gaya stroke Lucide).
- Notice: banner atas (info/warning); `emergency` = overlay penuh merah dengan teks dua bahasa, menimpa atraksi & UI sampai berakhir.
- Tenant `temp_closed`/`coming_soon`: badge di daftar & detail; `hoursWeek` → tampil "Buka hari ini 10:00–22:00".

### 6.7 Kompas HP
`north = floor.northDeg ?? meta.mapNorthDeg ?? config.mapNorthDeg ?? kalibrasi localStorage`. Instruksi langkah pertama boleh memakai `kiosk.facingDeg` ("Dari layar ini, jalan ke kanan") bila tidak null.

### 6.8 Profil klien kedua: **Smart TV touchscreen**
Kebutuhan dari user: beberapa titik kiosk memakai smart TV touchscreen dengan browser bawaan (OS belum diketahui: Samsung Tizen, LG webOS, atau Android TV).

**(1) Resiliensi offline — "kalau internet putus, mati?"** Tidak, bila desainnya seperti ini:
- Kiosk/TV memuat aplikasi dari **server LAN mall** (`https://directory.<domain>` di-resolve ke IP LAN oleh DNS statis MikroTik). Internet putus → LAN tetap jalan → kiosk normal. Yang terdampak hanya HP pengunjung (lewat Cloudflare) dan perpanjangan sertifikat (tiap 60–90 hari, ada margin 30 hari).
- Server LAN mati → Service Worker menyajikan shell + snapshot terakhir + SVG + logo dari cache; telemetri antre.
- Browser TV tanpa SW (atau SW diblokir) → fallback §6.4; risiko tersisa = TV menyala ulang saat server mati. Mitigasi: Android + Fully Kiosk (opsi "Load cache when offline" + "Reload on network reconnect" + "Reload on error"), UPS untuk server & switch.
- Catatan: SW **wajib** secure context. HTTP ke IP LAN (`http://10.x.x.x`) = tanpa SW. Jangan pakai sertifikat self-signed di TV (biasanya tidak bisa install root CA di Tizen/webOS).

**(2) Mode performa `lite`** (CPU TV lemah, Chromium lama):
- `js/perf.js` (baru, dimuat paling awal) menentukan mode: URL `?perf=lite|full` > CMS `perfMode` (`full|lite`) > `auto`. `auto` = lite bila salah satu: `navigator.deviceMemory <= 2`, `hardwareConcurrency <= 4`, versi Chromium dari UA < 90, `CSS.supports('backdrop-filter','blur(1px)')` false, atau rata-rata frame > 25 ms selama 3 dtk animasi atraksi pertama (switch otomatis + event `perf_switch`). `clientType: smart_tv` dengan `perfMode: auto` → mulai dari lite.
- Efek lite (`html.lite` + `css/lite.css`, baru): tanpa `backdrop-filter`, tanpa `filter: blur()` (blob atraksi statis/dihilangkan), `box-shadow` → border 1px, tanpa `mask-image` gradient, marquee logo = grid statis berganti halaman tiap 6 dtk (tanpa animasi transform terus-menerus), `.amen rect`/`.conn rect` tanpa `filter:url(#mvShadow)`.
- GSAP: durasi transisi dipotong (≤ 250 ms) atau `gsap.set` langsung; fly-to kamera = lompat + fade 150 ms; **animasi rute**: polyline langsung tergambar penuh, hanya titik penanda bergerak (tanpa glow & tanpa animasi `stroke-dashoffset` per frame); transisi antar-lantai crossfade saja.
- SVG peta: `shape-rendering: optimizeSpeed`, `text-rendering: optimizeSpeed` saat pan/zoom; jangan "warm" semua 8 SVG di latar (muat saat diperlukan, maks 3 di cache DOM).
- Cap `devicePixelRatio`: layout dihitung untuk 1920×1080; bila TV melaporkan DPR > 1 dengan viewport 960×540 atau 4K, skala tetap via `zoom`/`transform` dan semua `<canvas>`/raster (QR) dibatasi DPR ≤ 1.5.
- Promo video → poster gambar; QR SVG tetap.
- Target uji minimum: **Chromium 68** (pointer events, fetch, URLSearchParams, CSS variables). Perkiraan engine: webOS 5 ≈ Chr 68, webOS 6 ≈ Chr 79, webOS 22 ≈ Chr 87; Tizen 5.5 ≈ Chr 69, Tizen 6.5 ≈ Chr 85, Tizen 7 ≈ Chr 94 (angka perlu diverifikasi per model). Di bawah Chr 68 (mis. webOS 4 ≈ Chr 53, Tizen 4 ≈ Chr 56): **tidak didukung** → pasang Android box/mini PC. Kode kiosk tetap ES5-style (var/function) seperti sekarang; dilarang menambah sintaks ES2017+ di file kiosk tanpa transpile (cek: optional chaining `?.`, `??`, class fields).
- Uji: Playwright/Chromium dengan CPU throttling 6× + `--force-device-scale-factor` + emulasi UA lama; target ≥ 30 fps animasi rute di lite.

**(3) Batasan lockdown browser TV** dan rekomendasi per OS:
| OS | Masalah | Rekomendasi |
|---|---|---|
| **Android TV / Google TV / panel interaktif (IFP) berbasis Android** | Browser bawaan tidak bisa kunci | **Pilihan utama**: install **Fully Kiosk Browser** (lisensi Plus per perangkat): kiosk lock, start on boot, sembunyikan bar, jadwal sleep/wake, auto-reload saat error/reconnect, remote admin, cache offline, WebView Chromium yang bisa di-update. Set "Start URL" = launch URL kiosk dengan token. Banyak "smart TV touchscreen" komersial ternyata IFP Android — cek dulu. |
| **Samsung Tizen** | Browser TV konsumen: address bar/exit tidak bisa disembunyikan, tidak ada autostart URL, Auto Power Off 4 jam | Hanya layak bila model **Samsung Smart Signage (SSSP/Tizen signage)**: pakai **URL Launcher** + MagicInfo/"Custom Home" untuk autostart dan Kiosk/Lock mode. TV konsumen → tambahkan Android box/mini PC via HDMI + USB touch. |
| **LG webOS** | Sama; browser tidak bisa autostart/terkunci | Hanya layak bila **LG webOS Signage/Pro:Centric (hotel mode)**: pakai **SI/URL Launcher**, "Lock mode", power-on schedule. TV konsumen → Android box/mini PC. |
- Wajib di semua TV: matikan **Auto Power Off / Eco "No signal" / sleep timer** (TV konsumen biasanya mati sendiri setelah 4 jam tanpa remote), set **On Timer/Off Timer** sesuai jam mall, "Power On Behaviour = last input/app", matikan update otomatis firmware di jam operasional, matikan screensaver.

**(4) Kualitas sentuh**: overlay IR/TV sering hanya single-touch atau emulasi mouse → pinch tidak ada. Tombol zoom +/− & "locate" di peta **sudah ada** dan wajib tetap tampil di semua mode. Tambahan: tap target ≥ 56 px di lite, abaikan `hover` (`@media (hover:hover)` saja), `contextmenu` sudah diblok (`js/kiosk.js`), cegah long-press seleksi (sudah `user-select:none`), kotak pencarian tetap **tombol** (bukan `<input>`) supaya keyboard sistem TV tidak muncul.

**(5) Identitas** via URL launcher (`?kiosk=…&key=…`) karena tidak ada `config.js` lokal per perangkat; QR provisioning dari CMS memudahkan memasukkan URL panjang ke TV (Fully Kiosk bisa scan QR konfigurasi).

**(6) CMS**: field `client_type` (`windows_pc|smart_tv|android_box|other`) dan `perf_mode` (`auto|full|lite`) di tabel `kiosks`; heartbeat melaporkan `userAgent`, `perfActive`, `perfReason`, `swActive`, `screen`; halaman Kiosk menampilkan badge "TV · lite (auto: deviceMemory≤2)" dan peringatan merah bila `swActive=false`.

### 6.9 Ringkas file WP-C
Baru: `sw.js`, `js/sync.js`, `js/telemetry.js`, `js/promos.js`, `js/perf.js`, `css/lite.css`, `offline.html`, `kiosk/watchdog.ps1`, `kiosk/setup-kiosk.ps1`, `kiosk/README-smart-tv.md`.
Patch: `js/route.js` (§5.7), `js/data.js` (§5.8), `js/kiosk.js` (promo/featured/POI/notice/telemetry hooks/closed-route message/identity), `js/map.js` (POI, konektor tertutup, lite), `js/phone.js` (north per lantai, beacon), `js/i18n.js` (key baru: `routeClosed`, `tempClosed`, `comingSoon`, `openToday`, `offlineRetry`, nama tipe POI fallback), `js/icons.js`, `config.js` (`API_BASE`, `POLL_SEC`, `APP_BUILD`), `index.html` & `m/index.html` (script tag baru + registrasi SW), `kiosk/start-kiosk.bat` (URL HTTPS + key).

---

## 7. Admin UX

### 7.1 Prinsip
- Token visual sama dengan kiosk (`css/base.css`: `--bg #F5F1EB`, `--surface`, `--ink`, `--accent #2F5BEA`, `--gold`, radius 22/14, font Plus Jakarta Sans dari `assets/fonts/`). `cms/css/admin.css` mengimpor token (salin variabel, jangan `@import` file kiosk yang sedang diedit agen lain).
- Layout desktop: sidebar kiri (ikon + label), header (pencarian global tenant, badge "Belum dipublish: konten · peta", tombol **Publish**), konten. Min 1280 px untuk editor peta; halaman lain responsif; **Ops Status responsif penuh (HP)**.
- SPA ringan: `cms/index.html` + hash router (`#/tenants`, `#/tenants/uniqlo-gf`, …), modul ES (`type="module"`, admin pakai Chrome/Edge modern), tanpa build step. `cms/login.html` terpisah.
- Semua form: simpan eksplisit (tombol + `Ctrl+S`), indikator "perubahan belum disimpan", error per field dari `error.fields`, toast sukses. Konflik 409 → dialog "Data diubah oleh X — muat ulang / timpa".
- Bahasa UI admin: Indonesia.

### 7.2 Daftar layar
| # | Layar | Isi utama |
|---|---|---|
| 1 | Login / ganti password | — |
| 2 | Dashboard | Kartu kiosk (online/stale/offline + mode full/lite), closure aktif, status validasi terakhir, perubahan belum dipublish per seksi, rilis live, top 5 pencarian & pencarian tanpa hasil 7 hari, kelengkapan data (tanpa logo/jam/posisi/facing/north). |
| 3 | Tenant — daftar | Tabel + filter (§2.2) + bulk + export CSV. |
| 4 | Tenant — edit | Tab: *Info* (brand+outlet), *Jam*, *Lokasi* (peta), *Media*, *Riwayat* (audit). Panel kanan: pratinjau kartu detail kiosk EN/ID. |
| 5 | Kategori | Daftar drag-urut, edit nama/ikon/warna. |
| 6 | Lantai | Daftar; edit: replace SVG (alur 2 langkah), focus box (drag rect), north dial, unit scale. |
| 7 | Editor peta (graph) | §7.4. |
| 8 | Konektor | Daftar bank per gedung + panel tumpukan lantai §7.5. |
| 9 | Ops Status (HP) | Bank → leg → saklar besar ▲/▼ "Beroperasi / Perawatan" + durasi cepat (1 jam, sampai tutup mall, sampai dibuka); notice darurat. |
| 10 | Kiosk | Daftar + peta (posisi & dial facing), profil (client type, perf mode, bahasa), provisioning token/QR/bat, command, runtime & uptime 7 hari. |
| 11 | Fasilitas | Tipe + daftar POI per lantai; tambah dengan klik peta. |
| 12 | Promo | Daftar + kalender mingguan; edit dengan **pratinjau dalam bingkai kiosk 1920×1080 diskalakan** (memuat `../index.html?attract=1&previewPromo=<json>`… cukup render ulang kartu dengan CSS token yang sama); target kiosk; statistik impresi. |
| 13 | Event | Daftar + edit. |
| 14 | Featured | Daftar urut drag & drop dengan logo. |
| 15 | i18n | Tabel key/default/override EN/ID. |
| 16 | Publish | Tab *Directory* / *Promo*: tombol Validasi, laporan error/warning (klik → loncat ke entitas), diff per seksi, catatan, Publish. Tab *Riwayat*: rilis, unduh, rollback. |
| 17 | Analitik | §2.16, filter tanggal & kiosk, export CSV. |
| 18 | Audit log | Tabel + filter. |
| 19 | Media | Grid + upload drag & drop + "dipakai oleh". |
| 20 | User & Settings | User CRUD (superadmin), settings (jam mall, biaya konektor, idle timeout, public base, north global, retensi), tombol backup. |

### 7.3 Komponen peta bersama (`cms/js/mapcanvas.js`)
- **Jangan** memakai `js/map.js` kiosk (milik agen lain, logika kamera kiosk). Buat viewer sendiri: SVG lantai di-inline (`<object>` tidak bisa diklik per elemen), satu `<g id="overlay">` dalam koordinat viewBox yang sama; pan (drag tengah/spasi+drag), zoom roda mouse ke kursor, tombol fit/focus per gedung, pemilih lantai (level → sheet per gedung).
- Konversi klik → koordinat SVG: `pt.matrixTransform(svg.getScreenCTM().inverse())`.
- Layer toggle: tenant pins, nama tenant, graph, konektor, kiosk, POI, unit shapes (hover outline).
- **Tempatkan tenant**: mode "Tempatkan" → klik → pin + snap: cari proyeksi terdekat ke edge walk (≤ 40 unit × 1/unitScale); tampilkan garis putus-putus; Simpan → `graph/ops` (`splitEdge` + `addNode` spur bila jarak > 3 unit + `addEdge` + `attach`) dalam satu batch, diikuti `PUT tenant` x,y. Shift+klik = tanpa snap (pilih node manual).
- **Tautkan unit**: mode "Pilih unit" → hover menyorot path/rect/polygon; klik → `unitShapeId`. Tampilkan peringatan bila shape sudah dipakai tenant lain.

### 7.4 Editor graph (desktop saja, ≥ 1280 px)
Toolbar (shortcut): **V** Pilih/geser · **N** Tambah node (klik kosong; klik pada edge = split) · **C** Sambung (klik node A lalu B; tahan Shift untuk rantai) · **X** Hapus (node/edge terpilih; Delete) · **M** Gabung node · **K** Tandai stop konektor (klik node → pilih bank) · **T** Lampirkan (klik tenant/kiosk/POI → klik node) · **R** Uji rute (klik titik A & B → jalankan Dijkstra di browser memakai `js/route.js`? — tidak; panggil `POST /api/admin/validate/route {from,to,accessible}` → gambar jalur).
- Snap ke node ≤ 6 px layar; grid opsional. Box-select dengan drag; geser multi-node.
- Panel properti: node (id, koordinat, label, lampiran); edge (panjang, cost otomatis, override, aktif, jadwal, label, closure aktif).
- Pewarnaan: edge walk abu; nonaktif merah putus-putus; berjadwal oranye; stop konektor = lingkaran besar warna tipe dengan nomor leg; node yatim (derajat 0) merah; komponen terputus dari kiosk = kuning (hasil validasi terakhir).
- Undo/redo (Ctrl+Z / Ctrl+Shift+Z) sebagai stack op lokal; **Simpan** mengirim batch `graph/ops` (autosave tiap 30 dtk bila ada perubahan). Revision konflik → muat ulang dan tampilkan diff.
- Mini-validasi lokal saat edit: node tanpa edge, edge lintas lantai (dilarang).

### 7.5 Panel bank konektor ("tumpukan lantai")
```
 Eskalator A · Pentacity  (depan Sociolla)        [Bank aktif ●]  Jadwal: Jam mall ▾
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ 2F  Pentacity   ● stop esc-a-penta-sf-penta   [Lihat di peta]             │
 │        │  leg L8  1F↔2F   [Aktif ●]  Arah: [↕ dua arah | ↑ naik | ↓ turun] │
 │        │                  Jadwal: ikut bank ▾  Biaya 28.8  ✔ dicek 5 Okt   │
 │ 1F  Pentacity   ● stop esc-a-penta-ff-penta-2 / esc-a-penta-ff-penta      │
 │        │  leg L7  UG↔1F   [Aktif ●]  ↕                                    │
 │ UG  (gabungan)  ● stop esc-a-penta-ug-2  · ● stop esc-a-penta-ug          │
 │        │  leg L6  GF↔UG   [Aktif ●]  ↕     ⚠ closure: ↓ Perawatan s/d 18:00│
 │ GF  (gabungan)  ● stop esc-a-penta-gf                                     │
 │        ┆  leg —   LG↔GF   [Nonaktif ○]  "hanya GF↔UG, tidak ke LG — 4 Okt"│
 │ LG  Pentacity   ○ belum ada stop   [+ Tambah stop di peta]                │
 └──────────────────────────────────────────────────────────────────────────┘
```
- Baris = level (2F di atas → LG di bawah), hanya sheet gedung bank + sheet gabungan GF/UG.
- Leg digambar sebagai garis vertikal antar stop: tebal = aktif, putus-putus = nonaktif; panah ▲/▼ sesuai arah; ikon kunci pas = closure aktif.
- Kontrol per leg: toggle aktif, segmented arah, jadwal, cost override, catatan lapangan, checkbox "Sudah dicek di lapangan" (mengisi `verified_at/by`).
- Lift: kolom checkbox "berhenti di lantai ini" per baris; tombol "Regenerate legs".
- Peta mini di samping: klik stop → peta lompat ke lantai & node.
- Ringkasan validasi bank: "Tidak ada leg ke LG — tenant LG Pentacity tetap terjangkau via Eskalator B & Lift" (hasil dampak dari validator).

---

## 8. Keamanan & operasional

### 8.1 Auth & sesi
- `password_hash(PASSWORD_DEFAULT)` (bcrypt cost 11; pakai `PASSWORD_ARGON2ID` jika tersedia), `password_needs_rehash` saat login.
- Lockout §2.1; pesan login generik ("Email atau password salah").
- `session_regenerate_id(true)` setelah login; cookie flags §4.2; `session.use_strict_mode=1`.
- Header semua respons admin: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, CSP untuk `cms/`: `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-src 'self'`.
- Semua query lewat PDO prepared statement (`ATTR_EMULATE_PREPARES=false`, `ERRMODE_EXCEPTION`). Output JSON saja; UI meng-escape saat render (`textContent`, bukan `innerHTML` dengan data mentah).
- Lapisan tambahan produksi: **Cloudflare Access** (email OTP, gratis ≤ 50 user) di depan path `/bsb-directory/cms*` dan `/bsb-directory/api/admin*` untuk akses dari luar; dari LAN akses langsung tetap butuh login.

### 8.2 Keamanan upload
- Batas ukuran: logo 5 MB, gambar 10 MB, video 30 MB, SVG lantai 8 MB. Validasi MIME via `finfo` + magic bytes; ekstensi diabaikan.
- Nama file disimpan = `sha256[0:16]` + ekstensi hasil encode; folder `media/{logos,promos,events,floors,pub,tmp}`.
- `media/.htaccess`: `php_flag engine off`, `RemoveHandler .php .phtml .php5`, `<FilesMatch "\.(php|phtml|phar|pl|py|cgi|sh)$"> Require all denied </FilesMatch>`, `Header set X-Content-Type-Options nosniff`, untuk `*.svg`: `Header set Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'"`.
- **Gambar raster**: selalu decode → re-encode (membuang EXIF/payload). Urutan encoder: `imagewebp()` GD (cek `function_exists('imagewebp')` — **GD XAMPP mac PHP 8.0 di mesin dev TIDAK punya WebP**) → `cwebp` CLI (`settings.media.cwebpPath`, dev mac: `/opt/homebrew/bin/cwebp`; Windows: `C:\tools\libwebp\bin\cwebp.exe`) dipanggil dengan `escapeshellarg` setelah GD menulis PNG sementara → fallback PNG (logo) / JPEG q82 (foto) + warning di media.meta. Produksi: pastikan PHP ≥ 8.1 dengan GD WebP (build Windows resmi sudah termasuk).
- **Video**: hanya MP4 (cek box `ftyp` isom/mp42/avc1); tidak di-transcode di v1; durasi dibaca dari `mvhd` (parser kecil) — tolak > 30 dtk. Poster wajib untuk mode lite.
- **Sanitasi SVG** (`lib/SvgSanitizer.php`, whitelist, DOMDocument):
  - Tolak file yang mengandung `<!DOCTYPE` / `<!ENTITY` (anti-XXE/billion laughs) sebelum parsing; `libxml_disable_entity_loader` tidak tersedia di PHP 8 → cukup `LIBXML_NONET` tanpa `LIBXML_NOENT`/`LIBXML_DTDLOAD`.
  - Elemen diizinkan: `svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath title desc linearGradient radialGradient stop clipPath mask pattern style`. Lainnya dibuang (termasuk `script`, `foreignObject`, `image`, `iframe`, `animate*`, `set`, `a`, `metadata`, namespace `i:`/`x:` Illustrator, blob `aipgf`).
  - Atribut: buang semua `on*`; `href`/`xlink:href` hanya `#id` lokal; buang atribut berisi `javascript:`, `data:` (kecuali tidak ada), `url(` ke luar `#`.
  - `<style>`: buang `@import`, `url(` non-`#`, `expression`, `behavior`, `-moz-binding`.
  - Assign `id="shp-<n>"` ke shape tanpa id; laporkan statistik (lihat API §4.5).
  - SVG lantai di-inline di DOM kiosk → sanitasi ini wajib sebelum publish.

### 8.3 HTTPS & domain
- Kompas/motion HP butuh HTTPS (iOS mutlak). Service Worker kiosk butuh HTTPS. → Satu hostname, mis. **`directory.pentacity-bsb.com`** (domain mall sudah ada; alternatif subdomain `pamplus.id`) — keputusan akhir di open question.
- Sertifikat: **Let's Encrypt via DNS-01** (win-acme di Windows atau certbot + plugin Cloudflare DNS) dipasang di Apache server LAN (`httpd-ssl.conf`). DNS-01 tidak butuh port terbuka.
- Publik: **Cloudflare Tunnel (named tunnel, bukan quick tunnel)** dari server ke Cloudflare; publik DNS `directory.…` → tunnel. Hanya `m/`, `data/`, `media/`, `assets/`, `css/`, `js/`, `api/version`, `api/telemetry/phone`, `api/*.json` yang perlu dari internet; `cms/` & `api/admin` di balik Cloudflare Access.
- LAN: MikroTik `/ip dns static add name=directory.<domain> address=<IP server LAN>` dan kiosk memakai DNS router → kiosk tetap HTTPS meski internet putus.
- Dev: `localhost` = secure context (SW & kompas bisa diuji), HP via `cloudflared tunnel --url` seperti README.

### 8.4 Topologi deployment (rekomendasi)
```
                  Internet ── Cloudflare (DNS, Tunnel, Access) ── HP pengunjung (4G/Wi-Fi)
                                   │ tunnel (outbound dari server)
 ┌─────────────── LAN mall (VLAN kiosk khusus) ──────────────────────────────┐
 │  Server CMS (XAMPP: Apache+PHP 8.2+MariaDB, Windows/Ubuntu, UPS)           │
 │    https://directory.<domain>/bsb-directory/   (sertifikat LE, DNS-01)     │
 │        ▲ pull: version poll 60 dtk, snapshot, media                         │
 │  Kiosk Windows PC (Edge --kiosk)    Kiosk Smart TV / Android (Fully Kiosk)  │
 │  MikroTik: static DNS directory.<domain> → IP server; NTP server            │
 └────────────────────────────────────────────────────────────────────────────┘
```
- Kiosk **tidak** lagi menjalankan Apache sendiri (README lama); cukup browser. Cadangan ekstrem (C): XAMPP lokal di PC kiosk + skrip sync.
- Jaringan: kiosk di **VLAN tersendiri** (bukan hotspot pengunjung), hanya boleh ke server CMS (443) + NTP + DNS router; tidak boleh ke internet langsung (opsional untuk Windows Update via WSUS/jam maintenance). Catatan dari pengalaman jaringan mall: routing lintas interface hotspot di RB4011 butuh VLAN transit — rencanakan VLAN kiosk sejak awal bersama tim jaringan.
- Jam: semua kiosk & server sinkron NTP (MikroTik sebagai NTP); zona waktu **(UTC+08:00) WITA / Asia/Makassar**. Jadwal promo/eskalator bergantung jam lokal.
- Cron (Windows Task Scheduler / crontab): `php tools/cron.php` tiap 5 menit (rollup analitik inkremental, expire closures → republish status bila ada yang berakhir, bersihkan rate_limits), 02:00 harian (rollup final, retensi raw 180 hari / heartbeat 30 hari), 02:30 backup.

### 8.5 Checklist hardening kiosk Windows
1. Akun lokal standar "Kiosk" (bukan admin), **auto-login** (Sysinternals *Autologon*, password terenkripsi LSA), BitLocker opsional.
2. Edge kiosk: `start-kiosk.bat` dengan URL HTTPS + `--edge-kiosk-type=fullscreen` (**jangan** `public-browsing`: itu InPrivate → cache SW & localStorage hilang) + `--user-data-dir` tetap. Alternatif terkunci: **Assigned Access** (Windows 10/11 Pro) single-app Edge kiosk.
3. Autostart: Task Scheduler "At log on" (lebih andal dari folder Startup), delay 20 dtk.
4. **Watchdog** `kiosk/watchdog.ps1` (Task Scheduler tiap 1 menit): bila `msedge` tidak jalan → jalankan bat; bila `GET https://…/api/health` gagal 10× berturut-turut → tidak melakukan apa-apa (SW menangani); restart Edge harian 04:30; reboot mingguan Minggu 05:00.
5. Gestur: Settings → Touch → matikan 3/4-finger gestures; registry `HKLM\SOFTWARE\Policies\Microsoft\Windows\EdgeUI\AllowEdgeSwipe = 0` (matikan edge swipe); matikan touch keyboard auto-invoke; matikan notifikasi & Focus Assist "Alarms only"; sembunyikan taskbar.
6. Kebijakan Edge (registry/GPO): `URLAllowlist` = domain directory, `URLBlocklist` = `*`, `DeveloperToolsAvailability=2`, `DownloadRestrictions=3`, `PrintingEnabled=0`, `TranslateEnabled=0`, `PasswordManagerEnabled=0`, `RestoreOnStartup` tidak dipakai, `HideFirstRunExperience=1`, `AutoplayAllowed=1`.
7. Daya: plan "never sleep/never turn off display" saat jam mall; **jadwal**: Task Scheduler 22:30 layar mati (`powercfg`/`nircmd monitor off`) atau shutdown; BIOS "Restore on AC power loss = On" + RTC wake 09:00 (atau Wake-on-LAN dari server).
8. Windows Update: active hours 08:00–23:00, restart hanya di jendela 03:00–05:00; tunda feature update.
9. Remote support: MeshCentral self-hosted di server CMS (gratis) atau AnyDesk unattended dengan password kuat.
10. Port USB: nonaktifkan storage (`USBSTOR Start=4`), BIOS password, casing terkunci.

### 8.6 Backup
- `tools/backup.ps1` (Windows) / `tools/backup.sh`: `mysqldump --single-transaction --routines bsb_directory | gzip` → `D:\bsb-backup\db\bsb_YYYYMMDD_HHmm.sql.gz`; `robocopy media` & `data\releases` (mirror inkremental).
- Retensi: 14 harian + 8 mingguan + 12 bulanan. Salinan off-site harian (Google Drive for Desktop / rclone ke Drive perusahaan).
- Uji restore bulanan ke DB `bsb_directory_restoretest` (checklist di README CMS).
- Rilis snapshot di `data/releases/` adalah cadangan kedua: kiosk tetap bisa dilayani dari rilis terakhir meski DB rusak.

---

## 9. Pertanyaan terbuka & data lapangan

### 9.1 Pertanyaan untuk tim mall
1. **Domain**: pakai `directory.pentacity-bsb.com`, subdomain `pamplus.id`, atau domain lain? Siapa pengelola DNS (perlu Cloudflare untuk Tunnel + DNS-01)?
2. **Server**: PC/server mana di ruang server untuk CMS (spesifikasi minimal: 4 core, 8 GB RAM, SSD 256 GB, UPS)? Windows atau Ubuntu?
3. **Jaringan**: bisakah dibuat VLAN kiosk + static DNS di MikroTik? Titik LAN tersedia di tiap lokasi kiosk (atau Wi-Fi)?
4. **Smart TV**: merk, model persis, OS & versi (Tizen/webOS/Android TV/IFP Android), apakah seri **signage/komersial** atau konsumen, resolusi, jenis touch (built-in vs frame IR, jumlah titik sentuh), port USB/HDMI, bisa pasang APK?
5. Jumlah & lokasi final kiosk (7 titik "You are here" di data: `lg-pentacity, gf-ewalk-left, gf-ewalk-right, gf-pentacity, ug-ewalk, ug-pentacity, ff-pentacity`) — ada kiosk di 1F E-Walk, 2F, LG E-Walk? Mana yang PC, mana yang TV?
6. Siapa orang/role untuk tiap peran §1 (nama + email)? Siapa yang berhak publish?
7. Jam operasional mall per hari (termasuk Jumat/akhir pekan/hari libur), jam eskalator LG/parkir, jam lift.
8. Fasilitas yang ingin tampil (daftar §2.9) — ada ruang laktasi, area merokok, charging station, wheelchair rental, lost & found di Information Desk?
9. Konfirmasi duplikat data (DATA_REPORT §7.4): dua Skechers UG Pentacity? MR.DIY LG & 2F? Andalas UG & 1F? XXI E-Walk 1F & 2F? Matahari 1F & 2F (satu toko dua lantai)?
10. Koridor 2F E-Walk & lift 2F E-Walk (DATA_REPORT §6.1–6.2); hubungan langsung LG Pentacity ↔ LG E-Walk ada atau tidak?
11. Kebijakan iklan: apakah promo pihak luar (non-tenant) diperbolehkan, tarif per slot, perlu laporan impresi ke pengiklan?
12. Bahasa default kiosk: atraksi selalu English (sudah diputuskan); UI default English — benar untuk semua kiosk?
13. Siapa yang menerima notifikasi kiosk offline (email/WhatsApp)? (v2: alert otomatis.)

### 9.2 Data lapangan yang dikumpulkan
- **Arah utara** (`north_deg`) per sheet lantai: berdiri di titik yang dikenali di peta, arahkan kompas HP ke "atas" peta, catat derajat (3 kali, ambil rata-rata); minimal GF & UG gabungan + tiap sheet per gedung.
- **Facing tiap kiosk**: arah layar menghadap (derajat kompas) + foto dari depan kiosk.
- **Jarak terukur** 2–3 per lantai (laser/meteran) untuk koreksi `unit_scale`/`metersPerUnit`.
- **Fasilitas**: posisi toilet, musholla, ATM (bank apa), information desk, pintu parkir, lobby/exit, ruang laktasi, P3K, charging — tandai di print denah.
- **Tenant**: jam buka per tenant (atau "ikut mall"), nomor unit, status (buka/tutup/coming soon), logo resmi (PNG transparan ≥ 600 px), 5 tenant tanpa logo (Barra's, Logo, Lilla Label, Sneakers, Food Court), Instagram resmi.
- **Eskalator & lift** — tabel di bawah, cetak dan centang di lokasi.

#### 9.3 Formulir cek lapangan eskalator / tangga / jembatan
Dipra-isi dari `data/build_log.json → connectorEdges` (23 baris), override `esc-a-penta-1`, dan `danglingConnectors`. Kolom ↑ = ada unit **naik** dari lantai bawah ke atas dan beroperasi; ↓ = ada unit **turun**. Jika keduanya kosong → leg dinonaktifkan.

| # | Leg (src_key) | Bank | Bawah ↔ Atas | Di data saat ini | Ada di lapangan? (Y/T) | ↑ naik | ↓ turun | Jam operasi | Patokan / catatan |
|---|---|---|---|---|:-:|:-:|:-:|---|---|
| 1 | esc-a-penta-1 | Eskalator A · Pentacity | LG Pentacity ↔ GF | **nonaktif** (temuan 4 Okt 2026: hanya GF↔UG) | T | – | – | – | depan Sociolla — konfirmasi ulang |
| 2 | esc-a-penta-2 | Eskalator A · Pentacity | GF ↔ UG | aktif, ↕ | ☐ | ☐ | ☐ | | depan Sociolla |
| 3 | esc-a-penta-3 | Eskalator A · Pentacity | UG ↔ 1F Pentacity | aktif, ↕ | ☐ | ☐ | ☐ | | |
| 4 | esc-a-penta-4 | Eskalator A · Pentacity | 1F ↔ 2F Pentacity | aktif, ↕ | ☐ | ☐ | ☐ | | |
| 5 | esc-b-penta-1 | Eskalator B · Pentacity | LG Pentacity ↔ GF | aktif, ↕ | ☐ | ☐ | ☐ | | |
| 6 | esc-b-penta-2 | Eskalator B · Pentacity | GF ↔ UG | aktif, ↕ | ☐ | ☐ | ☐ | | |
| 7 | esc-b-penta-3 | Eskalator B · Pentacity | UG ↔ 1F Pentacity | aktif, ↕ | ☐ | ☐ | ☐ | | |
| 8 | esc-b-penta-4 | Eskalator B · Pentacity | 1F ↔ 2F Pentacity | aktif, ↕ | ☐ | ☐ | ☐ | | |
| 9 | esc-c-penta-4 | Eskalator C · Pentacity | 1F ↔ 2F Pentacity | aktif, ↕ (hanya leg ini) | ☐ | ☐ | ☐ | | Ada leg C di lantai lain? |
| 10 | esc-a-ewalk-1 | Eskalator A · E-Walk | LG E-Walk ↔ GF | aktif, ↕ | ☐ | ☐ | ☐ | | |
| 11 | esc-a-ewalk-2 | Eskalator A · E-Walk | GF ↔ UG | aktif, ↕ | ☐ | ☐ | ☐ | | |
| 12 | esc-a-ewalk-3 | Eskalator A · E-Walk | UG ↔ 1F E-Walk | aktif, ↕ | ☐ | ☐ | ☐ | | |
| 13 | esc-a-ewalk-4 | Eskalator A · E-Walk | 1F ↔ 2F E-Walk | aktif, ↕ | ☐ | ☐ | ☐ | | satu-satunya akses 2F E-Walk di data |
| 14 | esc-b-ewalk-2 | Eskalator B · E-Walk | GF ↔ UG | aktif, ↕ | ☐ | ☐ | ☐ | | |
| 15 | esc-b-ewalk-3 | Eskalator B · E-Walk | UG ↔ 1F E-Walk | aktif, ↕ | ☐ | ☐ | ☐ | | |
| 16 | esc-b-ewalk-4 | Eskalator B · E-Walk | 1F ↔ 2F E-Walk | **buntu** (ujung 2F tidak ada di data) | ☐ | ☐ | ☐ | | tandai titik di 2F bila ada |
| 17 | esc-c-ewalk-2 | Eskalator C · E-Walk | GF ↔ UG | aktif, ↕ | ☐ | ☐ | ☐ | | |
| 18 | esc-c-ewalk-3 | Eskalator C · E-Walk | UG ↔ 1F E-Walk | **buntu** (ujung 1F tidak ada di data) | ☐ | ☐ | ☐ | | tandai titik di 1F bila ada |
| 19 | cross-ff | Jembatan 1F | 1F E-Walk ↔ 1F Pentacity | aktif (crossing) | ☐ | — | — | | jam buka jembatan? |
| 20 | — | (baru?) | LG Pentacity ↔ LG E-Walk | tidak ada di data | ☐ | — | — | | ada koridor/jalan langsung? |
| 21 | — | Tangga darurat/umum | ___ ↔ ___ | tidak ada di data | ☐ | ☐ | ☐ | | hanya tangga yang boleh dipakai pengunjung |

#### 9.4 Formulir lift — lantai yang dilayani
| Lift | LG | GF | UG | 1F | 2F | Di data saat ini | Jam operasi | Catatan |
|---|:-:|:-:|:-:|:-:|:-:|---|---|---|
| Lift · Pentacity (`lift-penta`) | ☐ | ☐ | ☐ | ☐ | ☐ | LG–GF–UG–1F–2F (4 leg) | | berapa unit? kapasitas kursi roda? |
| Lift · E-Walk (`lift-ewalk`) | ☐ | ☐ | ☐ | ☐ | ☐ | LG–GF–UG–1F (3 leg), **tidak ke 2F** | | dugaan user: tidak sampai 2F → konfirmasi; ada lift lain ke 2F (XXI/Matahari/Grand Jatra)? |
| Lift parkir / hotel / lainnya | ☐ | ☐ | ☐ | ☐ | ☐ | tidak ada di data | | boleh dipakai pengunjung? |

---

## 10. Rencana bertahap & paket kerja

### 10.1 Lingkup v1 (dibangun sekarang)
Semua modul **M** di §2, plus S yang murah: notice, i18n, event, video promo, import CSV bila waktu cukup. Output v1:
1. DB + seed dari data sekarang (210 tenant, 8 lantai, 614 node, 15 leg eskalator aktif + 7 leg lift + 1 jembatan, 7 kiosk, 40 stop) — hasil publish pertama **identik secara rute** dengan `data/directory.json` sekarang (validator: 1470/1470).
2. CMS admin lengkap (§7.2 layar 1–20; analitik grafik sederhana).
3. Kiosk/HP: SW, sync, telemetri, promo playlist, POI, closures, lite mode, profil TV.

### 10.2 v2 (setelah data lapangan & operasi berjalan)
Re-registrasi SVG affine; approval berjenjang (draft → review → publish); portal tenant self-service; 2FA TOTP; alert kiosk offline (WhatsApp/email); multi-kategori & deals per tenant; slot `panel-banner`/`phone-arrival`; laporan pengiklan PDF; heatmap pencarian per jam; screenshot remote kiosk; XAMPP lokal per kiosk sebagai cadangan; A/B promo; integrasi data pengunjung (footfall) dari sistem lain.

### 10.3 Perkiraan usaha (ekuivalen developer manusia; agen: 1 sesi per paket)
| Paket | Isi | Ukuran kode (kira-kira) | Hari-orang |
|---|---|---|---|
| WP-A Backend | DDL, seed importer, lib, API, publisher, validator, cron, backup | 4.500 baris PHP | 8–10 |
| WP-B Admin UI | 20 layar, mapcanvas, editor graph, panel bank | 5.500 baris JS/HTML/CSS | 10–12 |
| WP-C Kiosk runtime | SW, sync, telemetri, promo, lite, patch route/data/kiosk/map/phone, skrip Windows, panduan TV | 1.500 baris JS + PS1 | 4–5 |

### 10.4 Paket kerja paralel & kepemilikan direktori
Tidak ada dua paket yang menulis file yang sama.

| Paket | Memiliki (boleh menulis) | Tidak boleh menyentuh |
|---|---|---|
| **WP-A — Core, API, Publish** | `db/**`, `lib/**`, `api/**`, `tools/seed_import.php`, `tools/validate.php`, `tools/create_admin.php`, `tools/cron.php`, `tools/backup.ps1`, `tools/backup.sh`, `media/` (struktur + `.htaccess`), `data/releases/`, `data/version.json`, `data/promos.json`, `data/status.json`, `.htaccess` root (header & cache), `config.php` (kredensial DB, path cwebp; **di luar** web root bila memungkinkan, atau `config.php` + `.htaccess` deny). `data/directory.json` **hanya** ditulis oleh publisher saat runtime (publish pertama di akhir WP-A). | `cms/**`, `js/**`, `css/**`, `index.html`, `m/**`, `sw.js`, `kiosk/**`, `tools/build_data.py`, `tools/verify_routes.py`, `data/floors/**`, `data/raw/**`, `assets/**` |
| **WP-B — Admin UI** | `cms/**` (HTML, `cms/js/*.js` modul ES, `cms/css/admin.css`, `cms/mock/*.json` fixture untuk dev sebelum API siap, `cms/img/**`) | semua selain `cms/` |
| **WP-C — Kiosk & phone runtime** | `sw.js`, `offline.html`, `js/sync.js`, `js/telemetry.js`, `js/promos.js`, `js/perf.js`, `css/lite.css`, patch `js/route.js`, `js/data.js`, `js/kiosk.js`, `js/map.js`, `js/phone.js`, `js/i18n.js`, `js/icons.js`, `config.js`, `index.html`, `m/index.html`, `kiosk/**`, `tests/fixtures/**` (contoh snapshot schema 2) | `api/**`, `lib/**`, `db/**`, `cms/**`, `data/**` |

**Urutan & dependensi**
1. WP-A dan WP-B mulai bersamaan. WP-B memakai `cms/mock/*.json` yang dibuat dari DTO §4.5 dengan flag `?mock=1` (`cms/js/api.js` membaca fixture alih-alih fetch). Begitu WP-A selesai, mock dimatikan.
2. **WP-C mulai setelah agen UI yang sedang mengedit CSS/JS kiosk selesai** (hindari konflik pada `js/kiosk.js`, `js/map.js`, `css/*`). Sambil menunggu, WP-C boleh menulis file baru (`sw.js`, `js/sync.js`, `js/telemetry.js`, `js/promos.js`, `js/perf.js`, `css/lite.css`, `kiosk/*`, `tests/fixtures/*`) dan menunda patch ke file yang sudah ada. WP-C menguji terhadap `tests/fixtures/directory.v2.json` (dibuat manual dari `data/directory.json` + field §5.3) sampai publisher WP-A tersedia.
3. Integrasi: WP-A menjalankan seed + publish pertama → WP-C memverifikasi kiosk lama dan baru membaca snapshot baru → WP-B diuji end-to-end (login → edit tenant → publish → kiosk reload saat idle).

**Kontrak bersama** (sumber tunggal = dokumen ini):
- DDL §3 (WP-A implementasi; WP-B membaca hanya lewat API).
- API & DTO §4 (WP-A produser; WP-B konsumen admin; WP-C konsumen publik: `/api/version`, `/api/kiosk/ping`, `/api/kiosk/ack`, `/api/telemetry`, `/api/telemetry/phone`).
- Snapshot §5 (WP-A produser; WP-C konsumen).
- Nama ikon: `BSB.ICONS` di `js/icons.js` (WP-C menambah; WP-B membaca file itu di browser untuk picker).

### 10.5 Urutan kerja yang disarankan per paket
**WP-A**
1. `db/schema.sql` + `db/seed_reference.sql` (amenity_types, settings default: `mall.hours` 10:00–22:00 setiap hari, `cost.*`, `kiosk.idleTimeoutSec`=60, `map.northDeg`=null, `media.cwebpPath`).
2. `lib/`: `Db.php` (PDO singleton, transaksi), `Router.php`, `Http.php` (json, error, input), `Auth.php`, `Csrf.php`, `Permissions.php`, `RateLimit.php`, `Audit.php`, `Revisions.php`, `Media.php` (+ encoder chain), `SvgSanitizer.php`, `Snapshot.php` (builder JSON §5), `Publisher.php`, `Validator.php`, `RouteCheck.php` (Dijkstra), `Diff.php`, `Schedule.php`, `Keywords.php`.
3. `tools/seed_import.php` — sumber: `data/directory.json`, `data/build_log.json`, `data/overrides/connectors.json`, `assets/logos/*.webp`, `data/floors/*.svg`. Langkah: floors (+focus) → media (logo & svg, path tetap di lokasi lama) → categories (+warna) → nodes (id dari `n<k>`) → walk edges (dedupe pasangan, simpan `cost_override` **null** bila |cost − len×unitScale| < 0.05, selain itu simpan cost asli) → banks (`bank_of()` dari endpoint; `cross-ff` = bank `bridge`) → stops (dari `amenities[]`, `public_id` = id amenity) → legs (pasangan edge `escalator-up`/`escalator-down` → satu leg `both`; edge lift → leg; crossing → leg; `src_key` dari irisan `connectors` kedua stop) → catat `esc-a-penta-1` di `connector_banks.notes` (stop LG tidak ada di data) → brands (grup per `brand`; nama, kategori, url, keywords dari tenant pertama) → tenants (id, `name_override` = name bila berbeda dari aturan otomatis, `unit_shape_id = 'unit-<id>'` bila elemen itu ada di SVG) → kiosks → `hours_mode='unknown'`. Diakhiri `php tools/validate.php` harus 1470/1470 default; publish pertama `D0001`.
4. API publik → API admin (urut: auth, tenants/brands, categories, media, floors, graph, connectors, closures/status, kiosks, amenities, promos/events/featured, i18n, publish, analytics, audit, users/settings).
5. `tools/cron.php`, backup, `api/health`.
6. Uji: skrip `tools/smoke_test.php` (login, CRUD tenant, graph ops, publish, rollback, telemetry ingest, rate limit).

**WP-B**
1. Shell (`cms/index.html`, router hash, `api.js` + mock, layout, token CSS, komponen tabel/form/toast/dialog).
2. Login, Dashboard, Tenant list/edit (tanpa peta), Kategori, Media.
3. `mapcanvas.js` → penempatan tenant & unit link → Kiosk (posisi + dial facing + provisioning) → Fasilitas.
4. Editor graph → panel bank konektor → Ops Status (mobile).
5. Promo/Event/Featured/i18n → Publish (validasi, diff, riwayat, rollback) → Analitik → Audit → Users/Settings.

**WP-C**
1. File baru: `js/perf.js`, `css/lite.css`, `js/telemetry.js`, `js/sync.js`, `js/promos.js`, `sw.js`, `offline.html`, `tests/fixtures/*`.
2. Patch `js/route.js` (§5.7) + uji regresi: hasil rute fixture schema 2 tanpa closure = identik dengan snapshot lama (bandingkan cost semua pasangan kiosk→tenant).
3. Patch `js/data.js`, `js/i18n.js`, `js/icons.js`, `js/map.js`, `js/kiosk.js`, `js/phone.js`, `config.js`, `index.html`, `m/index.html`.
4. Profil smart TV: uji Playwright dengan CPU throttle 6×, UA Chromium lama, single-touch emulation; `kiosk/README-smart-tv.md` (setup Fully Kiosk, Tizen/webOS signage, checklist power/eco).
5. `kiosk/setup-kiosk.ps1` (registry gestur/edge swipe, kebijakan Edge, power, task scheduler) + `kiosk/watchdog.ps1` + update `start-kiosk.bat`.

### 10.6 Definition of done v1
- Seed → validate (1470/1470) → publish `D0001` → kiosk lama (tanpa patch) dan kiosk baru sama-sama berjalan dengan snapshot baru.
- Ubah Eskalator A Pentacity GF↔UG menjadi `up` → publish → kiosk baru: rute dari UG ke GF tidak lewat eskalator A; validator menampilkan dampak `W_REACH_RETURN` bila ada.
- Closure ↓ pada leg itu dari halaman Ops di HP → `status.json` naik versi → kiosk menerapkan dalam ≤ 70 dtk tanpa reload.
- Upload logo PNG → WebP (atau fallback terlapor) → tampil di kiosk setelah publish.
- Cabut kabel internet server: kiosk tetap bekerja; matikan Apache: kiosk (dengan SW) tetap bekerja dari cache, telemetri antre lalu terkirim saat Apache hidup.
- Kiosk dengan `perfMode=lite` menampilkan mode lite dan heartbeat melaporkan `perfActive=lite`.
- Audit log mencatat semua langkah di atas.
