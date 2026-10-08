# Riwayat Sesi Pengembangan (4 Oktober 2026)

Ringkasan kronologis percakapan antara pemilik proyek dan Claude Code yang membangun proyek ini. Tujuannya agar tim tahu **kenapa** sesuatu dibuat seperti sekarang. Status & cara melanjutkan ada di `docs/HANDOFF.md`.

## 1. Audit halaman directory lama
Halaman ewalkpentacitymall.com/maps-e-walk-pentacity-mall-balikpapan/ (WordPress + Mapplic id `bhEfnhBRWvijlEasMqb7`) diaudit. Temuan:
- Halaman **74 MB / 244 request**, 71 MB di antaranya logo PNG ±1 MB yang tampil ±40 px.
- 84 lokasi di layer lantai yang sudah tidak ada; ±57 tenant dobel; entri uji "blabla"; kategori berantakan; ±26 link rusak/salah.
- Bagian bawah peta terpotong di desktop; script deep-link custom tidak pernah jalan; Disqus salah konfigurasi.

## 2. Arah rebuild (keputusan pemilik)
Diminta: directory "futuristic" di layar touchscreen beberapa titik, wayfinding seperti web lama, QR ke HP yang menunjukkan arah "seperti Apple Find My".
Dijelaskan bahwa di dalam mall tidak ada GPS, sehingga live tracking butuh BLE beacon + aplikasi native. Pemilik memilih:
- **Kompas + langkah per segmen + hitung langkah kaki** (kombinasi), tanpa beacon.
- Visual **"mall modern"** (bukan 3D neon).
- Data **impor sekali dari Mapplic** lalu dikelola sendiri.
- **Prototype dulu**. Kiosk: **PC Windows, landscape**.

## 3. Data layer
Denah SVG 8 sheet, 544 polyline rute, dan koordinat tenant dari Mapplic dibersihkan dan disusun jadi graph (lihat `data/DATA_REPORT.md`). Logo 80 MB → 1,8 MB. Semua tenant terjangkau dari 7 titik "You Are Here".

## 4. Prototype kiosk & HP, lalu revisi dari pemilik
- Deretan logo di layar depan tertutup di layar laptop → layout kini **diskalakan otomatis** dari 1920×1080.
- Halaman depan **full bahasa Inggris**.
- Pakai **logo asli e-Walk | Pentacity**; kemudian logo e-Walk dinilai **kegedean** → dikecilkan 70%.
- **Kerapian tulisan**: kartu QR berantakan → audit tipografi menyeluruh (ID & EN, kiosk & HP).
- **Default bahasa Inggris** dengan opsi Indonesia.

## 5. Temuan lapangan eskalator
- Pemilik: *"tidak semua titik eskalator atas-bawah lantai, seperti yang depan Sociolla, itu cuma ke UG dan dari UG, tidak bisa ke LG."* → Eskalator A Pentacity GF↔LG dinonaktifkan. Dari sini muncul model **eskalator per leg** (aktif/arah/jadwal/penutupan) yang menjadi inti CMS.
- Pemilik: rute ke Matahari 2F **"lompat lantai dari GF ke SF"** → penyebabnya eskalator bertumpuk tanpa jalan kaki di UG/1F sehingga instruksi tergabung. Diperbaiki: setiap lantai ditampilkan ("via UG · 1F"), animasi singgah per lantai.

## 6. TV touchscreen
Pemilik punya TV touchscreen ber-browser sebagai opsi kiosk dan khawatir "kalau internet putus mati". Dijelaskan: tidak harus mati bila server di LAN mall + cache offline (Service Worker, butuh HTTPS). Kelemahan TV: CPU lemah (→ mode lite), sulit dikunci, pinch kadang tidak ada. Rekomendasi: Android TV + Fully Kiosk Browser. **Merk/tipe TV belum diketahui.**

## 7. CMS
Pemilik minta CMS "dengan memperhatikan opsi eskalator" dan analisis kebutuhan oleh agent. Hasil: `docs/CMS_SPEC.md`, lalu dibangun 3 paket paralel (WP-A backend/API/publish, WP-B admin UI, WP-C runtime kiosk) dan diuji integrasi end-to-end (7 skenario lulus; 3 bug integrasi diperbaiki, dicatat di `docs/CMS_DEVIATIONS.md`).

## 8. Gaya kerja yang disukai pemilik
- Bahasa Indonesia, ringkas, langsung ke hasil.
- Suka pekerjaan dipecah ke beberapa agent paralel bila memungkinkan.
- Memberi umpan balik visual lewat screenshot; perhatian pada kerapian tipografi dan keseimbangan logo.
