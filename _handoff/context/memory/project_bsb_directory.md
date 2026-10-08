---
name: project-bsb-directory
description: Rebuild BSB Directory e-Walk & Pentacity jadi kiosk touchscreen + wayfinding + QR ke HP; prototype di htdocs/bsb-directory
metadata:
  node_type: memory
  type: project
  originSessionId: 3c09f60f-1360-480b-b171-0353d9210003
  modified: 2026-10-03T20:58:45.589Z
---

Rebuild halaman ewalkpentacitymall.com/maps-e-walk-pentacity-mall-balikpapan/ (Mapplic id bhEfnhBRWvijlEasMqb7) jadi directory kiosk touchscreen di beberapa titik mall, dengan wayfinding rute + QR yang dibuka di HP (panduan ala Apple Find My). Dimulai 4 Okt 2026, folder /Applications/XAMPP/xamppfiles/htdocs/bsb-directory/.

Keputusan user (4 Okt 2026):
- Panduan HP = kompas + langkah per segmen + perkiraan langkah kaki (sensor HP). Tanpa BLE beacon.
- Visual = "mall modern" (BUKAN 3D neon).
- Data = impor sekali dari Mapplic + dibersihkan, nanti dikelola admin sendiri (lepas dari Mapplic).
- Hardware kiosk = PC Windows, layar LANDSCAPE (resolusi belum disebut, asumsi 1920×1080) → jalankan Edge/Chrome --kiosk.
- Lingkup = prototype dulu (1 kiosk + halaman HP), baru sistem lengkap.

Status 4 Okt 2026: data layer SELESAI (data/directory.json, tools/build_data.py + verify_routes.py, DATA_REPORT.md) — 8 sheet lantai di 5 level (LG/1F/2F terpisah per gedung), 210 tenant, 7 kiosk = titik "You Are Here", graph 614 node, 100% tenant terjangkau; mapNorthDeg & facingDeg masih null. UI prototype SELESAI 4 Okt 2026: index.html (kiosk), m/ (HP), js/ (data, route Dijkstra = port verify_routes.py, map, search, kiosk, phone, config.js PUBLIC_BASE/mapNorthDeg), kiosk/start-kiosk.bat, screenshot di docs/screens/. Belum: uji HP fisik, HTTPS, admin panel, promo asli; banyak "logo" sebenarnya foto toko; eskalator antar lantai berbagi node (GF→2F jadi 1 instruksi).

Revisi user 4 Okt 2026: bahasa DEFAULT INGGRIS dengan opsi Indonesia (config.js defaultLang 'en'; QR membawa &lang= pilihan pengunjung); halaman depan (attract) SELALU bahasa Inggris (config.js attractLang); koreksi eskalator lapangan dicatat di data/overrides/connectors.json (Esk. A Pentacity depan Sociolla hanya GF↔UG); logo e-Walk dikecilkan 70% agar seimbang dgn Pentacity; logo pakai logo ASLI e-Walk | Pentacity (sumber hi-res ~/Documents/KERJA/EWALK PENTACITY/ASSET DESIGN/, hasil di assets/brand/), bukan monogram "eP"; kiosk diskalakan otomatis (zoom dari 1920×1080) agar pas di layar apa pun. CMS: spec di docs/CMS_SPEC.md (PHP 8 native + MariaDB db `bsb_directory`; MySQL = sumber kebenaran, Publish → data/directory.json + promos.json + status.json; eskalator dimodelkan bank→stop→leg dgn enabled/arah/jadwal/closure; 2 profil kiosk windows_pc & smart_tv dgn perf_mode lite; server di LAN mall + domain asli/Let's Encrypt agar HTTPS & Service Worker jalan saat internet putus). Dibangun 4 Okt 2026 oleh 3 paket paralel: WP-A db/lib/api, WP-B cms/, WP-C runtime kiosk (sw.js, sync, telemetry, promos, lite). Kontrak berubah → docs/CMS_DEVIATIONS.md. SELESAI & lulus uji integrasi 4 Okt 2026 (7 skenario, smoke 114/114, e2e 59/59, validate 1470/1470). Kredensial admin & token kiosk dev: ~/.bsb-directory/ (chmod 600). CMS: /bsb-directory/cms/. Belum: uji PC Windows/TV/HP fisik, HTTPS/domain produksi, cek lapangan eskalator (form di CMS_SPEC §9), telemetri uji masih di DB. User punya TV touchscreen ber-browser sbg opsi kiosk (merk/OS belum diketahui).

Audit situs lama: halaman 74 MB (logo PNG ~1 MB), 84 lokasi di layer hantu, ~57 tenant dobel, ~26 link rusak, script deep-link custom tidak berfungsi.

**Why:** kiosk fisik di mall, pengunjung lanjut navigasi di HP.
**How to apply:** jaga 4 keputusan di atas; kompas HP di iOS butuh HTTPS + izin, jadi QR harus mengarah ke URL HTTPS publik/tunnel. Terkait [[data-ewalk-pentacity-2026]], [[project-pamplus-rebuild]].
