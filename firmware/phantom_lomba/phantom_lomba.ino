/*
 * PHANTOM — program LOMBA (kontrol + sensor + kirim data suhu & hotspot ke web dosen)
 * Board  : ESP32 Dev Module
 * Library: Ubidots MQTT for ESP32 and ESP8266 (UbidotsESPMQTT.h) + PubSubClient,
 *          ESP32Servo, Adafruit MLX90614, RTClib (Adafruit), SD/SPI/Wire (bawaan core ESP32)
 * Kredensial default ada di secrets.h (salin dari secrets.example.h, jangan di-commit).
 * WiFi & token Ubidots bisa diganti tanpa upload ulang: tahan tombol BOOT 3 detik saat robot
 * menyala -> robot restart sebagai WiFi "Phantom-Setup" (hanya untuk setup, tutup sendiri 5 menit).
 * Saat jalan normal robot hanya mode STA ke hotspot HP.
 */

#include <Wire.h>
#include <SPI.h>
#include <SD.h>
#include <WiFi.h>
#include <Preferences.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <UbidotsESPMQTT.h>
#include <ESP32Servo.h>
#include <Adafruit_MLX90614.h>
#include <RTClib.h>
#include "secrets.h"

// ---------- PIN ----------
#define PIN_I2C_SDA        21   // MLX90614 (0x5A), DS3231 (0x68, EEPROM 0x57)
#define PIN_I2C_SCL        22
#define PIN_SD_SCK         18   // VSPI
#define PIN_SD_MISO        19
#define PIN_SD_MOSI        23
#define PIN_SD_CS          5
#define PIN_MOTOR_ENA      25   // L298N ENA -> PWM roda kiri
#define PIN_MOTOR_IN1      26
#define PIN_MOTOR_IN2      27
#define PIN_MOTOR_IN3      32
#define PIN_MOTOR_IN4      33
#define PIN_MOTOR_ENB      4    // L298N ENB -> PWM roda kanan
#define PIN_SERVO_LENGAN   16
#define PIN_SERVO_CAPIT    17
#define PIN_TOMBOL_SETUP   0    // tombol BOOT: tahan 3 dtk = portal Phantom-Setup

// ---------- KREDENSIAL ----------
const char* TOKEN_DEFAULT     = SECRET_UBIDOTS_TOKEN;   // dipakai kalau portal belum diisi
const char* WIFI_SSID_DEFAULT = SECRET_WIFI_SSID;
const char* WIFI_PASS_DEFAULT = SECRET_WIFI_PASS;
char ubidotsToken[80];   // library Ubidots menyimpan pointer token, jadi buffer global
char wifiSsid[33];
char wifiPass[65];
const char* sumberToken = "default program";
char DEVICE_LABEL[]  = "phantom";
const char* FIREBASE_URL = SECRET_FIREBASE_URL;   // .../missions/teamXX.json

// ---------- VARIABEL UBIDOTS ----------
char VAR_GERAK[]        = "gerak";
char VAR_SPEED[]        = "speed";
char VAR_LENGAN[]       = "lengan";
char VAR_CAPIT[]        = "capit";
char VAR_SUHU_OBJEK[]   = "suhu_objek";
char VAR_ACK_GERAK[]    = "ack_gerak";
char VAR_ACK_LENGAN[]   = "ack_lengan";
char VAR_ACK_CAPIT[]    = "ack_capit";
char VAR_BATAS_SUHU[]   = "batas_suhu";
char VAR_KIRIM_HOTSPOT[] = "kirim_hotspot";
char VAR_HOTSPOT[]      = "hotspot";
char VAR_FB_CODE[]      = "fb_code";
char VAR_FB_JENIS[]     = "fb_jenis";
char VAR_FB_SUHU[]      = "fb_suhu";

// ---------- PARAMETER ----------
const bool DEBUG_HEAP = true;
const unsigned long HEAP_LOG_MS = 10000;
const unsigned long PUBLISH_INTERVAL_MS = 5000;   // kirim suhu ke Ubidots
const unsigned long SENSOR_INTERVAL_MS  = 1000;   // baca MLX90614
const unsigned long HEARTBEAT_MS        = 5000;   // dashboard kirim ulang "gerak" tiap 5 dtk hanya saat tombol ditahan lama
const unsigned long FAILSAFE_TIMEOUT_MS = HEARTBEAT_MS + 3000;   // HP putus saat tombol ditahan -> robot berhenti
const unsigned long PUBLISH_JEDA_MS     = 1000;   // robot publish ke Ubidots maks. 1x per detik
const int           MAKS_NILAI          = 5;      // batas nilai per publish library UbidotsESPMQTT
const unsigned long SUB_ULANG_MS        = 10000;  // subscribe ulang sampai pesan pertama diterima
const unsigned long MQTT_RETRY_MS       = 3000;
const unsigned long WIFI_RETRY_MS       = 30000;
const unsigned long SETUP_TAHAN_MS      = 3000;     // lama tahan tombol BOOT
const unsigned long SETUP_TIMEOUT_MS    = 300000;   // portal tutup sendiri setelah 5 menit
const unsigned long SETUP_RESTART_MS    = 1500;
const char*         SETUP_AP_SSID       = "Phantom-Setup";
const char*         SETUP_AP_PASS       = "phantom123";
const char*         PREFS_NAMA          = "phantom";
const long          WIB_OFFSET_S        = 7 * 3600;

const unsigned long LOGGER_INTERVAL_MS   = 10000;
const unsigned long LOGGER_TUNGGU_MAX_MS = 30000;
const unsigned long SD_RETRY_MS          = 30000;
const uint16_t      LOGGER_TIMEOUT_MS    = 5000;
const char*         LOGGER_URL           = "https://industrial.api.ubidots->com/api/v1.6/devices/logger";
const size_t        LOGGER_BODY_MAX      = 384;

const unsigned long FIREBASE_DATA_MS    = 5000;   // kirim {"suhu":..,"wifi":true} ke web dosen
const unsigned long HOTSPOT_RETRY_MS    = 5000;   // jeda coba ulang hotspot bila gagal
const uint16_t      FIREBASE_TIMEOUT_MS = 4000;
const float         BATAS_SUHU_DEFAULT  = 50.0;   // bisa diubah dari dashboard (batas_suhu)
const int           FB_DITOLAK          = -3;     // kode untuk dashboard: suhu di bawah batas

const uint32_t MOTOR_PWM_FREQ    = 1000;
const uint8_t  MOTOR_PWM_BITS    = 8;
const bool     MOTOR_KIRI_BALIK  = false;   // ubah jika arah roda kiri terbalik
const bool     MOTOR_KANAN_BALIK = true;
const uint8_t  SPEED_DEFAULT     = 150;
const float    CURVE_RATIO       = 0.4;     // kecepatan roda sisi dalam saat belok melengkung
const uint8_t  TURN_SPEED        = 255;     // putar di tempat: roda saling menahan, perlu PWM penuh

const int LENGAN_MIN = 0, LENGAN_MAX = 180;    // MG996R terbalik: 0 = naik mentok, 180 = turun maksimal
const int CAPIT_MIN = 25, CAPIT_MAX = 140;     // 25 = buka, makin besar makin menutup
const int LENGAN_AWAL = 0, CAPIT_AWAL = 110;
const int SERVO_MIN_US = 500, SERVO_MAX_US = 2400;

// ---------- OBJEK ----------
enum Move {
  MOVE_STOP = 0, MOVE_MAJU = 1, MOVE_MUNDUR = 2, MOVE_KIRI = 3, MOVE_KANAN = 4,
  MOVE_MAJU_KIRI = 5, MOVE_MAJU_KANAN = 6, MOVE_MUNDUR_KIRI = 7, MOVE_MUNDUR_KANAN = 8,
};
const char* MOVE_NAMES[] = { "STOP", "MAJU", "MUNDUR", "PUTAR KIRI", "PUTAR KANAN", "MAJU-KIRI", "MAJU-KANAN", "MUNDUR-KIRI", "MUNDUR-KANAN" };

char MQTT_CLIENT[] = "garuda13-phantom";
Ubidots* ubidots = NULL;   // dibuat di setup() setelah token dibaca
Preferences prefs;
WebServer portal(80);
DNSServer dnsPortal;
Adafruit_MLX90614 mlx;
RTC_DS3231 rtc;
Servo servoLengan, servoCapit;
ESP32PWM pwmKiri, pwmKanan;

// ---------- STATUS ----------
Move currentMove = MOVE_STOP;
uint8_t currentSpeed = SPEED_DEFAULT;
int lenganDeg = LENGAN_AWAL, capitDeg = CAPIT_AWAL;
unsigned long lastCommandMs = 0;
int lastCmdGerak = MOVE_STOP;
struct Ack {
  bool pending;
  int value;
  char* ubiVar;
};
enum { ACK_GERAK = 0, ACK_LENGAN = 1, ACK_CAPIT = 2, ACK_JUMLAH = 3 };
Ack acks[ACK_JUMLAH] = {
  { false, 0, VAR_ACK_GERAK },
  { false, 0, VAR_ACK_LENGAN },
  { false, 0, VAR_ACK_CAPIT },
};
char* SUB_VARS[] = { VAR_GERAK, VAR_SPEED, VAR_LENGAN, VAR_CAPIT, VAR_BATAS_SUHU, VAR_KIRIM_HOTSPOT };
const int SUB_JUMLAH = sizeof(SUB_VARS) / sizeof(SUB_VARS[0]);
bool subDapat[SUB_JUMLAH];
bool mqttWasConnected = false, suhuTunggu = false;
int mqttPutusCount = 0;
unsigned long lastSubMs = 0, lastUbiPublishMs = 0;
unsigned long lastHeapLogMs = 0;
float suhuObjek = NAN;
float batasSuhu = BATAS_SUHU_DEFAULT;
int lastFbCode = 0;
bool hotspotSent = false;
unsigned long lastFirebaseDataMs = 0, lastHotspotTryMs = 0;

enum FbJenis { FB_DATA = 1, FB_HOTSPOT = 2 };
struct FbResult { int code; int jenis; float suhu; };
volatile bool wantData = false, wantHotspot = false;
volatile float pendingSuhu = NAN;
QueueHandle_t fbResults;
FbResult fbHasil;
bool fbTunggu = false, hotspotTunggu = false;

void requestHotspot(bool manual);

bool mlxOk = false, rtcOk = false, sdOk = false;
bool wifiWasConnected = false, wifiPernahTersambung = false;
unsigned long lastWifiAttemptMs = 0, lastMqttAttemptMs = 0, lastSensorMs = 0, lastPublishMs = 0, lastMlxRetryMs = 0;
bool modeSetup = false;
unsigned long tombolDitekanMs = 0, setupMulaiMs = 0, restartPadaMs = 0;













// =====================================================================
// DATA LOGGER: microSD /dataNN.txt + POST ke Ubidots device "logger"
// =====================================================================
struct LoggerJob { uint32_t id; char body[LOGGER_BODY_MAX]; };
struct LoggerResult { uint32_t id; int code; };
QueueHandle_t loggerJobs, loggerResults;

char namaFile[16] = "";
unsigned long dataKe = 0;
char waktuLog[24] = "";
unsigned long long tsLog = 0;
float suhuLog = NAN;
int kodeSebelumnya = 0;
unsigned long long tsSebelumnya = 0;
bool adaKirimanSebelumnya = false;
bool menungguKode = false, barisTerbuka = false, gantiFile = false;
uint32_t loggerJobId = 0;
unsigned long lastLoggerMs = 0, lastSdRetryMs = 0, mulaiTungguMs = 0;

// ---------- DEKLARASI FUNGSI (isi ada setelah loop) ----------
void setMotor(ESP32PWM& pwm, uint8_t pinA, uint8_t pinB, int dir, uint8_t speed, bool invert);
void driveMotors(int kiri, int kanan, float skalaKiri, float skalaKanan);
void putarDiTempat(int kiri, int kanan);
void applyMove(Move m);
void stopMotors();
void setupMotors();
void setLengan(int deg);
void setCapit(int deg);
void setupServos();
void readSensors();
void setupSensors();
void setupRtc();
bool mulaiSd();
void pilihFileBaru();
void setupSd();
void cekSd();
bool tulisSd(const char* teks);
bool ambilWaktu();
void bacaData();
void simpanData();
void simpanKode(int kode);
bool susunJson(char* out, size_t size);
void kirimData();
void terimaHasilLogger();
void handleLogger();
void setupWiFi();
void handleWiFi();
void tandaiAck(int idx, int v);
void terimaGerak(int value);
void prosesPerintah(const char* nama, const char* teks);
void salinPayload(byte* payload, unsigned int length, char* buf, size_t size);
bool ambilNama(const char* topic, const char* awalan, const char* akhiran, char* out, size_t size);
void onMqttMessage(char* topic, byte* payload, unsigned int length);
void kirimUbidots();
void langgananSemua();
void langgananUlang();
void tandaiDiterima(const char* nama);
void catatPutus();
void logHeap();
void onMqttConnected();
void handleMqtt();
void publishSensors();
int firebasePatch(const String& body);
int loggerPost(const char* body);
bool jalankanLogger();
void kirimFirebase(int jenis);
void firebaseTask(void*);
void publishFbResult(const FbResult& r);
void requestHotspot(bool manual);
void handleFirebase();
void handleFailsafe();
void bacaKredensial();
String tokenSamar();
String escapeHtml(String s);
void cekTombolSetup();
void mulaiPortal();
void jalankanPortal();
void alihkanPortal();
void kirimHalaman(String isi);
void halamanPortal();
void simpanPortal();
void resetPortal();

// =====================================================================
// SETUP & LOOP
// =====================================================================
void setup() {
  Serial.begin(115200);

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  setupMotors();
  setupServos();

  pinMode(PIN_TOMBOL_SETUP, INPUT_PULLUP);
  bacaKredensial();
  if (modeSetup) {
    mulaiPortal();
    return;
  }

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000);
  setupSensors();
  setupRtc();
  setupSd();

  setupWiFi();
  ubidots = new Ubidots(ubidotsToken, MQTT_CLIENT);
  ubidots->begin(onMqttMessage);

  fbResults = xQueueCreate(4, sizeof(FbResult));
  loggerJobs = xQueueCreate(1, sizeof(LoggerJob));
  loggerResults = xQueueCreate(2, sizeof(LoggerResult));
  xTaskCreatePinnedToCore(firebaseTask, "firebase", 12288, nullptr, 1, nullptr, 0);
}

void loop() {
  if (modeSetup) {
    jalankanPortal();
    return;
  }
  cekTombolSetup();
  handleWiFi();
  handleMqtt();
  handleFailsafe();
  kirimUbidots();
  logHeap();
  handleFirebase();
  handleLogger();

  unsigned long now = millis();
  if (now - lastSensorMs >= SENSOR_INTERVAL_MS) {
    lastSensorMs = now;
    readSensors();
  }
  if (now - lastPublishMs >= PUBLISH_INTERVAL_MS) {
    lastPublishMs = now;
    publishSensors();
  }
}

// =====================================================================
// MOTOR
// =====================================================================
void setMotor(ESP32PWM& pwm, uint8_t pinA, uint8_t pinB, int dir, uint8_t speed, bool invert) {
  if (invert) dir = -dir;
  if (dir > 0) {
    digitalWrite(pinA, HIGH);
    digitalWrite(pinB, LOW);
  } else if (dir < 0) {
    digitalWrite(pinA, LOW);
    digitalWrite(pinB, HIGH);
  } else {
    digitalWrite(pinA, LOW);
    digitalWrite(pinB, LOW);
  }
  if (dir == 0) {
    pwm.write(0);
  } else {
    pwm.write(speed);
  }
}

void driveMotors(int kiri, int kanan, float skalaKiri, float skalaKanan) {
  setMotor(pwmKiri, PIN_MOTOR_IN1, PIN_MOTOR_IN2, kiri, (uint8_t)(currentSpeed * skalaKiri), MOTOR_KIRI_BALIK);
  setMotor(pwmKanan, PIN_MOTOR_IN3, PIN_MOTOR_IN4, kanan, (uint8_t)(currentSpeed * skalaKanan), MOTOR_KANAN_BALIK);
}

void putarDiTempat(int kiri, int kanan) {
  setMotor(pwmKiri, PIN_MOTOR_IN1, PIN_MOTOR_IN2, kiri, TURN_SPEED, MOTOR_KIRI_BALIK);
  setMotor(pwmKanan, PIN_MOTOR_IN3, PIN_MOTOR_IN4, kanan, TURN_SPEED, MOTOR_KANAN_BALIK);
}

void applyMove(Move m) {
  currentMove = m;
  switch (m) {
    case MOVE_MAJU:          driveMotors(1, 1, 1.0, 1.0);   break;
    case MOVE_MUNDUR:        driveMotors(-1, -1, 1.0, 1.0); break;
    case MOVE_KIRI:          putarDiTempat(-1, 1);          break;
    case MOVE_KANAN:         putarDiTempat(1, -1);          break;
    case MOVE_MAJU_KIRI:     driveMotors(1, 1, CURVE_RATIO, 1.0);   break;
    case MOVE_MAJU_KANAN:    driveMotors(1, 1, 1.0, CURVE_RATIO);   break;
    case MOVE_MUNDUR_KIRI:   driveMotors(-1, -1, CURVE_RATIO, 1.0); break;
    case MOVE_MUNDUR_KANAN:  driveMotors(-1, -1, 1.0, CURVE_RATIO); break;
    default:                 driveMotors(0, 0, 1.0, 1.0);   currentMove = MOVE_STOP; break;
  }
}

void stopMotors() {
  applyMove(MOVE_STOP);
}

void setupMotors() {
  const uint8_t pins[] = { PIN_MOTOR_IN1, PIN_MOTOR_IN2, PIN_MOTOR_IN3, PIN_MOTOR_IN4 };
  for (uint8_t p : pins) {
    pinMode(p, OUTPUT);
    digitalWrite(p, LOW);
  }
  pwmKiri.attachPin(PIN_MOTOR_ENA, MOTOR_PWM_FREQ, MOTOR_PWM_BITS);
  pwmKanan.attachPin(PIN_MOTOR_ENB, MOTOR_PWM_FREQ, MOTOR_PWM_BITS);
  stopMotors();
}

// =====================================================================
// SERVO
// =====================================================================
void setLengan(int deg) {
  lenganDeg = constrain(deg, LENGAN_MIN, LENGAN_MAX);
  servoLengan.write(lenganDeg);
}

void setCapit(int deg) {
  capitDeg = constrain(deg, CAPIT_MIN, CAPIT_MAX);
  servoCapit.write(capitDeg);
}

void setupServos() {
  servoLengan.setPeriodHertz(50);
  servoCapit.setPeriodHertz(50);
  servoLengan.attach(PIN_SERVO_LENGAN, SERVO_MIN_US, SERVO_MAX_US);
  servoCapit.attach(PIN_SERVO_CAPIT, SERVO_MIN_US, SERVO_MAX_US);
  setLengan(LENGAN_AWAL);
  setCapit(CAPIT_AWAL);
}

// =====================================================================
// SENSOR MLX90614
// =====================================================================
void readSensors() {
  if (!mlxOk && millis() - lastMlxRetryMs > 5000) {
    lastMlxRetryMs = millis();
    mlxOk = mlx.begin(MLX90614_I2CADDR, &Wire);
  }
  if (mlxOk) {
    suhuObjek = mlx.readObjectTempC();
  } else {
    suhuObjek = NAN;
  }
}

void setupSensors() {
  mlxOk = mlx.begin(MLX90614_I2CADDR, &Wire);
  if (mlxOk) {
    Serial.println("MLX90614: OK");
  } else {
    Serial.println("MLX90614: TIDAK ADA");
  }
}

// =====================================================================
// RTC DS3231 (dibaca apa adanya, tanpa NTP)
// =====================================================================
void setupRtc() {
  rtcOk = rtc.begin(&Wire);
  if (rtcOk) {
    Serial.println("DS3231: OK");
  } else {
    Serial.println("DS3231: TIDAK ADA (dicoba lagi tiap 10 dtk)");
  }
}

bool mulaiSd() {
  sdOk = SD.begin(PIN_SD_CS, SPI, 4000000);
  return sdOk;
}

void pilihFileBaru() {
  if (!sdOk) return;
  char nama[16];
  for (int i = 1; i <= 99; i++) {
    snprintf(nama, sizeof(nama), "/data%02d.txt", i);
    if (!SD.exists(nama) || i == 99) {
      strlcpy(namaFile, nama, sizeof(namaFile));
      break;
    }
  }
  dataKe = 0;
  Serial.printf("Logger: file %s\n", namaFile);
}

void setupSd() {
  SPI.begin(PIN_SD_SCK, PIN_SD_MISO, PIN_SD_MOSI, PIN_SD_CS);
  lastSdRetryMs = millis();
  if (mulaiSd()) {
    Serial.println("microSD: OK");
    pilihFileBaru();
  } else {
    Serial.println("microSD: TIDAK ADA (dicoba lagi tiap 30 dtk)");
  }
}

void cekSd() {
  if (sdOk || millis() - lastSdRetryMs < SD_RETRY_MS) return;
  lastSdRetryMs = millis();
  SD.end();
  if (mulaiSd()) {
    Serial.println("microSD: tersambung lagi");
    pilihFileBaru();
  }
}

bool tulisSd(const char* teks) {
  if (!sdOk || namaFile[0] == '\0') return false;
  File f = SD.open(namaFile, FILE_APPEND);
  if (!f) {
    sdOk = false;
    Serial.println("microSD gagal ditulis, dicoba lagi nanti");
    return false;
  }
  f.print(teks);
  f.close();
  return true;
}

bool ambilWaktu() {
  if (!rtcOk) rtcOk = rtc.begin(&Wire);
  if (!rtcOk) return false;
  DateTime now = rtc.now();
  String s = now.timestamp(DateTime::TIMESTAMP_FULL);
  s.replace("T", " ");
  strlcpy(waktuLog, s.c_str(), sizeof(waktuLog));
  tsLog = ((unsigned long long)now.unixtime() - WIB_OFFSET_S) * 1000ULL;
  return true;
}

void bacaData() {
  suhuLog = suhuObjek;
}

void simpanData() {
  char baris[48];
  snprintf(baris, sizeof(baris), "%s, %.2f, ", waktuLog, suhuLog);
  barisTerbuka = tulisSd(baris);
}

void simpanKode(int kode) {
  if (barisTerbuka) {
    char teks[16];
    snprintf(teks, sizeof(teks), "%d\n", kode);
    tulisSd(teks);
  }
  barisTerbuka = false;
  menungguKode = false;
  kodeSebelumnya = kode;
  tsSebelumnya = tsLog;
  adaKirimanSebelumnya = true;
  Serial.printf("Logger %s data ke-%lu: %s, %.2f -> %d\n", namaFile, dataKe, waktuLog, suhuLog, kode);
}

bool susunJson(char* out, size_t size) {
  JsonDocument doc;
  JsonObject so = doc["suhu_objek"].to<JsonObject>();
  so["value"] = serialized(String(suhuLog, 2));
  so["timestamp"] = tsLog;
  so["context"]["waktu"] = waktuLog;
  JsonObject dk = doc["data_ke"].to<JsonObject>();
  dk["value"] = dataKe;
  dk["timestamp"] = tsLog;
  if (adaKirimanSebelumnya) {
    JsonObject hc = doc["http_code"].to<JsonObject>();
    hc["value"] = kodeSebelumnya;
    hc["timestamp"] = tsSebelumnya;
  }
  size_t n = serializeJson(doc, out, size);
  return n > 0 && n < size - 1;
}

void kirimData() {
  if (WiFi.status() != WL_CONNECTED) {
    simpanKode(-1);
    return;
  }
  if (isnan(suhuLog)) {
    simpanKode(0);
    return;
  }
  LoggerJob job;
  job.id = ++loggerJobId;
  if (!susunJson(job.body, sizeof(job.body)) || xQueueSend(loggerJobs, &job, 0) != pdTRUE) {
    simpanKode(-1);
    return;
  }
  menungguKode = true;
  mulaiTungguMs = millis();
}

void terimaHasilLogger() {
  LoggerResult r;
  while (xQueueReceive(loggerResults, &r, 0) == pdTRUE) {
    if (menungguKode && r.id == loggerJobId) simpanKode(r.code);
  }
  if (!menungguKode) return;
  LoggerJob batal;
  if (WiFi.status() != WL_CONNECTED && xQueueReceive(loggerJobs, &batal, 0) == pdTRUE) {
    simpanKode(-1);
  } else if (millis() - mulaiTungguMs > LOGGER_TUNGGU_MAX_MS) {
    simpanKode(-1);
  }
}

void handleLogger() {
  cekSd();
  terimaHasilLogger();
  if (menungguKode || millis() - lastLoggerMs < LOGGER_INTERVAL_MS) return;
  lastLoggerMs = millis();
  if (gantiFile) {
    gantiFile = false;
    if (dataKe > 0) pilihFileBaru();
  }
  if (!ambilWaktu()) {
    Serial.println("Logger: RTC tidak terbaca, dicoba lagi");
    return;
  }
  bacaData();
  dataKe++;
  simpanData();
  kirimData();
}

// =====================================================================
// WIFI (hanya STA, ke hotspot HP)
// =====================================================================
void setupWiFi() {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);   // modem sleep mati: perintah gerak diterima tanpa jeda
  WiFi.setAutoReconnect(true);
  WiFi.begin(wifiSsid, wifiPass);
  lastWifiAttemptMs = millis();
  Serial.printf("Menghubungkan ke hotspot \"%s\"...\n", wifiSsid);
}

void handleWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasConnected) {
      Serial.print("WiFi terhubung, IP: ");
      Serial.println(WiFi.localIP());
      lastMqttAttemptMs = 0;
      if (wifiPernahTersambung && dataKe > 0) gantiFile = true;
      wifiPernahTersambung = true;
    }
    wifiWasConnected = true;
    return;
  }
  if (wifiWasConnected) {
    Serial.println("WiFi terputus");
    stopMotors();
  }
  wifiWasConnected = false;
  if (millis() - lastWifiAttemptMs > WIFI_RETRY_MS) {
    lastWifiAttemptMs = millis();
    WiFi.disconnect();
    WiFi.begin(wifiSsid, wifiPass);
  }
}

// =====================================================================
// UBIDOTS MQTT
// =====================================================================
void tandaiAck(int idx, int v) {
  acks[idx].value = v;
  acks[idx].pending = true;
}

void terimaGerak(int value) {
  lastCommandMs = millis();
  Move m = MOVE_STOP;
  if (value >= MOVE_STOP && value <= MOVE_MUNDUR_KANAN) m = (Move)value;
  bool berubah = m != currentMove || m != lastCmdGerak;
  lastCmdGerak = m;
  applyMove(m);
  if (berubah) tandaiAck(ACK_GERAK, currentMove);
}

void prosesPerintah(const char* nama, const char* teks) {
  int value = (int)lroundf(atof(teks));
  if (strcmp(nama, VAR_GERAK) == 0) {
    terimaGerak(value);
  } else if (strcmp(nama, VAR_SPEED) == 0) {
    currentSpeed = constrain(value, 0, 255);
    applyMove(currentMove);
  } else if (strcmp(nama, VAR_LENGAN) == 0) {
    setLengan(value);
    tandaiAck(ACK_LENGAN, lenganDeg);
  } else if (strcmp(nama, VAR_CAPIT) == 0) {
    setCapit(value);
    tandaiAck(ACK_CAPIT, capitDeg);
  } else if (strcmp(nama, VAR_BATAS_SUHU) == 0) {
    float b = atof(teks);
    if (b > 0) batasSuhu = b;
  } else if (strcmp(nama, VAR_KIRIM_HOTSPOT) == 0) {
    if (value == 1) requestHotspot(true);
  }
  tandaiDiterima(nama);
  Serial.printf("RX %s = %d\n", nama, value);
}

void salinPayload(byte* payload, unsigned int length, char* buf, size_t size) {
  unsigned int n = length;
  if (n > size - 1) n = size - 1;
  memcpy(buf, payload, n);
  buf[n] = '\0';
}

bool ambilNama(const char* topic, const char* awalan, const char* akhiran, char* out, size_t size) {
  size_t la = strlen(awalan), lt = strlen(topic), lk = strlen(akhiran);
  if (strncmp(topic, awalan, la) != 0 || lt < la + lk) return false;
  if (lk > 0 && strcmp(topic + lt - lk, akhiran) != 0) return false;
  size_t n = lt - la - lk;
  if (n == 0 || n >= size) return false;
  memcpy(out, topic + la, n);
  out[n] = '\0';
  return true;
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  char awalan[40], nama[24], teks[16];
  snprintf(awalan, sizeof(awalan), "/v1.6/devices/%s/", DEVICE_LABEL);
  if (!ambilNama(topic, awalan, "/lv", nama, sizeof(nama))) return;
  salinPayload(payload, length, teks, sizeof(teks));
  prosesPerintah(nama, teks);
}

void kirimUbidots() {
  if (WiFi.status() != WL_CONNECTED || !ubidots->connected()) return;
  if (millis() - lastUbiPublishMs < PUBLISH_JEDA_MS) return;
  int count = 0;
  for (int i = 0; i < ACK_JUMLAH; i++) {
    if (!acks[i].pending) continue;
    ubidots->add(acks[i].ubiVar, acks[i].value);
    acks[i].pending = false;
    count++;
  }
  if (fbTunggu && count + 4 <= MAKS_NILAI) {
    ubidots->add(VAR_FB_CODE, fbHasil.code);
    ubidots->add(VAR_FB_JENIS, fbHasil.jenis);
    count += 2;
    if (!isnan(fbHasil.suhu)) {
      ubidots->add(VAR_FB_SUHU, fbHasil.suhu);
      count++;
    }
    fbTunggu = false;
  }
  if (hotspotTunggu && count < MAKS_NILAI) {
    ubidots->add(VAR_HOTSPOT, 1);
    hotspotTunggu = false;
    count++;
  }
  if (suhuTunggu && count < MAKS_NILAI) {
    if (!isnan(suhuObjek)) {
      ubidots->add(VAR_SUHU_OBJEK, suhuObjek);
      count++;
    }
    suhuTunggu = false;
  }
  if (count > 0) {
    ubidots->ubidotsPublish(DEVICE_LABEL);
    lastUbiPublishMs = millis();
  }
}

void logHeap() {
  if (!DEBUG_HEAP || millis() - lastHeapLogMs < HEAP_LOG_MS) return;
  lastHeapLogMs = millis();
  Serial.printf("Heap bebas %lu B (minimum %lu B)\n", (unsigned long)ESP.getFreeHeap(), (unsigned long)ESP.getMinFreeHeap());
}

void onMqttConnected() {
  Serial.println("MQTT Ubidots terhubung");
  tandaiAck(ACK_GERAK, MOVE_STOP);
  ubidots->add(VAR_GERAK, 0);
  ubidots->add(VAR_KIRIM_HOTSPOT, 0);
  ubidots->ubidotsPublish(DEVICE_LABEL);
  lastUbiPublishMs = millis();
  mqttWasConnected = true;
  langgananSemua();
}

void handleMqtt() {
  if (WiFi.status() != WL_CONNECTED) {
    catatPutus();
    return;
  }
  if (ubidots->connected()) {
    ubidots->loop();
    langgananUlang();
    return;
  }
  catatPutus();
  if (millis() - lastMqttAttemptMs < MQTT_RETRY_MS && lastMqttAttemptMs != 0) return;
  lastMqttAttemptMs = millis();
  stopMotors();
  if (ubidots->connect()) onMqttConnected();
  else Serial.println("MQTT gagal, coba lagi...");
}

void publishSensors() {
  suhuTunggu = true;
}

// =====================================================================
// WEB DOSEN (Firebase) — HTTPS berjalan di task terpisah (core 0)
// =====================================================================
int firebasePatch(const String& body) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setConnectTimeout(FIREBASE_TIMEOUT_MS);
  http.setTimeout(FIREBASE_TIMEOUT_MS);
  if (!http.begin(client, FIREBASE_URL)) return -1;
  http.addHeader("Content-Type", "application/json");
  int code = http.PATCH(body);
  http.end();
  return code;
}

int loggerPost(const char* body) {
  WiFiClientSecure client;
  client.setInsecure();
  HTTPClient http;
  http.setConnectTimeout(LOGGER_TIMEOUT_MS);
  http.setTimeout(LOGGER_TIMEOUT_MS);
  if (!http.begin(client, LOGGER_URL)) return -1;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Auth-Token", ubidotsToken);
  int code = http.POST((uint8_t*)body, strlen(body));
  http.end();
  return code;
}

bool jalankanLogger() {
  LoggerJob job;
  if (xQueueReceive(loggerJobs, &job, 0) != pdTRUE) return false;
  LoggerResult r = { job.id, loggerPost(job.body) };
  xQueueSend(loggerResults, &r, 0);
  return true;
}

void kirimFirebase(int jenis) {
  FbResult r;
  String body;
  if (jenis == FB_HOTSPOT) {
    wantHotspot = false;
    body = "{\"hotspot\":true}";
  } else {
    wantData = false;
    body = String("{\"suhu\":") + String(pendingSuhu, 1) + ",\"wifi\":true}";
  }
  r.jenis = jenis;
  r.suhu = pendingSuhu;
  r.code = firebasePatch(body);
  xQueueSend(fbResults, &r, 0);
}

void firebaseTask(void*) {
  for (;;) {
    if (WiFi.status() == WL_CONNECTED) {
      if (wantHotspot) {
        kirimFirebase(FB_HOTSPOT);
      } else if (!jalankanLogger() && wantData) {
        kirimFirebase(FB_DATA);
      }
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

void publishFbResult(const FbResult& r) {
  if (fbTunggu && fbHasil.jenis == FB_HOTSPOT && r.jenis != FB_HOTSPOT) {
    return;
  }
  fbHasil = r;
  fbTunggu = true;
  if (r.jenis == FB_HOTSPOT && r.code >= 200 && r.code < 300) {
    hotspotTunggu = true;
  }
}

void requestHotspot(bool manual) {
  if (isnan(suhuObjek) || suhuObjek < batasSuhu) {
    if (manual) {
      FbResult r = { FB_DITOLAK, FB_HOTSPOT, suhuObjek };
      lastFbCode = r.code;
      publishFbResult(r);
      Serial.printf("Hotspot DITOLAK: suhu %.1f < batas %.1f\n", suhuObjek, batasSuhu);
    }
    return;
  }
  pendingSuhu = suhuObjek;
  wantHotspot = true;
  lastHotspotTryMs = millis();
}

void handleFirebase() {
  FbResult r;
  while (xQueueReceive(fbResults, &r, 0) == pdTRUE) {
    lastFbCode = r.code;
    bool ok = r.code >= 200 && r.code < 300;
    if (r.jenis == FB_HOTSPOT && ok) hotspotSent = true;
    const char* jenisText;
    if (r.jenis == FB_HOTSPOT) {
      jenisText = "hotspot";
    } else {
      jenisText = "data";
    }
    Serial.printf("Web dosen %s -> HTTP %d\n", jenisText, r.code);
    publishFbResult(r);
  }
  if (WiFi.status() != WL_CONNECTED) return;
  unsigned long now = millis();
  if (!hotspotSent && !wantHotspot && now - lastHotspotTryMs >= HOTSPOT_RETRY_MS) requestHotspot(false);
  if (!isnan(suhuObjek) && now - lastFirebaseDataMs >= FIREBASE_DATA_MS) {
    lastFirebaseDataMs = now;
    pendingSuhu = suhuObjek;
    wantData = true;
  }
}

// =====================================================================
// SUBSCRIBE ULANG & ANTREAN PUBLISH (maks. 1 kiriman per detik)
// =====================================================================
void langgananSemua() {
  for (int i = 0; i < SUB_JUMLAH; i++) {
    subDapat[i] = false;
    ubidots->ubidotsSubscribe(DEVICE_LABEL, SUB_VARS[i]);
  }
  lastSubMs = millis();
}

void langgananUlang() {
  if (millis() - lastSubMs < SUB_ULANG_MS) {
    return;
  }
  lastSubMs = millis();
  for (int i = 0; i < SUB_JUMLAH; i++) {
    if (subDapat[i]) {
      continue;
    }
    ubidots->ubidotsSubscribe(DEVICE_LABEL, SUB_VARS[i]);
    Serial.printf("Subscribe ulang %s (belum ada pesan)\n", SUB_VARS[i]);
  }
}

void tandaiDiterima(const char* nama) {
  for (int i = 0; i < SUB_JUMLAH; i++) {
    if (strcmp(nama, SUB_VARS[i]) == 0) {
      subDapat[i] = true;
    }
  }
}

void catatPutus() {
  if (!mqttWasConnected) {
    return;
  }
  mqttWasConnected = false;
  mqttPutusCount++;
  Serial.printf("MQTT terputus (ke-%d), motor berhenti, sambung ulang...\n", mqttPutusCount);
}

// =====================================================================
// FAILSAFE
// =====================================================================
void handleFailsafe() {
  if (currentMove == MOVE_STOP) return;
  bool linkOk = WiFi.status() == WL_CONNECTED && ubidots->connected();
  if (!linkOk || millis() - lastCommandMs > FAILSAFE_TIMEOUT_MS) {
    stopMotors();
    tandaiAck(ACK_GERAK, MOVE_STOP);
    if (linkOk) Serial.printf("FAILSAFE: tidak ada perintah gerak > %lu ms\n", FAILSAFE_TIMEOUT_MS);
    else Serial.println("FAILSAFE: koneksi terputus");
  }
}

// =====================================================================
// PORTAL Phantom-Setup (WiFi + token Ubidots, disimpan di NVS)
// =====================================================================
void bacaKredensial() {
  prefs.begin(PREFS_NAMA, false);
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  String token = prefs.getString("token", "");
  modeSetup = prefs.getBool("setup", false);
  prefs.end();

  if (ssid.length() > 0) {
    strlcpy(wifiSsid, ssid.c_str(), sizeof(wifiSsid));
    strlcpy(wifiPass, pass.c_str(), sizeof(wifiPass));
  } else {
    strlcpy(wifiSsid, WIFI_SSID_DEFAULT, sizeof(wifiSsid));
    strlcpy(wifiPass, WIFI_PASS_DEFAULT, sizeof(wifiPass));
  }
  if (token.length() > 0) {
    strlcpy(ubidotsToken, token.c_str(), sizeof(ubidotsToken));
    sumberToken = "tersimpan dari portal";
  } else {
    strlcpy(ubidotsToken, TOKEN_DEFAULT, sizeof(ubidotsToken));
    sumberToken = "default program";
  }
  Serial.printf("Token Ubidots: %s (%s)\n", tokenSamar().c_str(), sumberToken);
  Serial.println("Tahan tombol BOOT 3 detik untuk membuka portal Phantom-Setup");
}

String tokenSamar() {
  String t = String(ubidotsToken);
  if (t.length() <= 9) {
    return "****";
  }
  return t.substring(0, 5) + "..." + t.substring(t.length() - 4);
}

String escapeHtml(String s) {
  s.replace("&", "&amp;");
  s.replace("<", "&lt;");
  s.replace(">", "&gt;");
  s.replace("\"", "&quot;");
  return s;
}

void cekTombolSetup() {
  if (digitalRead(PIN_TOMBOL_SETUP) == HIGH) {
    tombolDitekanMs = 0;
    return;
  }
  if (tombolDitekanMs == 0) {
    tombolDitekanMs = millis();
    return;
  }
  if (millis() - tombolDitekanMs < SETUP_TAHAN_MS) {
    return;
  }
  stopMotors();
  Serial.println("Tombol BOOT ditahan: restart ke portal Phantom-Setup");
  prefs.begin(PREFS_NAMA, false);
  prefs.putBool("setup", true);
  prefs.end();
  ESP.restart();
}

void mulaiPortal() {
  prefs.begin(PREFS_NAMA, false);
  prefs.putBool("setup", false);
  prefs.end();

  WiFi.persistent(false);
  WiFi.mode(WIFI_AP);
  WiFi.softAP(SETUP_AP_SSID, SETUP_AP_PASS);
  dnsPortal.start(53, "*", WiFi.softAPIP());
  portal.on("/", HTTP_GET, halamanPortal);
  portal.on("/simpan", HTTP_POST, simpanPortal);
  portal.on("/default", HTTP_POST, resetPortal);
  portal.onNotFound(alihkanPortal);
  portal.begin();
  setupMulaiMs = millis();
  Serial.printf("PORTAL: sambungkan HP ke WiFi \"%s\" (password \"%s\"), buka http://%s\n",
                SETUP_AP_SSID, SETUP_AP_PASS, WiFi.softAPIP().toString().c_str());
}

void jalankanPortal() {
  dnsPortal.processNextRequest();
  portal.handleClient();
  if (restartPadaMs != 0 && millis() - restartPadaMs > SETUP_RESTART_MS) {
    ESP.restart();
  }
  if (millis() - setupMulaiMs > SETUP_TIMEOUT_MS) {
    Serial.println("PORTAL: waktu habis, restart ke mode normal");
    ESP.restart();
  }
}

void alihkanPortal() {
  portal.sendHeader("Location", "http://" + WiFi.softAPIP().toString() + "/", true);
  portal.send(302, "text/plain", "");
}

void kirimHalaman(String isi) {
  String h;
  h.reserve(2600);
  h += F("<!doctype html><html lang=\"id\"><head><meta charset=\"utf-8\">");
  h += F("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Phantom-Setup</title><style>");
  h += F("body{font-family:sans-serif;background:#070b12;color:#e6edf7;margin:0;padding:16px}");
  h += F("form,.box{max-width:420px;margin:0 auto 12px;background:#111a28;padding:16px;border-radius:12px}");
  h += F("label{display:block;margin:10px 0 4px;font-size:14px}small{color:#8fa3bf}");
  h += F("input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2a3a55;background:#0b1220;color:#e6edf7;font-size:16px}");
  h += F("button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:8px;background:#3b8eea;color:#fff;font-size:16px;font-weight:700}");
  h += F(".ghost{background:transparent;border:1px solid #2a3a55;color:#e6edf7}</style></head><body>");
  h += isi;
  h += F("</body></html>");
  portal.send(200, "text/html", h);
}

void halamanPortal() {
  String isi;
  isi.reserve(1600);
  isi += F("<form method=\"post\" action=\"/simpan\"><h2>PHANTOM Setup</h2>");
  isi += F("<label>Nama WiFi (SSID)</label><input name=\"ssid\" maxlength=\"32\" value=\"");
  isi += escapeHtml(String(wifiSsid));
  isi += F("\"><label>Password WiFi</label><input name=\"pass\" type=\"password\" maxlength=\"64\" placeholder=\"kosongkan = tetap\">");
  isi += F("<label>Token Ubidots</label><input id=\"tok\" name=\"token\" type=\"password\" maxlength=\"79\" ");
  isi += F("placeholder=\"kosongkan = tetap\" autocapitalize=\"off\" spellcheck=\"false\">");
  isi += F("<button type=\"button\" class=\"ghost\" onclick=\"var t=document.getElementById('tok');");
  isi += F("if(t.type=='password'){t.type='text'}else{t.type='password'}\">Tampilkan / sembunyikan token</button>");
  isi += "<p><small>Token sekarang: " + tokenSamar() + " (" + sumberToken + ")</small></p>";
  isi += F("<button>Simpan &amp; restart</button></form>");
  isi += F("<form method=\"post\" action=\"/default\"><small>Hapus WiFi &amp; token tersimpan, kembali ke isi secrets.h.</small>");
  isi += F("<button class=\"ghost\">Pakai default program</button></form>");
  kirimHalaman(isi);
}

void simpanPortal() {
  String ssid = portal.arg("ssid");
  String pass = portal.arg("pass");
  String token = portal.arg("token");
  ssid.trim();
  token.trim();
  if (ssid.length() > 32 || pass.length() > 64 || token.length() >= sizeof(ubidotsToken)) {
    kirimHalaman(F("<div class=\"box\"><h2>Isian terlalu panjang</h2><a href=\"/\">Kembali</a></div>"));
    return;
  }
  prefs.begin(PREFS_NAMA, false);
  if (ssid.length() > 0) {
    if (pass.length() > 0 || ssid != String(wifiSsid)) {
      prefs.putString("pass", pass);
    } else {
      prefs.putString("pass", String(wifiPass));
    }
    prefs.putString("ssid", ssid);
  }
  if (token.length() > 0) {
    prefs.putString("token", token);
  }
  prefs.end();
  Serial.println("PORTAL: tersimpan, restart...");
  kirimHalaman(F("<div class=\"box\"><h2>Tersimpan</h2><p>Robot restart dan tersambung ke WiFi baru.</p></div>"));
  restartPadaMs = millis();
}

void resetPortal() {
  prefs.begin(PREFS_NAMA, false);
  prefs.remove("ssid");
  prefs.remove("pass");
  prefs.remove("token");
  prefs.end();
  Serial.println("PORTAL: kembali ke default program, restart...");
  kirimHalaman(F("<div class=\"box\"><h2>Default dipakai</h2><p>Robot restart memakai isi secrets.h.</p></div>"));
  restartPadaMs = millis();
}
