# Panduan Lengkap CMS: Eskalator, Lift & Jembatan (`#/connectors`)

Dokumen ini menjelaskan fungsi dari setiap tombol, kartu, kolom data, dan alur kerja pemetaan eskalator serta lift pada BSB Directory CMS.

---

## 1. Kenapa Tombol "+ Tambah stop di peta" Terasa Seperti Disable?

Banyak pengguna mengira tombol `+ Tambah stop di peta` akan memunculkan jendela pop-up/formulir isian. **Bukan seperti itu cara kerjanya.**

* **Mekanisme Sebenarnya:** 
  Ketika Anda mengklik tombol `+ Tambah stop di peta` pada baris lantai tertentu (misalnya **2F**):
  1. Panel **Peta** di sebelah kanan otomatis beralih ke lantai 2F.
  2. Kursor pada peta berubah menjadi **tanda bidik (crosshair `+`)**.
  3. Di bagian peta muncul petunjuk: *"Klik titik naik/turun di denah"*.
* **Langkah Penyelesaian:**
  Setelah menekan tombol tersebut, **arahkan mouse ke denah lantai di panel sebelah kanan dan KLIK tepat pada posisi fisik pintu lift atau bordes eskalator.** Titik stop baru akan langsung dibuat dan terhubung ke koridor terdekat.

---

## 2. Anatomi Antarmuka: Penjelasan Seluruh Komponen

### A. Bagian Atas (Header Unit / Bank)
* **Toggle "Bank aktif":** Menghidupkan atau mematikan seluruh unit ini sekaligus. Jika dimatikan, semua lantai pada lift/eskalator ini tidak akan pernah dipakai oleh mesin rute kiosk.
* **Badges:** Menampilkan jenis (`Eskalator` / `Lift`), gedung (`E-Walk` / `Pentacity`), dan ID sistem (misal `esc-c-ewalk`).
* **Tombol "Ubah info" (Pensil):** Mengubah nama bahasa Indonesia, bahasa Inggris, patokan lokasi (landmark), atau kode unit.
* **Dropdown "Jadwal":** Menentukan jam operasional unit (default: `jam mall`).
* **Tombol "Tutup semua leg" (Obeng):** Menutup seluruh lantai unit ini sementara (misalnya saat seluruh gedung mati lampu atau unit sedang overhaul).

---

### B. Kotak Notifikasi / Peringatan (Callouts)
* **Kotak Hijau (`Tidak ada leg ke 1F... lantai ini tetap terjangkau via...`):** Informasi sistem bahwa lantai 1F memang tidak dijangkau oleh unit ini, tetapi pengunjung tidak terjebak karena masih ada eskalator/lift lain yang menjangkau lantai tersebut.
* **Kotak Oranye (`W_STOP_DANGLING` - Stop buntu):** Peringatan bahwa ada titik stop (pintu/bordes) yang sudah ditaruh di peta, tetapi **belum disambungkan dengan jalur vertikal (leg)** ke lantai atas atau bawahnya. Contoh di gambar: `esc-c-ewalk-ug-2 · buntu`.

---

### C. Tumpukan Lantai (Floor Stack)
* **Badge Lantai (2F, 1F, UG, GF, LG):** Menunjukkan tingkatan lantai secara vertikal dari atas ke bawah.
* **Chip Stop (contoh: `● esc-c-ewalk-ug`):**
  * Titik fisik tempat orang berdiri atau keluar masuk.
  * Lingkaran hitam solid (`●`): Stop aktif dan terhubung normal.
  * Lingkaran oranye (`○ · buntu`): Stop ditaruh tapi belum punya sambungan ke atas/bawah.
  * Jika chip diklik, peta di kanan akan langsung fokus dan men-zoom titik tersebut.
* **Tombol `[✕]` di samping Chip:** Menghapus titik fisik tersebut dari denah.
* **Tombol `+ Tambah stop di peta` vs `+ Stop`:** Keduanya identik. Tombol bertuliskan `+ Stop` muncul jika lantai tersebut sudah memiliki setidaknya satu stop (misalnya untuk eskalator sepasang yang titik naik dan turunnya berbeda).
* **Checkbox "Berhenti di lantai ini" (Khusus Lift):** Menandakan apakah lift membuka pintu di lantai ini. Jika tidak dicentang (misal lift express yang melewati lantai tanpa pintu), lift tidak akan menurunkan pengunjung di lantai tersebut.

---

### D. Kartu Sambungan Vertikal (Leg Card — contoh: `L19 GF↔UG`)
Ini adalah pengaturan jalur vertikal antara dua lantai yang berdekatan:

* **`L19`:** Nomor identitas (ID) jalur di database.
* **`GF ↔ UG`:** Menunjukkan leg ini menghubungkan lantai Ground Floor dan Upper Ground.
* **Toggle "Aktif / Nonaktif":** Menentukan apakah jalur antar dua lantai ini boleh dilewati rute kiosk.
* **Pilihan Arah ("Dua arah", "Naik saja", "Turun saja"):**
  * Untuk **Lift**: Selalu *Dua arah*.
  * Untuk **Eskalator**: Menentukan arah fisik pergerakan eskalator di mall. Jika diatur *Naik saja*, maka rute dari lantai UG ke GF tidak akan pernah diarahkan lewat sini.
* **Dropdown "Jadwal":** Bisa mengikuti jam bank (`Ikut bank`) atau punya jam sendiri.
* **Kolom "Biaya" (contoh `19.2` auto):**
  * **Apa itu Biaya (Cost)?** Ini adalah bobot jarak dan waktu yang dihitung oleh algoritma pencari rute (A* / Dijkstra).
  * Semakin kecil nilainya, semakin mesin rute memprioritaskan jalur ini.
  * `auto` dihitung otomatis dari estimasi waktu naik eskalator (~25 detik).
  * Jika diisi angka manual (override), sistem akan memakai angka tersebut. Misalnya, jika ingin eskalator ini dijadikan pilihan utama, beri angka biaya yang lebih rendah.
* **Checkbox "Sudah dicek di lapangan":** Tanda verifikasi fisik bahwa staf atau teknisi sudah mengecek langsung arah dan fungsi eskalator di lokasi nyata.
* **Kolom "Catatan lapangan":** Catatan bebas untuk operasional internal (contoh: *unit sisi timur dekat kasir*).
* **Tombol "Tutup sementara" (Obeng):** Digunakan saat eskalator rusak/servis harian. Mesin rute kiosk otomatis akan membelokkan rute pengunjung lewat lift atau eskalator alternatif lain selama penutupan aktif.
* **Tombol Sampah `[🗑]`:** Menghapus koneksi vertikal antar lantai ini secara permanen.

---

### E. Panel Peta (Sebelah Kanan)
* **Floor Switcher (2F, 1F, UG, GF, LG):** Memilih denah lantai yang ingin dilihat.
* **Titik Biru di Peta:** Posisi fisik titik stop yang sedang dipilih atau aktif.
* **Garis Abu-abu di Peta:** Jaringan koridor pejalan kaki (jalan mall).
* **Zoom (+ / -) dan Fullscreen:** Navigasi denah.
* **Teks Kaki Peta (`esc-c-ewalk-gf · GF · node n234`):** Menunjukkan nama stop, nama lantai, dan nomor titik graph (`node`) koridor yang tersambung.

---

## 3. Langkah Praktis Menyelesaikan Status di Gambar Anda

Pada gambar yang Anda kirimkan:
1. Di lantai **UG**, terdapat dua stop: `esc-c-ewalk-ug` dan `esc-c-ewalk-ug-2 · buntu`.
   * Jika titik kedua itu tidak sengaja terbuat (salah klik), klik tanda **`[✕]`** di samping `esc-c-ewalk-ug-2` untuk menghapusnya agar peringatan `W_STOP_DANGLING` hilang.
2. Jika Anda ingin menghubungkan eskalator ini hingga lantai **1F**:
   * Klik tombol **`+ Tambah stop di peta`** di baris **1F**.
   * Klik posisi ujung eskalator pada **denah lantai 1F di panel sebelah kanan**.
   * Setelah stop di 1F muncul, tombol **`Buat leg`** akan muncul di antara baris UG dan 1F. Klik untuk menghubungkan keduanya!
3. Setelah semua sesuai, klik tombol **`[🚀 Publish]`** di kanan atas.
