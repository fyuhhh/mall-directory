# Cara Menjalankan BSB Directory

Panduan untuk menjalankan kiosk, halaman HP, CMS, dan peta 3D di komputer sendiri setelah `git clone` atau `git pull`, plus cara memindahkannya ke hosting cPanel.

Yang ikut di repo, jadi setelah ditarik isinya sama dengan komputer asal:

- **Kode:** kiosk, HP, CMS, dan peta 3D.
- **Peta 3D semua lantai:** `data/3d/`.
- **Snapshot terakhir yang dipublish:** `data/directory.json`.
- **Database CMS:** `_handoff/db/bsb_directory.sql`, lengkap dengan tenant, jalur, fasilitas, tautan unit 3D, dan akun CMS.

Yang **tidak** ikut git dan tidak tertimpa saat `git pull`: `config.local.php` (setelan database/server masing-masing komputer).

## Ringkas

Sudah pernah dipasang, tinggal update:

```
git pull
php tools/setup.php import --force
php tools/setup.php check
```

Kalau sebelumnya di `main` dan peta 3D belum digabung, mulai dengan `git fetch` lalu `git checkout feat/3d-map`. Lalu buka CMS dan login. Akunnya ada di bagian [Akun CMS](#4-akun-cms).

## 1. Kebutuhan

| | Windows (disarankan: XAMPP) | macOS |
|---|---|---|
| Web server + PHP | XAMPP 8.x (PHP 8.0 atau lebih baru) | XAMPP, atau `brew install php` |
| Database | MariaDB bawaan XAMPP (10.4 ke atas) | MariaDB bawaan XAMPP, atau `brew install mariadb` |
| Git | Git for Windows, atau GitHub Desktop | bawaan Xcode tools |
| Browser | Chrome / Edge terbaru (peta 3D butuh WebGL) | Chrome / Safari |

Di Windows, perintah `php` di panduan ini artinya `C:\xampp\php\php.exe`. Tambahkan `C:\xampp\php` ke PATH, atau tulis lengkap.

## 2. Pasang pertama kali

1. Nyalakan **Apache** dan **MySQL** di XAMPP Control Panel.
2. Ambil kodenya ke dalam `htdocs` (nama folder bebas; alamatnya mengikuti nama folder):
   ```
   cd C:\xampp\htdocs
   git clone https://github.com/zainnkbp/mall-directory.git bsb-directory
   cd bsb-directory
   git checkout feat/3d-map
   ```
   `git checkout feat/3d-map` hanya perlu selama peta 3D belum digabung ke `main`. Sudah digabung, cukup `main`.
3. Isi database, lalu periksa:
   ```
   php tools/setup.php import
   php tools/setup.php check
   ```
   `import` membuat database `bsb_directory` dari `_handoff/db/bsb_directory.sql`. Semua harus ✔ di `check`. Pesannya menjelaskan yang perlu dibetulkan.
4. Buka alamatnya (bagian 5).

Tidak perlu `mysql.exe` di PATH, tidak perlu phpMyAdmin. Setup cukup PHP.

## 3. Sesudah `git pull`

```
git pull
php tools/setup.php import --force
php tools/setup.php check
```

- `import --force` mengganti isi database dengan versi di repo.
  - Isi lama **dicadangkan otomatis** ke database `bsb_directory_backup_<tanggal>_<jam>`, jadi tidak hilang.
  - Jalankan kalau `git pull` menampilkan `_handoff/db/bsb_directory.sql` berubah, atau kalau `check` bilang "lantai 3D belum cocok".
- Perubahan yang dibuat di CMS komputer ini sejak import terakhir ikut terganti. Kalau masih perlu, ambil dari database cadangan itu, atau kirim dulu lewat bagian 7.
- Kiosk yang sedang terbuka: tekan Ctrl+F5 sekali.

## 4. Akun CMS

Akun CMS ikut di database repo, jadi setelah `import` loginnya **sama dengan komputer asal**:

| | |
|---|---|
| Email | `admin@bsb.local` |
| Password | sama dengan di laptop IT. Minta ke tim IT; tidak ditulis di sini karena repo ini publik. |

- `php tools/setup.php check` menampilkan email akun yang aktif.
- Salah password 5 kali mengunci akun 15 menit.
- Lupa password, atau mau akun sendiri: `php tools/create_admin.php email@contoh.com "Nama"` (password acak dicetak sekali).

## 5. Alamat

| | XAMPP (folder `htdocs/bsb-directory`) | Tanpa XAMPP: `php -S 127.0.0.1:8000 tools/dev_router.php` |
|---|---|---|
| Kiosk | http://localhost/bsb-directory/?attract=0&kiosk=gf-ewalk-left | http://localhost:8000/?attract=0&kiosk=gf-ewalk-left |
| HP | http://localhost/bsb-directory/m/?k=gf-ewalk-left&t=sushi-tei-ff-penta&a=0 | http://localhost:8000/m/?k=gf-ewalk-left&t=sushi-tei-ff-penta&a=0 |
| CMS | http://localhost/bsb-directory/cms/ | http://localhost:8000/cms/ |

Kiosk lain: ganti `kiosk=` dengan `lg-pentacity`, `gf-ewalk-right`, `gf-pentacity`, `ug-ewalk`, `ug-pentacity`, atau `ff-pentacity`. Di CMS, menu **Peta 3D** berisi status tiap lantai 3D dan editor atap (nama, logo, warna).

## 6. Setelan per komputer

- `config.php` sudah cocok untuk XAMPP: database `bsb_directory`, user `root`, tanpa password.
- **Kalau setelan database berbeda** (password root, nama database lain, port lain): salin `config.local.php.example` menjadi `config.local.php` lalu ubah isinya. File itu tidak ikut git, jadi aman dari `git pull`. `setup.php` dan aplikasinya membaca setelan yang sama.
- **HP di jaringan yang sama** (scan QR dari kiosk): isi `PUBLIC_BASE` di `config.js` dengan IP komputer, misalnya `http://192.168.1.20/bsb-directory`. Kompas HP baru jalan lewat HTTPS; lihat `README.md`.

## 7. Mengirim perubahan CMS ke repo

Database tidak tersinkron sendiri. Kalau tenant, jalur, atau peta diubah di CMS dan perubahannya mau dibawa ke komputer lain:

1. **Publish** di CMS.
2. Tulis ulang dump database:
   ```
   php tools/setup.php dump
   ```
3. Commit dan push `_handoff/db/bsb_directory.sql` bersama `data/` dan `media/`.

Satu orang saja yang mengedit CMS pada satu waktu. Dump yang di-push terakhir menimpa yang lain saat di-import.

## 8. Pindah ke hosting cPanel

1. Di komputer yang database-nya paling baru:
   ```
   php tools/setup.php dump --cpanel
   ```
   Hasilnya `bsb_directory_cpanel.sql` (tidak ikut git), tanpa `CREATE DATABASE`. Isinya lengkap, termasuk akun CMS, jadi login di hosting sama dengan di komputer ini.
2. Di cPanel: buat database + user (MySQL Databases), lalu di phpMyAdmin pilih database itu → **Import** → file tadi.
3. Upload semua file aplikasi kecuali `config.local.php`, `_handoff/` dan `.git/`.
4. Di server, salin `config.local.php.example` menjadi `config.local.php`. Isi nama database, user, dan password cPanel, serta `secret` acak.
5. Buka `/cms/`, login, lalu **Publish** sekali.
6. **Segera ganti password admin** di hosting (CMS → Pengguna), karena repo ini publik.

`php tools/export_cpanel_sql.php` (cara lama) masih bisa dipakai, dengan catatan:

- **Data yang dibawa:** dibangun ulang dari `data/directory.json`. Tautan unit 3D, tangga, dan fasilitas sudah ikut.
- **Data yang tidak dibawa:** akun, jadwal tutup, promo, dan tenant yang tidak dipublish.
- **Akunnya:** ikut akun di database komputer yang menjalankannya, jadi loginnya sama. Hanya kalau database itu tidak terbaca, dibuat akun bawaan `admin@bsb.id`; segera ganti password-nya.

## 9. Peta 3D

Ringkasnya:

- **Isi:** semua lantai punya peta 3D (LG, GF, UG, 1F, 2F; GF dan UG gabungan dua gedung).
- **Nama, logo, status tenant:** diatur di halaman Tenant.
- **Jalur:** diatur di Editor graph.
- **Tampilan atap:** diatur di CMS → Peta 3D.
- **Gambar lantai:** dari Illustrator. Konversi ulangnya dikerjakan di laptop IT (web desain).

Detailnya ada di [docs/3D.md](docs/3D.md).

## 10. Kalau ada masalah

| Gejala | Penyebab / solusi |
|---|---|
| `check`: tidak bisa terhubung ke database | MySQL belum menyala di XAMPP, atau setelan database berbeda (bagian 6) |
| `check`: lantai 3D belum cocok | Database masih versi lama: `php tools/setup.php import --force` |
| CMS: "Email atau password salah" | Akunnya ikut database repo (bagian 4). Sudah 5 kali salah: tunggu 15 menit |
| Halaman `/api/...` 404 di XAMPP | `mod_rewrite` mati atau `AllowOverride None` di `httpd.conf`; harus `AllowOverride All` |
| Peta tampil kosong ("segera hadir") | Browser tanpa WebGL (aktifkan akselerasi hardware) atau mode `lite` |
| Port 8000 sudah dipakai | `php -S 127.0.0.1:8080 tools/dev_router.php` lalu pakai `:8080` |

Uji lengkap setelah perubahan besar:

```
php tools/validate.php
node tests/wpc/route_regression.js
php tools/smoke_test.php --cred <file berisi Email/Password> --base http://localhost/bsb-directory
```

`smoke_test.php` mengubah data lalu mengembalikannya dan mem-publish ulang. File `--cred` berisi dua baris `Email   : ...` dan `Password: ...`.
