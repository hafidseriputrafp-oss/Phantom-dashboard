# Phantom Dashboard Hub — GARUDA Operation

Kumpulan dashboard IoT berbasis Ubidots yang bisa dibuat dan diubah dari HP maupun laptop.
Situsnya statis untuk GitHub Pages: tanpa backend dan tanpa build tool.

| Alamat | Isi |
|--------|-----|
| `/` ([`index.html`](index.html), [`home.js`](home.js)) | **Beranda**: daftar dashboard, tambah/ubah/duplikat/hapus |
| `/robot/` ([`robot/`](robot/)) | **Robot Phantom**: dashboard kontrol robot rescue (D-pad, STOP darurat, heartbeat) |
| `/dash/?id=<id>` ([`dash/`](dash/)) | **Builder**: menampilkan & mengedit dashboard buatan sendiri |
| [`shared/`](shared/) | Kode bersama: token, tema, API Ubidots + antrean request, sinkron cloud |
| [`firmware/`](firmware/) | Firmware ESP32 robot Phantom: `phantom_tes` (latihan) dan `phantom_lomba` (kirim ke web dosen) |

Setelah GitHub Pages aktif:

- Beranda: https://hafidseriputrafp-oss.github.io/Phantom-dashboard/
- Robot: https://hafidseriputrafp-oss.github.io/Phantom-dashboard/robot/
- Data Logger: https://hafidseriputrafp-oss.github.io/Phantom-dashboard/dash/?id=logger

## 1. Aktifkan GitHub Pages

1. Buka repo di GitHub, lalu **Settings → Pages**.
2. **Source**: *Deploy from a branch*. **Branch**: `main`, folder `/ (root)`, lalu **Save**.
3. Setelah 1–2 menit situs bisa dibuka di `https://<username>.github.io/<nama-repo>/`.

## 2. Login & sinkron antar perangkat

- **Token Ubidots tidak pernah disimpan di repo.** Token dimasukkan di halaman login dan disimpan
  di `localStorage` browser (key `phantom.token`, sama dengan dashboard robot), jadi cukup login
  sekali untuk semua halaman. Logout ada di ⚙ Pengaturan.
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

ESP32 data logger mengirim ke device **`logger`**:

| Variabel | Isi |
|----------|-----|
| `suhu_ambient` | suhu (°C), dot dengan **timestamp RTC** dan context `{"waktu":"YYYY-MM-DD HH:MM:SS"}` |
| `data_ke` | nomor urut data |
| `http_code` | kode HTTP kiriman sebelumnya (200, -1, 401, 429, …) |

Widget bawaan: Status online (30 dtk), Kartu `suhu_ambient` (°C) + waktu RTC dari context,
Kartu `data_ke`, Indikator `http_code`, Grafik `suhu_ambient` 50 titik, dan Tabel riwayat
`suhu_ambient` 20 baris. Di tabel, kolom **Selisih** = waktu diterima server − timestamp RTC,
berguna untuk melihat keterlambatan kiriman atau RTC yang meleset. **Reset ke preset** (Mode Edit)
mengembalikan widget bawaan.

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
| `gerak`         | dashboard → robot  | 0 stop, 1 maju, 2 mundur, 3 putar kiri, 4 putar kanan, 5 maju-kiri, 6 maju-kanan, 7 mundur-kiri, 8 mundur-kanan |
| `speed`         | dashboard → robot  | PWM 80–255                                                       |
| `lengan`        | dashboard → robot  | Sudut servo lengan (derajat)                                     |
| `capit`         | dashboard → robot  | Sudut servo capit (derajat)                                      |
| `batas_suhu`    | dashboard → robot  | Batas suhu hotspot (°C), diatur di ⚙ Pengaturan                  |
| `kirim_hotspot` | dashboard → robot  | 1 = minta robot kirim hotspot sekarang (tombol cadangan)         |

Variabel sensor dibuat otomatis saat robot mengirim data. Variabel kontrol dibuat otomatis saat
tombol di dashboard pertama kali ditekan. Sebaiknya kirim sekali setiap kontrol sebelum robot
dinyalakan, supaya subscribe MQTT langsung mendapat nilai.

## 8. Robot: isi token

1. Buka `/robot/` (atau kartu **Robot Phantom** di Beranda). Kalau sudah login di Beranda, token langsung terpakai.
   Kalau belum, masukkan **Token Ubidots** dan **Device label** (default `phantom`), lalu **Masuk**.
2. Token dicek ke Ubidots. Kalau ditolak, akan muncul pesan "Token Ubidots ditolak".
3. Token **hanya disimpan di `localStorage` browser itu**, tidak pernah di repo. Untuk menghapusnya,
   buka ⚙ **Pengaturan → Logout & hapus token**.

## 9. Robot: menggunakan dashboard

Halaman `/robot/` dibuat untuk **HP landscape, satu layar tanpa scroll** (juga jalan di laptop).
Kalau HP dipegang tegak, muncul ajakan memutar HP (bisa dilewati dengan **Tetap pakai portrait**).
Tombol **⛶** membuka layar penuh dan mengunci landscape (Chrome Android).

Dibuat untuk **dua ibu jari**:

- **Kiri (ibu jari kiri):** D-pad 8 arah. Tahan supaya robot berjalan, lepas untuk berhenti (`gerak=0`):
  ▲ maju, ▼ mundur, ◀ / ▶ putar di tempat, ↖ ↗ ↙ ↘ belok melengkung. Menekan dua arah sekaligus
  (misalnya ▲ + ▶) juga menjadi belok melengkung; ▲ + ▼ atau ◀ + ▶ mengikuti yang terakhir ditekan.
  ■ = stop. Di bawahnya slider **SPEED** (PWM 80–255) dan teks arah yang sedang dikirim.
  Di laptop bisa pakai panah/WASD (W+D = maju-kanan, dst.), **Spasi** = STOP darurat.
- **Tengah:** **SUHU OBJEK** besar (hijau NORMAL, kuning MENDEKATI, merah 🔥 HOTSPOT saat ≥ batas),
  grafik suhu dengan garis batas, kartu **WEB DOSEN** (status hotspot, isi kiriman terakhir seperti
  `{"suhu":51.2,"wifi":true}` atau `{"hotspot":true}` beserta hasilnya: 200 = berhasil, 401 = database
  dosen masih dikunci), dan **STOP DARURAT**. Tombol **KIRIM HOTSPOT (cadangan)** hanya aktif saat robot
  online dan suhu ≥ batas; pengiriman utama tetap otomatis dari robot (program lomba).
- **Kanan (ibu jari kanan):** **LENGAN** (TURUN / BAWA / PARKIR + slider) dan **CAPIT** (BUKA / TUTUP +
  slider).

Tombol STOP, ■, dan preset servo langsung bereaksi saat disentuh, jadi tetap jalan walaupun ibu jari
lain sedang menahan D-pad.

**Pengaturan (⚙):** device label, interval baca data (default 3 detik), batas hotspot (default
50 °C, ikut dikirim ke robot sebagai `batas_suhu`), sudut tombol TURUN/BAWA/PARKIR/BUKA/TUTUP dan
batas min/max slider, tema warna, mode Gelap/Terang, token, dan logout. Semua tersimpan di
`localStorage` browser itu.

### Batas request Ubidots di dashboard robot

- Semua variabel device dibaca dengan **1 request** (`GET /api/v2.0/devices/~phantom/variables/`).
- Semua request lewat antrean dengan jarak minimal 1,1 detik; nilai slider digabung (hanya nilai
  terakhir yang dikirim).
- Selama tombol gerak ditahan, polling dijeda dan `gerak` dikirim ulang tiap **1,5 detik** sebagai
  heartbeat untuk failsafe firmware (motor berhenti sendiri setelah 3 detik tanpa perintah).
- Jika Ubidots membalas **HTTP 429**, dashboard menunggu otomatis (backoff 2 → 4 → 8 … maks. 60 detik).

## 10. Robot: tampilan lama

Mode Edit, kartu baterai, dan tombol kamera dari versi lama dihapus supaya layar kontrol muat satu
layar HP. Versi lama masih ada di riwayat commit Git kalau diperlukan.


## 11. Firmware ESP32 (dua program)

**Board:** ESP32 Dev Module (Arduino IDE: *Tools → Board → ESP32 Dev Module*), core ESP32 3.x.
Ada dua sketch, masing-masing di foldernya sendiri:

| Sketch | Untuk | Isi |
|--------|-------|-----|
| [`firmware/phantom_tes/`](firmware/phantom_tes/) | **Tes / latihan** | Kontrol gerak 0–8, servo lengan & capit, MLX90614 ke dashboard, RTC DS3231, log microSD. Tanpa batas suhu dan tanpa kirim ke web dosen. |
| [`firmware/phantom_lomba/`](firmware/phantom_lomba/) | **Lomba** | Semua isi program tes **+ kirim ke web dosen** (Firebase): data suhu tiap 5 detik dan hotspot saat suhu ≥ batas. |

Keduanya sudah diuji kompilasi (`arduino-cli`, ESP32 Dev Module): tes ±77% flash, lomba ±85%.

**Library** (Library Manager):

- Ubidots MQTT for ESP32 and ESP8266 (`UbidotsESPMQTT.h`, versi ≥ 1.2) + PubSubClient
- ESP32Servo
- Adafruit MLX90614 (+ Adafruit BusIO)
- RTClib (Adafruit)

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
ditulis di sketch. Di tiap folder sketch, salin `secrets.example.h` menjadi `secrets.h`, lalu isi:

```cpp
#define SECRET_WIFI_SSID     "nama hotspot HP"
#define SECRET_WIFI_PASS     "password hotspot HP"
#define SECRET_UBIDOTS_TOKEN "BBUS-..."
#define SECRET_FIREBASE_URL  "https://...firebasedatabase.app/missions/teamXX.json"   // hanya program lomba
```

`secrets.h` sudah masuk `.gitignore`, jadi tidak ikut ter-upload ke GitHub.

**Pin (ESP32 30-pin)**. Pin strapping (0, 2, 12, 15) tidak dipakai; GPIO5 hanya dipakai sebagai CS
microSD (pin SS bawaan VSPI, aman karena CS dalam keadaan HIGH saat boot).

| Fungsi                   | GPIO |
|--------------------------|------|
| I2C SDA / SCL (MLX90614 0x5A, DS3231 0x68 + EEPROM 0x57) | 21 / 22 |
| microSD SCK / MISO / MOSI / CS | 18 / 19 / 23 / 5 |
| L298N ENA (PWM kiri) / IN1 / IN2 | 32 / 33 / 25 |
| L298N IN3 / IN4 / ENB (PWM kanan) | 26 / 27 / 13 |
| Servo lengan / capit     | 16 / 17 |

Catatan wiring:

- Lepas jumper ENA/ENB di L298N. Motor kiri diparalel ke OUT1/OUT2, motor kanan ke OUT3/OUT4.
- Servo diberi daya dari baterai servo (4,8–6 V), bukan dari pin 3V3/5V ESP32.
  **Semua GND harus disatukan.**
- Kalau arah roda terbalik, ubah `MOTOR_KIRI_BALIK` / `MOTOR_KANAN_BALIK`. Kalau belok melengkung
  terlalu tajam/landai, ubah `CURVE_RATIO` (kecepatan roda sisi dalam, default 0,4).
- Sudut servo dikirim langsung dari dashboard (derajat). Posisi awal saat menyala: lengan 135°
  (PARKIR), capit 90° (TUTUP).

**Fitur keamanan:**

- Dashboard mengirim ulang `gerak` tiap 1,5 detik selama tombol ditahan (`HEARTBEAT_MS`). Motor
  berhenti kalau heartbeat tidak datang lebih dari `FAILSAFE_TIMEOUT_MS` = 3 detik (1,5 detik +
  toleransi antrean request dan jaringan 1,5 detik), atau saat WiFi/MQTT putus.
- Saat (re)connect, robot mengirim `gerak=0` (dan `kirim_hotspot=0` di program lomba) sebelum
  subscribe, supaya nilai lama di Ubidots tidak membuat robot jalan atau mengirim hotspot sendiri.

**Interval:** MLX90614 dibaca tiap 1 detik (untuk log microSD) dan `suhu_objek`/`suhu_ambient`
dikirim ke Ubidots tiap **5 detik** (`PUBLISH_INTERVAL_MS`). **Log microSD** ditulis tiap detik ke
`/phantom_tes.csv` atau `/phantom_lomba.csv` (`waktu,suhu_objek,suhu_ambient,gerak,speed,lengan,capit`,
plus `fb_code` di program lomba). Kalau kartu tidak ada, robot tetap jalan tanpa log. Jam DS3231
disinkronkan otomatis dari NTP (WIB) saat online.

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

## 12. WiFi: hanya lewat hotspot HP

Sesuai aturan lomba, robot **tidak pernah membuat WiFi/hotspot sendiri**. ESP32 hanya berjalan
sebagai *station* (`WIFI_STA`) dan terhubung ke hotspot HP yang namanya ditulis di `secrets.h`.

1. Nyalakan hotspot HP dengan nama & password yang sama dengan `SECRET_WIFI_SSID` / `SECRET_WIFI_PASS`.
2. Nyalakan robot. Ia mencoba terhubung, dan mengulang tiap 10 detik kalau gagal.
3. Buka Serial Monitor (115200) untuk melihat IP dan status MQTT/Firebase.

Selama WiFi atau MQTT putus, motor selalu berhenti. Untuk mengganti hotspot, ubah `secrets.h` lalu
upload ulang.
