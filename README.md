# Phantom Dashboard — GARUDA Operation

Dashboard kontrol & monitoring robot rescue **Phantom** berbasis Ubidots. Situsnya statis
(`index.html` + `style.css` + `app.js`) untuk GitHub Pages: tanpa backend dan tanpa build tool.
Firmware ESP32 ada di [`firmware/firmware.ino`](firmware/firmware.ino).

## 1. Aktifkan GitHub Pages

1. Buka repo di GitHub, lalu **Settings → Pages**.
2. **Source**: *Deploy from a branch*. **Branch**: `main`, folder `/ (root)`, lalu **Save**.
3. Setelah 1–2 menit dashboard bisa dibuka di `https://<username>.github.io/<nama-repo>/`.

## 2. Siapkan Ubidots

1. Login ke Ubidots (industrial.ubidots.com), lalu buka **API Credentials** dan salin **Token**
   (sebaiknya buat token khusus untuk robot ini).
2. Buat device dengan label **`phantom`**. Device juga dibuat otomatis saat robot pertama kali online.
3. Pastikan variabel berikut ada di device (label harus sama persis):

| Variabel       | Arah               | Isi                                               |
|----------------|--------------------|---------------------------------------------------|
| `suhu_objek`   | robot → dashboard  | Suhu objek MLX90614 (°C)                          |
| `suhu_ambient` | robot → dashboard  | Suhu ambient MLX90614 (°C)                        |
| `batt_motor`   | robot → dashboard  | Tegangan baterai motor (V)                        |
| `batt_servo`   | robot → dashboard  | Tegangan baterai servo (V)                        |
| `gerak`        | dashboard → robot  | 0 = stop, 1 = maju, 2 = mundur, 3 = kiri, 4 = kanan |
| `speed`        | dashboard → robot  | PWM 0–255                                         |
| `lengan`       | dashboard → robot  | Sudut servo lengan 0–180                          |
| `capit`        | dashboard → robot  | 1 = buka, 0 = tutup                               |

Variabel sensor dibuat otomatis saat robot mengirim data. Variabel kontrol dibuat otomatis saat
tombol di dashboard pertama kali ditekan. Sebaiknya kirim sekali setiap kontrol sebelum robot
dinyalakan, supaya subscribe MQTT langsung mendapat nilai.

## 3. Isi token di dashboard

1. Buka halaman dashboard, masukkan **Token Ubidots** dan **Device label** (default `phantom`), lalu **Masuk**.
2. Token dicek ke Ubidots. Kalau ditolak, akan muncul pesan "Token Ubidots ditolak".
3. Token **hanya disimpan di `localStorage` browser itu**, tidak pernah di repo. Untuk menghapusnya,
   buka ⚙ **Pengaturan → Logout & hapus token**.

## 4. Menggunakan dashboard

Tampilan desktop: monitoring + grafik suhu di atas, kartu kontrol (Gerak, Gripper, …) + kamera di
bawah. Di HP semuanya tersusun 1 kolom.

- **Header:** logo, status robot (titik hijau berdenyut = online, kuning = tertunda, merah
  berkedip = offline), jam, tombol **✎ Edit Dashboard** dan **⚙ Pengaturan**.
- **Kartu sensor** menyala kuning/merah saat melewati ambang. `suhu_objek` di atas 35 °C membuat
  kartu merah berkedip, muncul label **KORBAN TERDETEKSI**, dan ada strip peringatan di atas.
- **Gerak:** tahan ▲▼◀▶ supaya robot berjalan, lalu lepas untuk berhenti (`gerak=0`). Di laptop
  bisa pakai panah/WASD, dan **Spasi** = STOP darurat. Tombol **STOP DARURAT** selalu terlihat
  (di bawah layar pada HP, kanan bawah pada desktop) dan langsung dikirim walau sedang antre/jeda.
- **Kamera:** isi IP saja (misal `192.168.1.50`, otomatis dibuka ke `http://192.168.1.50:81/stream`)
  atau URL lengkap. Stream dibuka di tab baru, bukan di-embed, karena halaman HTTPS tidak boleh
  memuat video HTTP (*mixed content*). HP harus berada di jaringan yang sama dengan ESP32-CAM.

**Pengaturan (⚙):** device label, IP kamera, interval polling (default 3 detik), token, tema warna
(Biru Garuda, Merah Rescue, Hijau Militer, Ungu Neon), dan mode Gelap/Terang. Pilihan tema langsung
terlihat dan baru disimpan setelah **Simpan**.

### Batas request Ubidots (STEM = 1 request/detik)

- Semua variabel device dibaca dengan **1 request** (`GET /api/v2.0/devices/~phantom/variables/`).
  Kalau endpoint itu tidak tersedia, dashboard beralih ke v1.6 (1 request per sensor, tetap antre).
- Semua request lewat antrean dengan jarak minimal 1,1 detik. Perintah kontrol didahulukan dari
  polling, dan nilai slider yang belum terkirim digabung (hanya nilai terakhir yang dikirim).
- Selama tombol gerak ditahan, **polling sensor dijeda** dan nilai `gerak` dikirim ulang tiap
  **1,5 detik** sebagai heartbeat untuk failsafe firmware.
- STOP (`gerak=0`) dikirim seketika, tidak ikut antre.
- Jika Ubidots membalas **HTTP 429**, dashboard menunggu otomatis (backoff 2 → 4 → 8 … maks.
  60 detik), menampilkan hitung mundur, lalu mencoba lagi.

> Kuota harian: robot mengirim 4 dot tiap 5 detik, dan menahan tombol gerak menambah 1 dot tiap
> 1,5 detik. Perbesar `PUBLISH_INTERVAL_MS` (firmware) kalau kuota dot cepat habis.

## 5. Mengubah tampilan: Mode Edit

Klik **✎ Edit Dashboard**:

- **Klik kartu/kontrol** untuk mengubahnya, **✕** untuk menghapus, **+ Sensor / + Kontrol / + Tambah …**
  untuk menambah.
- **Seret ⠿** untuk mengurutkan kartu sensor, kontrol di dalam grup, atau seluruh grup (bisa dengan
  mouse maupun jari).
- Sensor: label, variabel Ubidots, satuan, desimal, ikon (emoji), warna, tampil di grafik, dan
  daftar ambang (di atas/di bawah nilai, Waspada/Bahaya, catatan).
- Kontrol: tipe (tombol/tahan/toggle/slider), grup (kartu), label, variabel, warna, nilai,
  min/max/step, posisi D-pad, dan tombol keyboard.
- Konfigurasi tersimpan di `localStorage` browser. **Export JSON** untuk backup atau dipindah ke
  HP/laptop lain, **Import JSON** untuk memuatnya, **Reset default** untuk kembali ke bawaan.

Konfigurasi bawaan ada di `DEFAULT_SENSORS` dan `DEFAULT_CONTROLS` di bagian atas `app.js`.
Format JSON export sama dengan objek di array tersebut.

**Contoh sensor** (sensor gas, kartu jadi merah di atas 400 ppm):

```js
{ label: "Gas", variable: "gas_ppm", unit: "ppm", decimals: 0, icon: "☁️", color: "#9085e9", chart: false,
  thresholds: [{ above: 400, level: "danger", note: "Gas berbahaya" }] },
```

**Contoh kontrol** (lampu sorot on/off):

```js
{ type: "toggle", group: "Lampu", label: "Lampu sorot", variable: "lampu",
  on: { label: "Nyala", value: 1 }, off: { label: "Mati", value: 0 }, value: 0 },
```

| type     | field khusus                                     | perilaku                                       |
|----------|--------------------------------------------------|------------------------------------------------|
| `button` | `value`, `pad`                                   | kirim `value` saat diklik                      |
| `hold`   | `value`, `release`, `pad`, `key`                 | kirim `value` tiap 1,5 dtk selama ditahan, `release` saat dilepas |
| `toggle` | `on {label,value}`, `off {label,value}`, `value` | dua pilihan, yang aktif disorot                |
| `slider` | `min`, `max`, `step`, `value`, `unit`            | kirim nilai saat digeser                       |

Semua kontrol memakai `group` (judul kartu) dan boleh memakai `color`. Untuk kontrol baru,
jangan lupa tambahkan `ubidotsSubscribe(...)` dan penanganannya di `onMqttMessage()` pada firmware.

## 6. Firmware ESP32

**Board:** ESP32 DevKit V1 (Arduino IDE: *DOIT ESP32 DEVKIT V1*), core ESP32 2.x/3.x. Sudah diuji
kompilasi di core 3.3.12 (flash terpakai ±87%; pakai *Partition Scheme → Huge APP* kalau fitur bertambah).

**Library** (Library Manager):

- Ubidots MQTT for ESP32 and ESP8266 (`UbidotsESPMQTT.h`, versi ≥ 1.2) + PubSubClient
- WiFiManager (tzapu)
- ESP32Servo
- Adafruit MLX90614
- Adafruit SSD1306 + Adafruit GFX
- RTClib (Adafruit)

> **Kalau muncul error `ESP8266WiFi.h: No such file or directory`:** versi library Ubidots kamu
> hanya untuk ESP8266. Buka `Arduino/libraries/<ubidots-mqtt-esp>/src/UbidotsESPMQTT.h`, lalu ganti
> baris `#include <ESP8266WiFi.h>` dengan:
>
> ```cpp
> #if defined(ESP32)
> #include <WiFi.h>
> #else
> #include <ESP8266WiFi.h>
> #endif
> ```

Isi `UBIDOTS_TOKEN` di bagian atas sketch. WiFi tidak perlu diisi (lihat bagian 6);
`WIFI_SSID_DEFAULT` hanya opsional untuk percobaan pertama.

**Pin (ESP32 DevKit V1 30-pin)**. Pin strapping (0, 2, 5, 12, 15) tidak dipakai, dan ADC hanya
memakai ADC1 karena ADC2 mati saat WiFi aktif.

| Fungsi                   | GPIO |
|--------------------------|------|
| I2C SDA / SCL (MLX90614 0x5A, SSD1306 0x3C, DS3231 0x68 + EEPROM 0x57) | 21 / 22 |
| microSD SCK / MISO / MOSI / CS | 18 / 19 / 23 / 4 |
| L298N ENA (PWM kiri) / IN1 / IN2 | 32 / 33 / 25 |
| L298N IN3 / IN4 / ENB (PWM kanan) | 26 / 27 / 13 |
| Servo lengan / capit     | 16 / 17 |
| ADC baterai motor / servo | 34 / 35 |
| Tombol reset WiFi (ke GND) | 14 |

Catatan wiring:

- Lepas jumper ENA/ENB di L298N. Motor kiri diparalel ke OUT1/OUT2, motor kanan ke OUT3/OUT4.
- Servo MG90S diberi daya dari baterai servo (4,8–6 V), bukan dari pin 3V3/5V ESP32.
  **Semua GND harus disatukan.**
- Pembagi tegangan default 30 kΩ / 7,5 kΩ (modul sensor tegangan, maksimal ±15 V). Ubah
  `BATT_*_R1/R2` kalau nilai resistor berbeda, dan `BATT_CAL` untuk kalibrasi dengan multimeter.
- Kalau arah roda terbalik, ubah `MOTOR_KIRI_BALIK` / `MOTOR_KANAN_BALIK`. Sudut capit diatur di
  `CAPIT_BUKA_DEG` / `CAPIT_TUTUP_DEG`.

**Fitur keamanan:**

- Dashboard mengirim ulang `gerak` tiap 1,5 detik selama tombol ditahan (`HEARTBEAT_MS`). Motor
  berhenti kalau heartbeat tidak datang lebih dari `FAILSAFE_TIMEOUT_MS` = 2,5 detik (1,5 detik +
  toleransi jeda jaringan 1 detik), atau saat WiFi/MQTT putus.
- Saat (re)connect, robot mengirim `gerak=0` sebelum subscribe, supaya nilai gerak lama tidak
  membuat robot jalan sendiri.

**Interval:** sensor dibaca tiap 1 detik (`SENSOR_INTERVAL_MS`, untuk OLED & log) dan dikirim ke
Ubidots tiap **5 detik** (`PUBLISH_INTERVAL_MS`). Status "Robot online" di dashboard memakai ambang
15 detik, jadi tetap hijau dengan interval ini.

**OLED** menampilkan status WiFi/IP, suhu, kedua baterai, perintah gerak terakhir, jam, dan status SD.
**Log microSD** ditulis ke `/phantom_log.csv` tiap detik
(`waktu,suhu_objek,suhu_ambient,batt_motor,batt_servo,gerak`). Kalau kartu tidak ada, robot tetap
jalan tanpa log. Jam DS3231 disinkronkan otomatis dari NTP (WIB) saat online.

## 7. Ganti WiFi lewat Phantom-Setup

Mode setup aktif otomatis kalau robot gagal terhubung ke WiFi tersimpan selama lebih dari 15 detik.
Bisa juga dipaksa dengan **menahan tombol reset WiFi (GPIO14) selama 3 detik**; cara ini menghapus
WiFi yang tersimpan.

1. OLED menampilkan **MODE SETUP WIFI** beserta nama & password AP.
2. Dari HP, sambungkan ke WiFi **`Phantom-Setup`** dengan password **`phantom123`**.
3. Halaman portal biasanya terbuka otomatis. Kalau tidak, buka `http://192.168.4.1`.
4. Pilih **Configure WiFi**, pilih SSID, isi password, lalu **Save**.
5. Robot tersambung, dan WiFi baru tersimpan permanen (tetap ada setelah restart).

Selama mode setup atau tidak terhubung, motor selalu berhenti. Portal tertutup sendiri setelah
3 menit; setelah itu robot mencoba WiFi tersimpan lagi.
