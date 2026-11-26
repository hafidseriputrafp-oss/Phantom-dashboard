# Phantom Dashboard Hub — GARUDA Operation

Kumpulan dashboard IoT berbasis Ubidots yang bisa dibuat dan diubah dari HP maupun laptop.
Situsnya statis untuk GitHub Pages: tanpa backend dan tanpa build tool.

| Alamat | Isi |
|--------|-----|
| `/` ([`index.html`](index.html), [`home.js`](home.js)) | **Beranda**: daftar dashboard, tambah/ubah/duplikat/hapus |
| `/robot/` ([`robot/`](robot/)) | **Robot Phantom**: dashboard kontrol robot rescue (D-pad, STOP darurat, failsafe) |
| `/dash/?id=<id>` ([`dash/`](dash/)) | **Builder**: menampilkan & mengedit dashboard buatan sendiri |
| [`shared/`](shared/) | Kode bersama: `token.js` (layar token untuk semua halaman), tema, API Ubidots + antrean request, sinkron cloud |
| [`firmware/`](firmware/) | Firmware ESP32 robot Phantom: `phantom_tes` (latihan) dan `phantom_lomba` (kirim ke web dosen) |

Setelah GitHub Pages aktif:

- Beranda: https://hafidseriputrafp-oss.github.io/Phantom-dashboard/
- Robot: https://hafidseriputrafp-oss.github.io/Phantom-dashboard/robot/
- Data Logger: https://hafidseriputrafp-oss.github.io/Phantom-dashboard/dash/?id=logger

## 1. Aktifkan GitHub Pages

1. Buka repo di GitHub, lalu **Settings → Pages**.
2. **Source**: *Deploy from a branch*. **Branch**: `main`, folder `/ (root)`, lalu **Save**.
3. Setelah 1–2 menit situs bisa dibuka di `https://<username>.github.io/<nama-repo>/`.

> **Setiap mengubah file CSS/JS**, naikkan angka `?v=` pada `<link>`/`<script>` di `index.html`,
> `robot/index.html`, dan `dash/index.html`. GitHub Pages menyuruh browser menyimpan file sampai
> 10 menit; tanpa angka versi baru, HP bisa memuat HTML baru dengan JavaScript lama sehingga
> halaman tampil kosong.

## 2. Login & sinkron antar perangkat

- **Token Ubidots tidak pernah disimpan di repo atau di URL.** Semua halaman (Beranda, `/robot/`,
  `/dash/`) memakai satu file bersama [`shared/token.js`](shared/token.js):
  1. Saat dibuka tanpa token, muncul layar **"Masukkan Token Ubidots"** (kolom token + tombol
     Tampilkan/Sembunyikan + **Masuk**).
  2. **Masuk** mengecek token dengan satu request ringan `GET /api/v2.0/devices/?page_size=1`
     (header `X-Auth-Token`):
     - 200 → token disimpan di `localStorage` key **`phantom_ubidots_token`**, lalu dashboard terbuka;
     - 401/403 → **"Token tidak valid"**;
     - gagal jaringan → **"Tidak ada koneksi"**.
  3. Kunjungan berikutnya langsung masuk. Kalau di tengah pemakaian Ubidots menjawab 401/402/403
     (token dicabut atau kuota habis), semua halaman kembali ke layar token dengan pesan
     **"Token tidak berlaku, masukkan token baru"**.
  4. Tombol kecil **🔑 Ganti token** di header setiap dashboard menghapus token lalu kembali ke layar token.
  - Cukup input sekali untuk semua halaman. Token lama (key `phantom.token`) dipindah otomatis.
- **Akun Ubidots baru (masih kosong):** setelah token diterima, dashboard menyiapkan akun sekali di
  latar belakang:
  - device `phantom` dan variabel kontrol (`gerak` 0, `speed` 150, `lengan` 0, `capit` 110,
    `kirim_hotspot` 0, `batas_suhu` = batas di Pengaturan) ditulis sebagai nilai awal. Ini dilakukan hanya
    untuk variabel yang belum ada;
  - variabel sensor/ACK robot dan device `logger` (`suhu_objek`, `data_ke`, `http_code`) dibuat kosong,
    tanpa data palsu.

  Selama variabel belum punya data, kartu menampilkan **"Belum ada data"**, bukan error.
- **Konfigurasi semua dashboard disimpan di Ubidots**, supaya sama di HP dan laptop:
  - device **`dashboard-config`**, satu variabel per dashboard: **`cfg_<id>`** (mis. `cfg_logger`);
  - **value** dot = nomor versi; **context** dot = isi JSON konfigurasi;
  - context Ubidots dibatasi **1 KB per dot** dan satu request maksimal **10.000 byte**, jadi JSON
    dikompres (deflate) lalu dipecah menjadi beberapa dot (±600 karakter per dot, maks. 12 dot)
    yang dikirim dalam **satu request**. Konfigurasi biasa hanya butuh 1–3 dot.
- Saat halaman dibuka, versi di cloud dibandingkan dengan salinan lokal dan yang lebih baru dipakai.
  Saat disimpan, dot baru dikirim. Status tampil di header: **☁ Tersimpan ke cloud**,
  **✎ Belum disimpan ke cloud**, atau pesan error yang jelas (token salah, offline, 429, …).
- **Cadangan lokal:** semua konfigurasi juga disimpan di `localStorage` (`phantom.hub`), dan bisa
  diunduh/diunggah lewat **Export JSON / Import JSON** (Beranda: semua dashboard; builder: satu
  dashboard).
- Tema warna & mode gelap/terang dipakai bersama semua halaman (termasuk robot).

## 3. Beranda: mengelola dashboard

- Setiap kartu menampilkan nama, ikon, device label, dan status **Online/Offline** device itu.
- **+ Tambah Dashboard**: isi nama, ikon (emoji), device label utama, lalu pilih *Kosong* atau
  *Salinan preset Data Logger*. Dashboard langsung terbuka dalam Mode Edit.
- Menu **⋮** tiap kartu: **Buka**, **Ubah nama & ikon**, **Duplikat**, **Hapus** (dengan konfirmasi).
- Dua dashboard bawaan: **Robot Phantom** (link ke `/robot/`) dan **Data Logger**
  (`/dash/?id=logger`). Menghapus dashboard bawaan harus mengetik `HAPUS`, dan bisa dikembalikan
  dengan tombol **Pulihkan bawaan**.

## 4. Builder: Mode Edit & jenis widget

Buka dashboard, lalu klik **✎ Edit**:

- **+ Widget** untuk menambah; **klik widget** untuk mengubah; **✕** untuk menghapus.
- **Seret ⠿** untuk mengurutkan (mouse maupun sentuhan jari).
- Ukuran **S / M / L**: di desktop 4 / 2 / 1 per baris, di HP 2 / 1 / 1 per baris.
- Setiap widget memilih **device label dan variabel sendiri**, jadi satu dashboard bisa
  menggabungkan beberapa device.
- **Selesai & simpan** mengirim konfigurasi ke cloud. **⚙ Pengaturan** dashboard: nama, ikon,
  device utama, interval refresh, batas online untuk Beranda, tema & mode.

| Widget | Isi |
|--------|-----|
| **Kartu angka** | nilai terakhir, satuan, desimal, ikon, warna, ambang waspada/bahaya (> atau <), opsional menampilkan `context.<kunci>` |
| **Waktu/teks dari context** | menampilkan `context.<kunci>` dot terakhir (mis. `waktu`); kalau tidak ada, timestamp dot dalam WIB |
| **Indikator kode** | peta nilai → warna & teks. Default HTTP: 200 OK (hijau), -1 tidak ada jaringan, 401 token salah, 429 terlalu sering, lainnya merah |
| **Grafik garis** | 1–3 variabel dari satu device, jumlah titik bisa diatur |
| **Tabel riwayat** | N data terakhir: Waktu (context), Nilai, Diterima server (WIB), Selisih (detik), tombol **Export CSV** |
| **Status online** | ONLINE jika data terakhir (seluruh device atau satu variabel) lebih baru dari X detik |
| **Kontrol** | tombol, toggle, atau slider yang mengirim nilai ke variabel |
| **Link / kamera** | buka URL di tab baru; mode kamera mengubah IP menjadi `http://IP:81/stream` |
| **Teks catatan** | catatan bebas |

Format JSON export sama dengan yang disimpan di cloud; satu dashboard berbentuk
`{ "app": "phantom-hub-dashboard", "dashboard": { "id", "name", "icon", "device", "refreshS", "historyS", "widgets": [...] } }`.

## 5. Preset "Data Logger" (device `logger`)

ESP32 data logger (program `phantom_lomba`, lihat bagian 11) mengirim ke device **`logger`**:

| Variabel | Isi |
|----------|-----|
| `suhu_objek` | suhu objek MLX90614 (°C), dot dengan **timestamp RTC** dan context `{"waktu":"YYYY-MM-DD HH:MM:SS"}` |
| `data_ke` | nomor urut data di file microSD saat ini |
| `http_code` | kode HTTP kiriman sebelumnya (200, -1, 401, 429, …) |

Widget bawaan: Status online (30 dtk), Kartu `data_ke`, Indikator `http_code`, dan Grafik
`suhu_objek` 50 titik. **Reset ke preset** (Mode Edit) mengembalikan widget bawaan. Dashboard
Data Logger yang tersimpan dengan preset lama (suhu ambient) otomatis diganti ke preset ini.
Kalau sudah diubah sendiri, dashboard itu tidak disentuh; pakai **Reset ke preset**.

## 6. Batas request Ubidots STEM (1 request/detik)

- Setiap halaman punya **satu antrean global** dengan jarak minimal **1,1 detik** antar request.
- Nilai terakhir dibaca **1 request per device** (`GET /api/v2.0/devices/~<label>/variables/`)
  setiap *Refresh nilai* (default 5 dtk). Grafik/tabel dibaca 1 request per variabel setiap
  *Refresh grafik/tabel* (default 30 dtk). Keduanya bisa diatur di ⚙ Pengaturan dashboard.
- Perintah kontrol didahulukan dari pembacaan data.
- **HTTP 429** ditangani dengan backoff (2 → 4 → 8 … maks. 60 dtk) dan hitung mundur di banner.

---

# Dashboard Robot Phantom (`/robot/`)

## 7. Robot: siapkan Ubidots

1. Login ke Ubidots (industrial.ubidots.com), lalu buka **API Credentials** dan salin **Token**
   (sebaiknya buat token khusus untuk robot ini).
2. Buat device dengan label **`phantom`**. Device juga dibuat otomatis saat robot pertama kali online.
3. Pastikan variabel berikut ada di device (label harus sama persis):

| Variabel        | Arah               | Isi                                                              |
|-----------------|--------------------|------------------------------------------------------------------|
| `suhu_objek`    | robot → dashboard  | Suhu objek MLX90614 (°C)                                         |
| `hotspot`       | robot → dashboard  | 1 = hotspot sudah diterima web dosen (Firebase)                  |
| `fb_code`       | robot → dashboard  | Kode HTTP kiriman terakhir ke web dosen (200 = berhasil)         |
| `fb_jenis`      | robot → dashboard  | Jenis kiriman terakhir: 1 = data suhu + wifi, 2 = hotspot        |
| `fb_suhu`       | robot → dashboard  | Suhu yang ikut dikirim ke web dosen                              |
| `ack_gerak`     | robot → dashboard  | Balasan: kode gerak yang benar-benar dijalankan (hanya saat berubah) |
| `ack_lengan`    | robot → dashboard  | Balasan: sudut lengan setelah dibatasi robot                     |
| `ack_capit`     | robot → dashboard  | Balasan: sudut capit setelah dibatasi robot                      |
| `gerak`         | dashboard → robot  | 0 stop, 1 maju, 2 mundur, 3 putar kiri, 4 putar kanan, 5 maju-kiri, 6 maju-kanan, 7 mundur-kiri, 8 mundur-kanan |
| `speed`         | dashboard → robot  | PWM 0–255 (maju/mundur/lengkung; putar di tempat selalu 255)     |
| `lengan`        | dashboard → robot  | Sudut servo lengan (derajat)                                     |
| `capit`         | dashboard → robot  | Sudut servo capit (derajat)                                      |
| `batas_suhu`    | dashboard → robot  | Batas suhu hotspot (°C), diatur di ⚙ Pengaturan                  |
| `kirim_hotspot` | dashboard → robot  | 1 = minta robot kirim hotspot sekarang (tombol cadangan)         |

Di akun baru, semua variabel di atas disiapkan otomatis oleh dashboard setelah token diterima
(lihat bagian 2), jadi subscribe MQTT robot langsung mendapat nilai.

## 8. Robot: isi token

1. Buka `/robot/` (atau kartu **Robot Phantom** di Beranda). Kalau sudah masuk di Beranda, token langsung terpakai.
   Kalau belum, isi token di layar **"Masukkan Token Ubidots"**, lalu **Masuk**. Device label (default
   `phantom`) diubah di ⚙ Pengaturan.
2. Token dicek ke Ubidots (lihat bagian 2).
3. Untuk pindah akun Ubidots, tekan **🔑** (Ganti token) di header, lalu masukkan token akun baru.

## 9. Robot: menggunakan dashboard

Halaman `/robot/` dibuat untuk **HP landscape, satu layar tanpa scroll** (juga jalan di laptop).
Kalau HP dipegang tegak, muncul ajakan memutar HP (bisa dilewati dengan **Tetap pakai portrait**).
Tombol **⛶** membuka layar penuh dan mengunci landscape (Chrome Android).

Kalau bilah alamat browser masih terlihat, tinggi layar tinggal ±300 px. Dalam keadaan itu grafik
disembunyikan, kartu SPEED/LENGAN/CAPIT dipadatkan supaya tombol gerak tetap besar, dan tombol **⛶**
menyala sebagai pengingat. Tekan **⛶** agar semua bagian (termasuk grafik) tampil.

Dibuat untuk **dua ibu jari**:

- **Kiri (ibu jari kiri):** kotak angka **SPEED** (PWM 0–255) dan teks arah di atas; tombol besar
  **▲ MAJU** dan **▼ MUNDUR** di pojok kiri bawah.
- **Kanan (ibu jari kanan):** **LENGAN** (NAIK / BAWA / TURUN + kotak angka) dan **CAPIT** (BUKA / TUTUP +
  kotak angka) di atas; tombol besar **◀ KIRI** dan **▶ KANAN** di pojok kanan bawah.
- Tahan tombol supaya robot bergerak, lepas untuk berhenti (`gerak=0`, dikirim seketika).
  **Ketuk sekali** = robot bergerak sebentar (minimal 0,25 detik) lalu berhenti, jadi bisa dipakai
  untuk menggeser posisi sedikit demi sedikit. Kombinasi dua ibu jari:

  | Kiri | Kanan | Gerak |
  |------|-------|-------|
  | ▲ | — | maju (1) |
  | ▼ | — | mundur (2) |
  | — | ◀ / ▶ | putar di tempat kiri / kanan (3 / 4) |
  | ▲ | ◀ / ▶ | maju belok melengkung kiri / kanan (5 / 6) |
  | ▼ | ◀ / ▶ | mundur belok melengkung kiri / kanan (7 / 8) |

  Di laptop bisa pakai panah/WASD (W+D = maju-kanan, dst.), **Spasi** = STOP darurat.
- **Tengah:** **SUHU OBJEK** besar (hijau NORMAL, kuning MENDEKATI, merah 🔥 HOTSPOT saat ≥ batas),
  grafik suhu dengan garis batas, kartu **WEB DOSEN** (status hotspot, isi kiriman terakhir seperti
  `{"suhu":51.2,"wifi":true}` atau `{"hotspot":true}` beserta hasilnya: 200 = berhasil, 401 = database
  dosen masih dikunci), dan **STOP DARURAT**. Tombol **KIRIM HOTSPOT (cadangan)** hanya aktif saat robot
  online dan suhu ≥ batas; pengiriman utama tetap otomatis dari robot (program lomba).

Tombol STOP dan preset servo langsung bereaksi saat disentuh, jadi tetap jalan walaupun ibu jari
lain sedang menahan tombol gerak.

**Kotak angka (SPEED, LENGAN, CAPIT).** Slider sudah diganti, karena di robot asli slider tidak mau
berubah/terkirim.

1. Ketuk kotaknya. Keyboard angka muncul.
2. Ketik nilai, lalu tekan **KIRIM** atau **Enter**.

| Kotak | Batas (default) |
|-------|-----------------|
| SPEED | 0–255 (tetap) |
| LENGAN | MIN–MAX dari **Batas Servo** (default 0–180) |
| CAPIT | MIN–MAX dari **Batas Servo** (default 25–140) |

- Nilai di luar MIN–MAX otomatis dipotong ke batas terdekat, dan muncul teks kecil merah
  **"dibatasi ke X"**. Contoh dengan default: LENGAN 200 → dikirim 180.
- Angka di sebelah nama (mis. `LENGAN 60°`) adalah nilai aktif terakhir yang dikirim.
- Tombol preset NAIK/BAWA/TURUN dan BUKA/TUTUP langsung mengirim sudutnya.

**Pengaturan (⚙):** device label, interval baca data (default 3 detik), batas hotspot (default
50 °C, ikut dikirim ke robot sebagai `batas_suhu`), **Jalur cepat MQTT** (default aktif), **Batas Servo**,
tema warna, dan mode Gelap/Terang. Semua tersimpan di `localStorage` browser itu. Token diganti lewat tombol 🔑.

**Batas Servo (di ⚙ Pengaturan).** Bagian ini dipakai untuk mengatur rentang dan tombol preset:

| Servo | Kotak | Default |
|-------|-------|---------|
| Lengan | MIN, MAX, NAIK, BAWA, TURUN | 0, 180, 0, 60, 180 |
| Capit | MIN, MAX, BUKA, TUTUP | 25, 140, 25, 110 |

- **SIMPAN** menyimpan ke browser. Nilainya langsung dipakai oleh kotak angka (KIRIM dipotong ke
  MIN–MAX) dan tombol preset. **RESET DEFAULT** mengembalikan dan menyimpan nilai default.
- **Validasi:** semua angka 0–180, MIN harus lebih kecil dari MAX, dan setiap preset harus di antara
  MIN dan MAX. Kalau salah, muncul pesan merah dan tidak ada yang disimpan. Tombol Simpan utama juga
  ditahan sampai batasnya benar.
- Batas di firmware (`LENGAN_MIN/MAX`, `CAPIT_MIN/MAX`) tetap berlaku. Angka di luar batas firmware
  akan dipotong oleh robot, dan baris status menampilkan sudut hasil robot.

### Kecepatan respons perintah

Jalur perintah selalu lewat internet: **HP → Ubidots → ESP32** (robot tidak pernah jadi hotspot).
Supaya terasa secepat mungkin:

- **Perintah gerak tidak antre.** Begitu tombol disentuh, `gerak` langsung dikirim (tidak menunggu
  jeda 1,1 detik seperti request lain). Perintah dikirim **berurutan**, jadi `0` (berhenti) tidak
  pernah mendahului arah, dan ketukan singkat tidak hilang.
- **Jalur cepat MQTT:** dashboard tersambung langsung ke broker Ubidots lewat WebSocket
  (`wss://industrial.api.ubidots.com:8084`, token sebagai username) dan mengirim perintah ke topik
  `/v1.6/devices/phantom`, sama seperti robot. Kalau broker tidak bisa dihubungi, dashboard otomatis
  memakai REST API dan mencoba MQTT lagi di latar belakang.
- Di atas layar ada indikator jalur dan waktu respons perintah terakhir, misalnya `MQTT 120 ms` atau
  `REST 450 ms` (kuning kalau > 800 ms). Pakai angka ini untuk mengecek sinyal hotspot HP.
- Kalau jaringan macet lebih dari 0,6 detik saat tombol dilepas, `gerak=0` langsung dikirim secara
  paralel (ketukan yang belum sempat terkirim dibuang), lalu sekali lagi setelah perintah sebelumnya
  selesai, jadi robot pasti berhenti. **STOP DARURAT** selalu dikirim seketika dan diulang sekali.

### Status perintah: apakah robot benar-benar menjalankan?

Di bawah teks arah (kolom kiri) dan di atas tombol ◀ ▶ (untuk lengan/capit) ada baris status:

| Status | Arti |
|--------|------|
| `⏳ MAJU dikirim…` | tombol baru ditekan |
| `📡 MAJU sampai di server` | broker Ubidots sudah menerima (PUBACK MQTT / REST 200) |
| `✅ MAJU terlaksana (420 ms)` | robot membalas lewat `ack_gerak`; angka = waktu dari tombol ditekan sampai balasan masuk |
| `❌ Robot tidak membalas` | 5 detik tanpa balasan, termasuk sesudah kirim ulang (robot mati, WiFi robot putus, atau firmware lama) |

Untuk servo: `✅ CAPIT 110° terlaksana (…)`. Kalau robot membatasi sudut, yang tampil adalah sudut
hasil robot. Menahan tombol (heartbeat) tidak mengulang status. Kalau robot berhenti sendiri karena
failsafe saat tombol masih ditahan, muncul `⚠ Robot berhenti sendiri (failsafe)`. Balasan robot hanya
bisa diterima lewat jalur MQTT. Saat dashboard memakai REST, status berhenti di 📡.

### Batas request Ubidots di dashboard robot

- Semua variabel device dibaca dengan **1 request** (`GET /api/v2.0/devices/~phantom/variables/`).
- Request baca/servo lewat antrean dengan jarak minimal 1,1 detik; nilai servo/speed digabung (hanya nilai
  terakhir yang dikirim). Lewat MQTT, servo dan gerak tidak memakai kuota REST.
- Saat memakai REST, polling dijeda selama menyetir sampai 1,5 detik setelah berhenti.
- **`gerak` hanya dikirim saat perintah berubah** (MAJU, STOP, KIRI, …). Ketuk MAJU → STOP = 2 kiriman.
  - Kalau lewat MQTT robot belum membalas (`ack_gerak`), perintah terakhir dikirim ulang. Gerak
    dikirim ulang setelah 2 detik, maksimal 2 kali; STOP setelah 1,5 detik, maksimal 4 kali. Kiriman
    yang hilang (mis. kena batas laju akun gratis) tetap sampai. Kalau robot sudah membalas, tidak ada
    kiriman ulang.
  - Hanya kalau tombol **ditahan lebih dari 5 detik**, `gerak` yang sama dikirim lagi tiap 5 detik
    sebagai pengaman: kalau HP putus internet, robot berhenti sendiri setelah 8 detik.
- Jika Ubidots membalas **HTTP 429**, dashboard menunggu otomatis (backoff 2 → 4 → 8 … maks. 60 detik);
  perintah berhenti tetap dicoba ulang sampai terkirim.

## 10. Robot: tampilan lama

Mode Edit, kartu baterai, dan tombol kamera dari versi lama dihapus supaya layar kontrol muat satu
layar HP. Versi lama masih ada di riwayat commit Git kalau diperlukan.


## 11. Firmware ESP32 (dua program)

**Board:** ESP32 Dev Module (Arduino IDE: *Tools → Board → ESP32 Dev Module*), core ESP32 3.x.
Ada dua sketch, masing-masing di foldernya sendiri:

| Sketch | Untuk | Isi |
|--------|-------|-----|
| [`firmware/phantom_tes/`](firmware/phantom_tes/) | **Tes / latihan** | Kontrol gerak 0–8, servo lengan & capit, MLX90614 ke dashboard, RTC DS3231, log microSD. Tanpa batas suhu dan tanpa kirim ke web dosen. |
| [`firmware/phantom_lomba/`](firmware/phantom_lomba/) | **Lomba** | Kontrol & sensor seperti program tes **+ kirim ke web dosen** (Firebase): data suhu tiap 5 detik dan hotspot saat suhu ≥ batas, **+ data logger** `/dataNN.txt` + device Ubidots `logger` tiap 10 detik. |

Keduanya sudah diuji kompilasi (`arduino-cli`, ESP32 Dev Module, core esp32 3.3.2): tes ±77% flash, lomba ±86%.

**Library** (Library Manager):

- Ubidots MQTT for ESP32 and ESP8266 (`UbidotsESPMQTT.h`, versi ≥ 1.2) + PubSubClient
- ESP32Servo
- Adafruit MLX90614 (+ Adafruit BusIO)
- RTClib (Adafruit)
- ArduinoJson (Benoit Blanchon, versi 7) — hanya program lomba

> **Kalau muncul error `ESP8266WiFi.h: No such file or directory`:** buka
> `Arduino/libraries/<ubidots-mqtt-esp>/src/UbidotsESPMQTT.h`, lalu ganti baris
> `#include <ESP8266WiFi.h>` dengan:
>
> ```cpp
> #if defined(ESP32)
> #include <WiFi.h>
> #else
> #include <ESP8266WiFi.h>
> #endif
> ```

**Kredensial (`secrets.h`):** repo ini publik, jadi token Ubidots, WiFi, dan alamat web dosen **tidak**
ditulis di sketch. Isi `secrets.h` hanya **nilai default**; WiFi dan token bisa diganti lewat portal
**Phantom-Setup** tanpa upload ulang (lihat bagian 12). Di tiap folder sketch, salin `secrets.example.h`
menjadi `secrets.h`, lalu isi:

```cpp
#define SECRET_WIFI_SSID     "nama hotspot HP"
#define SECRET_WIFI_PASS     "password hotspot HP"
#define SECRET_UBIDOTS_TOKEN "BBUS-..."
#define SECRET_FIREBASE_URL  "https://...firebasedatabase.app/missions/teamXX.json"   // hanya program lomba
```

`secrets.h` sudah masuk `.gitignore`, jadi tidak ikut ter-upload ke GitHub.

**Pin (ESP32 30-pin)**. Pin strapping 2, 12, 15 tidak dipakai. GPIO0 hanya **dibaca** sebagai tombol BOOT
(portal Phantom-Setup). GPIO5 hanya dipakai sebagai CS microSD (pin SS bawaan VSPI, aman karena CS dalam
keadaan HIGH saat boot).

| Fungsi                   | GPIO |
|--------------------------|------|
| I2C SDA / SCL (MLX90614 0x5A, DS3231 0x68 + EEPROM 0x57) | 21 / 22 |
| microSD SCK / MISO / MOSI / CS | 18 / 19 / 23 / 5 |
| L298N ENA (PWM kiri) / IN1 / IN2 | 25 / 26 / 27 |
| L298N IN3 / IN4 / ENB (PWM kanan) | 32 / 33 / 4 |
| Servo lengan / capit     | 16 / 17 |
| Tombol BOOT (portal Phantom-Setup) | 0 |

Catatan wiring:

- Lepas jumper ENA/ENB di L298N. Motor kiri diparalel ke OUT1/OUT2, motor kanan ke OUT3/OUT4.
- Servo diberi daya dari baterai servo (4,8–6 V), bukan dari pin 3V3/5V ESP32.
  **Semua GND harus disatukan.**
- Kalau arah roda terbalik, ubah `MOTOR_KIRI_BALIK` / `MOTOR_KANAN_BALIK` (hasil tes: roda kanan
  terbalik, jadi `MOTOR_KANAN_BALIK = true`). Kalau belok melengkung terlalu tajam/landai, ubah
  `CURVE_RATIO` (kecepatan roda sisi dalam, default 0,4).
- **Putar di tempat (◀ KIRI / ▶ KANAN, gerak 3/4) selalu memakai `TURN_SPEED` = 255** lewat
  `putarDiTempat()`. Di PWM 150 robot tidak mau berputar, karena kedua roda saling menahan. Maju, mundur,
  dan belok melengkung tetap memakai nilai SPEED dari dashboard.
- Sudut servo dikirim langsung dari dashboard (derajat) dan dibatasi di firmware dengan `constrain()`.
  Batas hasil kalibrasi di robot asli:

  | Servo | Batas firmware | Arti | Posisi awal saat menyala | Tombol dashboard |
  |-------|----------------|------|--------------------------|------------------|
  | Lengan (MG996R, arah terbalik) | `LENGAN_MIN`–`LENGAN_MAX` = 0–180° | 0° = naik mentok atas, 180° = turun maksimal | `LENGAN_AWAL` = 0° (NAIK) | NAIK 0°, BAWA 60°, TURUN 180° |
  | Capit | `CAPIT_MIN`–`CAPIT_MAX` = 25–140° | 25° = buka, makin besar makin menutup | `CAPIT_AWAL` = 110° (TUTUP) | BUKA 25°, TUTUP 110° |

  Rentang dan preset di dashboard diatur di ⚙ Pengaturan → **Batas Servo** (lihat bagian 9). Pengaturan
  lengan/capit lama yang tersimpan di browser otomatis diganti ke default baru (pengaturan versi 8).
  Versi 9: MAX capit yang masih 110 dinaikkan ke 140; nilai lain tetap. Pengaturan lain tidak disentuh.
- Nama client MQTT tetap `garuda13-phantom` (`MQTT_CLIENT`), tidak lagi `00:00:00:00:00:00`.
- **Balasan (ACK):** setelah perintah dijalankan, robot mengirim `ack_gerak` / `ack_lengan` /
  `ack_capit` ke Ubidots dari `loop()` (`kirimUbidots()`), tidak dari callback MQTT.
- **Robot publish maks. 1 kali per detik** (`PUBLISH_JEDA_MS`). ACK, `suhu_objek`, dan hasil web dosen
  (program lomba) digabung dalam satu publish (maks. 5 nilai). Dulu ketiganya dikirim terpisah, sehingga
  bisa beberapa pesan dalam satu detik dan melewati batas laju akun Ubidots gratis.
- **Subscribe ulang otomatis:** saat (re)connect robot subscribe semua variabel kontrol. Variabel yang
  belum pernah mengirim pesan di-subscribe ulang tiap 10 detik (`SUB_ULANG_MS`), sampai pesan pertama
  diterima. Dengan begitu robot tetap menerima perintah walaupun variabelnya baru dibuat dashboard setelah robot
  menyala (akun baru). Di Serial Monitor tampil `Subscribe ulang <variabel> (belum ada pesan)`.
- Setiap MQTT putus tercatat di Serial Monitor: `MQTT terputus (ke-N), motor berhenti, sambung ulang...`.
  `ack_gerak` hanya dikirim saat gerak berubah (heartbeat dengan nilai sama tidak dibalas), saat
  failsafe menghentikan motor (0), dan saat (re)connect (0).

**Fitur keamanan:**

- Motor berhenti saat WiFi/MQTT robot putus.
- Motor juga berhenti kalau tidak ada perintah `gerak` lebih dari `FAILSAFE_TIMEOUT_MS` = 8 detik. Selama
  tombol ditahan, dashboard mengulang perintah tiap 5 detik (`HEARTBEAT_MS`), jadi robot hanya berhenti
  sendiri kalau HP putus. STOP tidak mengunci robot: perintah gerak berikutnya langsung dijalankan.
- WiFi *modem sleep* dimatikan (`WiFi.setSleep(false)`), supaya perintah dari Ubidots langsung
  diterima tanpa jeda tidur radio. **Upload ulang firmware** setelah memperbarui dari repo ini.
- Saat (re)connect, robot mengirim `gerak=0` (dan `kirim_hotspot=0` di program lomba) sebelum
  subscribe, supaya nilai lama di Ubidots tidak membuat robot jalan atau mengirim hotspot sendiri.

**Interval:** MLX90614 dibaca tiap 1 detik dan **hanya `suhu_objek`** yang dikirim ke device `phantom`
tiap **5 detik** (`PUBLISH_INTERVAL_MS`). Suhu ambient tidak dibaca lagi.

**Log microSD program tes:** tiap detik ke `/phantom_tes.csv` (`waktu,suhu_objek,gerak,speed,lengan,capit`).
Jam DS3231 disinkronkan dari NTP (WIB) saat online.

**Data logger program lomba** (seperti data logger minggu 7, tanpa OLED, hanya suhu objek):

- File di microSD: `/data01.txt` … `/data99.txt`. Saat menyala dipakai nomor pertama yang belum ada.
  File baru juga dibuat setiap WiFi tersambung lagi setelah putus, asal file sekarang sudah berisi data.
- Tiap **10 detik**: ambilWaktu → bacaData → simpanData → kirimData → simpanKode. Satu baris:
  `2026-11-26 10:15:20, 31.47, 200` (waktu RTC, suhu objek, kode HTTP kiriman baris itu).
- Kiriman: `POST https://industrial.api.ubidots.com/api/v1.6/devices/logger` (header `X-Auth-Token`
  dari `secrets.h`, timeout 5 detik). Isinya `suhu_objek` (value, timestamp, context `waktu`),
  `data_ke`, dan `http_code` kiriman sebelumnya. Timestamp = waktu RTC dalam WIB dikurangi 7 jam (UTC),
  dalam milidetik.
- Kode `-1` = WiFi putus, `0` = suhu tidak terbaca (tidak dikirim).
- Waktu diambil **langsung dari RTC DS3231**: program lomba tidak memakai NTP dan tidak pernah
  mengubah jam RTC. Atur jam RTC sekali dengan program terpisah (mis. program RTC minggu sebelumnya).
- Kiriman logger dan web dosen bergantian di satu task latar (core 0), jadi tidak ada dua koneksi
  HTTPS bersamaan dan motor/failsafe tidak tertahan. Kalau microSD, RTC, atau MLX90614 tidak ada, robot
  tetap jalan; microSD dicoba lagi tiap 30 detik dan RTC tiap 10 detik.

**Web dosen (hanya `phantom_lomba`):** robot mengirim `PATCH` JSON ke `SECRET_FIREBASE_URL`, sama
seperti contoh kode dosen:

- tiap 5 detik: `{"suhu":xx.x,"wifi":true}`;
- saat `suhu_objek` ≥ `batas_suhu` (default 50 °C, diatur dari ⚙ dashboard): `{"hotspot":true}`,
  diulang tiap 5 detik sampai berhasil. Tombol **KIRIM HOTSPOT (cadangan)** di dashboard mengirim
  `kirim_hotspot=1`; robot menolaknya (`fb_code=-3`) kalau suhu masih di bawah batas.
- Hasil tiap kiriman dilaporkan ke Ubidots (`fb_code`, `fb_jenis`, `fb_suhu`, dan `hotspot=1`
  setelah hotspot berhasil) dan tampil di kartu **WEB DOSEN**.
- Pengiriman HTTPS berjalan di core ESP32 yang lain, jadi kontrol motor dan servo tidak tertahan saat
  menunggu jawaban server.

## 12. WiFi & token Ubidots: hotspot HP + portal Phantom-Setup

Saat jalan normal, ESP32 hanya berjalan sebagai *station* (`WIFI_STA`) dan terhubung ke hotspot HP.
Robot **tidak membuat WiFi sendiri**, kecuali saat portal setup sengaja dibuka.

1. Nyalakan hotspot HP.
2. Nyalakan robot. Ia mencoba terhubung, dan mengulang tiap 30 detik kalau gagal.
3. Buka Serial Monitor (115200) untuk melihat IP, status MQTT/Firebase, dan sumber token
   (`Token Ubidots: BBUS-...abcd (tersimpan dari portal)` atau `(default program)`).

Selama WiFi atau MQTT putus, motor selalu berhenti.

**Mengganti WiFi atau token Ubidots tanpa upload ulang (portal Phantom-Setup):**

1. Robot menyala, lalu **tahan tombol BOOT di ESP32 selama 3 detik**. Motor berhenti, lalu robot restart ke
   mode setup. Jangan menahan BOOT *sebelum* atau *saat* robot dinyalakan, karena ESP32 malah masuk mode
   upload.
2. Di HP, sambungkan ke WiFi **`Phantom-Setup`** (password `phantom123`). Halaman setup biasanya terbuka
   sendiri; kalau tidak, buka `http://192.168.4.1`.
3. Isi **Nama WiFi**, **Password WiFi**, dan **Token Ubidots** (tombol *Tampilkan / sembunyikan token*
   tersedia), lalu **Simpan & restart**. Kolom yang dikosongkan tidak diubah.
4. Robot restart dan memakai isian baru. Semua isian disimpan di NVS (Preferences, namespace `phantom`,
   key `ssid`, `pass`, `token`).
5. Tombol **Pakai default program** menghapus isian tersimpan, sehingga robot kembali memakai `secrets.h`.

Hal lain yang perlu diketahui:
- Portal menutup sendiri setelah 5 menit, lalu robot kembali ke mode normal.
- Saat boot, token dibaca dari NVS. Kalau kosong, robot memakai `SECRET_UBIDOTS_TOKEN` dari `secrets.h`.
- Token disalin ke buffer global `ubidotsToken`, karena library UbidotsESPMQTT hanya menyimpan
  *pointer* token. Objek `Ubidots` baru dibuat di `setup()` setelah token dibaca.
- Logger (program lomba) memakai token yang sama untuk POST ke device `logger`.

> Selama lomba, jangan buka portal. Robot hanya menjadi WiFi `Phantom-Setup` selama portal terbuka.

Serial Monitor juga menampilkan heap bebas tiap 10 detik (`DEBUG_HEAP = true`), untuk memastikan memori
cukup saat koneksi HTTPS ke web dosen dan data logger berjalan. Ubah ke `false` kalau log tidak diperlukan.
