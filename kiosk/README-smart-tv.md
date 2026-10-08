# Kiosk di Smart TV touchscreen — panduan setup (CMS_SPEC §6.8)

Profil CMS: `client_type = smart_tv` (atau `android_box`), `perf_mode = auto` → kiosk otomatis memakai **mode lite**
(tanpa blur/bayangan berat, animasi pendek, rute digambar langsung + penanda bergerak, maks 3 denah di memori,
marquee logo statis berganti halaman tiap 6 dtk). Paksa lewat CMS (`perf_mode = full|lite`) atau URL `?perf=lite`.

## 0. Cek dulu jenis TV-nya

| Ditemukan | Keputusan |
|---|---|
| **Android TV / Google TV / panel interaktif (IFP) Android** — bisa pasang APK | ✅ **Pilihan utama**: Fully Kiosk Browser (§1) |
| **Samsung Smart Signage (SSSP / Tizen signage)**, mis. seri QB/QM/QH | ⚠️ Bisa, lewat URL Launcher (§2) |
| **LG webOS Signage / Pro:Centric**, mis. seri UH/UL/UM | ⚠️ Bisa, lewat SI/URL Launcher (§3) |
| Samsung Tizen / LG webOS **TV konsumen** | ❌ Browser tidak bisa autostart/dikunci, mati sendiri 4 jam → pasang **Android box / mini PC** via HDMI + USB touch |
| Browser di bawah Chromium 68 (webOS 4 ≈ Chr 53, Tizen 4 ≈ Chr 56) | ❌ Tidak didukung → Android box / mini PC |

Cara cepat cek versi engine: buka `https://directory.<domain>/bsb-directory/?kiosk=<id>&perf=auto` lalu
dari CMS kirim perintah **identify**: overlay menampilkan ID, build, mode performa. User-Agent lengkap
terlihat di CMS > Kiosk (heartbeat).

Syarat jaringan untuk semua TV: TV memakai **DNS router mall** (MikroTik static DNS `directory.<domain>` → IP server LAN)
dan **HTTPS dengan sertifikat valid** (Let's Encrypt). Jangan pakai HTTP ke IP (`http://10.x.x.x`) — Service Worker
(cache offline) tidak aktif; jangan pakai sertifikat self-signed (root CA tidak bisa dipasang di Tizen/webOS).

## 1. Android TV / IFP + Fully Kiosk Browser (disarankan)

1. Pasang **Fully Kiosk Browser** (fully-kiosk.com, APK atau Play Store) + lisensi **Plus** per perangkat.
2. Di CMS > Kiosk > Provisioning: "Buat token" → muncul **launch URL** + **QR**. Di Fully: *Settings → Web Content Settings → Start URL*
   = launch URL (`https://directory.<domain>/bsb-directory/?kiosk=<id>&key=<token>`). Scan QR dengan kamera HP lalu kirim
   ke Fully Remote Admin, atau ketik sekali.
3. Pengaturan Fully (nama menu bisa sedikit berbeda per versi):
   - *Web Content Settings*: **Enable JavaScript**, **Autoplay Videos** = on, **Enable Service Workers / Web Storage** = on
     (jangan "Clear cache on start"), **Load cache when offline** (*Advanced Web Settings → Load Cache If Offline*) = on.
   - *Web Browsing Settings*: **Reload on network reconnect** = on, **Reload on error** = on (± 30 dtk), **Disable
     pull-to-refresh** = on, matikan *Enable Zoom*.
   - *Web Zoom and Scaling*: **Initial scale = 0 / auto**, *Use Wide Viewport* = on. Kiosk menghitung skala sendiri
     dari 1920×1080 (script auto-fit di `index.html`).
   - *Kiosk Mode*: **Enable Kiosk Mode** = on, PIN admin, *Disable Status Bar / Navigation Bar*, *Disable Volume/Power buttons*
     sesuai kebutuhan, *Single App Mode* (bila Device Owner).
   - *Device Management*: **Launch on boot** = on, **Keep screen on** = on, **Schedule wake-up/sleep** = jam mall
     (mis. on 09:30, off 22:30), *Unlock screen* = on.
   - *Remote Administration*: aktifkan (password kuat) — untuk reload/screenshot jarak jauh selain perintah CMS.
   - *Advanced Web Settings*: User-Agent default (jangan ganti; kiosk mendeteksi versi Chromium dari UA).
4. Android System WebView: perbarui ke versi terbaru (Play Store) — lebih cepat & aman. Matikan update otomatis
   di jam operasional (Play Store → auto-update "over Wi-Fi only" + jadwal maintenance).
5. Uji: cabut kabel LAN → kiosk tetap jalan (cache), colok lagi → CMS menunjukkan kiosk online lagi.

## 2. Samsung Tizen — hanya seri Smart Signage

- **URL Launcher**: *Home → URL Launcher → Settings → Install Web App* atau isi URL langsung = launch URL kiosk.
  Atur sebagai sumber default (*System → Play via → URL Launcher* / "Custom Home") supaya muncul otomatis setelah boot.
- MagicInfo (bila dipakai) bisa menjadwalkan konten URL.
- *System → Start-up Source / Power On*: **Last Input** atau URL Launcher.
- **Kiosk/Lock**: *System → Security → Safety Lock / Button Lock* (kunci tombol remote & panel).
- Versi engine: Tizen 5.5 ≈ Chr 69 (OK, lite), 6.5 ≈ Chr 85, 7 ≈ Chr 94. Tizen 4 ke bawah: tidak didukung.

## 3. LG webOS — hanya seri Signage / Pro:Centric

- **SI / URL Launcher** (*Settings → General → SI Server Settings* atau aplikasi *URL Launcher*) = launch URL kiosk,
  *Fail-over*/*Auto start* = on.
- **Lock mode** (*Settings → General → Lock Mode*): kunci tombol, USB, OSD.
- **Power On Status = LST/PWR**, **On/Off Timer** sesuai jam mall.
- Versi engine: webOS 5 ≈ Chr 68 (batas minimum), 6 ≈ Chr 79, 22 ≈ Chr 87.

## 4. Checklist daya / eco (WAJIB di semua TV)

- [ ] **Auto Power Off** (TV mati setelah 4 jam tanpa remote) = **OFF**
- [ ] **Eco / Energy saving**: *No Signal Power Off*, *Auto Standby*, *Eco Sensor*, *Motion lighting* = **OFF**
- [ ] **Sleep timer** = off, **screensaver** = off, *Screen Burn Protection / Pixel shift* = sesuai rekomendasi pabrik
- [ ] **On Timer / Off Timer** = jam mall (mis. ON 09:30, OFF 22:30), *Power On Behaviour* = last input/app
- [ ] **Update firmware otomatis** = off di jam operasional (update manual saat maintenance)
- [ ] Notifikasi / iklan / "Ambient mode" pabrik = off
- [ ] Jam TV sinkron NTP (router) — jadwal promo & eskalator dihitung di perangkat (WITA, UTC+8)
- [ ] UPS untuk server CMS + switch; listrik TV dari jalur yang ikut jadwal genset

## 5. Sentuh (touch)

- Frame IR / TV sering **single-touch** atau emulasi mouse → tidak ada pinch. Tombol **+ / − / lokasi** di peta selalu tampil.
- Pencarian memakai **keyboard di layar kiosk** (kotak cari adalah tombol, bukan `<input>`) → keyboard sistem TV tidak muncul.
- Long-press, menu konteks, zoom halaman diblok oleh aplikasi.
- Kalibrasi frame IR sesuai panduan pabrik bila titik sentuh meleset di pojok.

## 6. Verifikasi setelah pasang

1. CMS > Kiosk: status **online**, badge **TV · lite (auto: …)**, `swActive = true` (bila false → cek HTTPS/sertifikat).
2. Kirim **identify** → ID kiosk tampil 15 dtk di TV.
3. Tutup satu eskalator dari halaman Ops (HP) → dalam ≤ 70 dtk rute di TV menghindarinya, ikon kunci pas tampil di peta.
4. Matikan Apache di server → TV tetap jalan dari cache; hidupkan lagi → telemetri antrean terkirim.
5. Tidak ada yang bisa keluar dari aplikasi tanpa PIN.
