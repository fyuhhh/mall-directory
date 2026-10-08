BSB Directory — setup PC kiosk (Windows 10/11)                       versi CMS (WP-C), 4 Okt 2026
==================================================================================================

Arsitektur: kiosk TIDAK lagi menjalankan Apache sendiri. Aplikasi dimuat dari server CMS di LAN mall
lewat HTTPS (https://directory.<domain>/bsb-directory/), domain di-resolve ke IP LAN oleh static DNS
MikroTik (CMS_SPEC §8.3–8.4). HTTPS wajib supaya Service Worker (cache offline) aktif.

A. Persiapan sekali
   1. Buat akun lokal standar (bukan admin), mis. "Kiosk".
   2. Di CMS > Kiosk > pilih kiosk > "Buat token" -> catat ID kiosk + token (ditampilkan sekali).
   3. Salin folder kiosk\ ke PC (USB/jaringan), buka PowerShell **sebagai Administrator**:

        powershell -ExecutionPolicy Bypass -File setup-kiosk.ps1 ^
           -KioskId gf-pentacity -Key <TOKEN> ^
           -BaseUrl https://directory.<domain>/bsb-directory -KioskUser Kiosk ^
           [-DisplayOffAt 22:30] [-DisableUsbStorage] [-AutologonExe C:\tools\Autologon64.exe]

      Skrip ini:
        - menulis C:\BSBKiosk\kiosk.conf (ID, token, URL) + menyalin start-kiosk.bat & watchdog.ps1 (ACL: admin + user kiosk)
        - kebijakan Edge: URL allowlist = domain direktori, blok semua URL lain, tanpa DevTools/unduhan/print/
          translate/password manager/InPrivate, autoplay video promo diizinkan
        - matikan edge swipe (AllowEdgeSwipe=0), dialog error, reboot Windows Update di jam aktif (08–23)
        - power: layar & sleep "never" (AC), hibernate off, USB selective suspend off (touch frame)
        - Task Scheduler (folder "BSB Kiosk"): Start kiosk (saat logon +20 dtk), Watchdog (loop 60 dtk +
          lockdown per-user: gestur 3/4 jari, notifikasi, keyboard sentuh otomatis, taskbar auto-hide),
          restart Edge harian 04:30, reboot mingguan Minggu 05:00, opsional layar mati malam
   4. Auto-login akun Kiosk: Sysinternals Autologon (password terenkripsi LSA) — via -AutologonExe atau manual.
   5. BIOS: "Restore on AC power loss = On" (+ RTC wake 09:00 bila PC dimatikan malam), password BIOS.
   6. Manual: Settings > Bluetooth & devices > Touch > matikan "Three- and four-finger touch gestures"
      (registry TouchGestureSetting sudah diset, cek ulang per build Windows), Focus Assist = Alarms only,
      remote support (MeshCentral self-hosted / AnyDesk unattended), casing terkunci.
   7. Logout -> login sebagai Kiosk -> Edge harus terbuka fullscreen dalam ±20 dtk.

B. Mode Edge
   start-kiosk.bat memakai --kiosk <URL> --edge-kiosk-type=fullscreen dengan profil TETAP
   (%LOCALAPPDATA%\BSBKiosk\EdgeProfile). JANGAN pakai public-browsing: itu InPrivate -> cache Service Worker,
   salinan snapshot (localStorage) dan antrean telemetri hilang setiap start.
   Alternatif lebih terkunci: Windows "Assigned Access" (single-app kiosk Edge) — Win 10/11 Pro/Enterprise.

C. Identitas kiosk
   URL peluncuran: https://<host>/bsb-directory/?kiosk=<id>&key=<token>. Kiosk menyimpan id+token di
   localStorage dan menghapus token dari address bar. ?kiosk= di URL selalu menang.
   Tanpa token kiosk tetap jalan, tetapi heartbeat & telemetri ditolak (401) -> status "offline" di CMS.

D. Keluar untuk maintenance
   Ctrl+Alt+Del -> Sign out / Task Manager (keyboard fisik). Alt+F4 menutup Edge (watchdog membukanya lagi
   dalam ≤ 60 dtk). Untuk menonaktifkan: hentikan task "BSB Kiosk\Watchdog" di Task Scheduler.
   Hapus semua: setup-kiosk.ps1 -Uninstall (sebagai Administrator).

E. Diagnosa
   - Log watchdog: C:\BSBKiosk\watchdog.log
   - CMS > Kiosk: online/stale/offline, versi data, perfActive (full/lite), swActive (merah bila Service Worker mati)
   - Perintah jarak jauh dari CMS: identify (ID kiosk tampil 15 dtk), reload, clear_cache
   - Tambahkan ?perf=lite atau ?perf=full di URL untuk memaksa mode performa saat uji.

Smart TV / Android: lihat README-smart-tv.md.
