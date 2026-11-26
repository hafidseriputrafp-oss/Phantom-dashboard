/*
 * PHANTOM — program LOMBA (kontrol + sensor + kirim data suhu & hotspot ke web dosen)
 * Board  : ESP32 Dev Module
 * Library: Ubidots MQTT for ESP32 and ESP8266 (UbidotsESPMQTT.h) + PubSubClient,
 *          ESP32Servo, Adafruit MLX90614, RTClib (Adafruit), SD/SPI/Wire (bawaan core ESP32)
 * Kredensial ada di secrets.h (salin dari secrets.example.h, jangan di-commit).
 * WiFi hanya mode STA: robot terhubung ke hotspot HP, tidak pernah membuat WiFi sendiri.
 */

#include <Wire.h>
#include <SPI.h>
#include <SD.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <PubSubClient.h>
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

// ---------- KREDENSIAL ----------
char UBIDOTS_TOKEN[] = SECRET_UBIDOTS_TOKEN;
char DEVICE_LABEL[]  = "phantom";
const char* WIFI_SSID = SECRET_WIFI_SSID;
const char* WIFI_PASS = SECRET_WIFI_PASS;
const char* FIREBASE_URL = SECRET_FIREBASE_URL;   // .../missions/teamXX.json
const char* EMQX_USER = SECRET_EMQX_USER;
const char* EMQX_PASS = SECRET_EMQX_PASS;

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

// ---------- EMQX (jalur kontrol cepat) ----------
const char* EMQX_HOST       = "ke187fc1.ala.asia-southeast1.emqxsl.com";
const uint16_t EMQX_PORT    = 8883;
const char* EMQX_CLIENT_ID  = "garuda13-phantom-emqx";
const char* EMQX_PREFIX_CMD = "garuda13/phantom/cmd/";
const char* EMQX_SUB_CMD    = "garuda13/phantom/cmd/#";
const char* EMQX_STATUS     = "garuda13/phantom/status";
const uint16_t EMQX_KEEPALIVE_S = 15;
const unsigned long EMQX_RETRY_MS = 3000;
const bool DEBUG_HEAP = true;
const unsigned long HEAP_LOG_MS = 10000;

// ---------- PARAMETER ----------
const unsigned long PUBLISH_INTERVAL_MS = 5000;   // kirim suhu ke Ubidots
const unsigned long SENSOR_INTERVAL_MS  = 1000;   // baca MLX90614
const unsigned long HEARTBEAT_MS        = 1500;   // dashboard kirim ulang "gerak" tiap 1,5 dtk saat ditahan
const unsigned long FAILSAFE_TIMEOUT_MS = HEARTBEAT_MS + 1500;   // toleransi antrean request + jaringan
const unsigned long MQTT_RETRY_MS       = 3000;
const unsigned long WIFI_RETRY_MS       = 10000;
const long          WIB_OFFSET_S        = 7 * 3600;

const unsigned long LOGGER_INTERVAL_MS   = 10000;
const unsigned long LOGGER_TUNGGU_MAX_MS = 30000;
const unsigned long SD_RETRY_MS          = 30000;
const uint16_t      LOGGER_TIMEOUT_MS    = 5000;
const char*         LOGGER_URL           = "https://industrial.api.ubidots.com/api/v1.6/devices/logger";
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

const int LENGAN_MIN = 0, LENGAN_MAX = 180;
const int CAPIT_MIN = 20, CAPIT_MAX = 110;     // BUKA 20, TUTUP 110 (hasil kalibrasi)
const int LENGAN_AWAL = 135, CAPIT_AWAL = 110;
const int SERVO_MIN_US = 500, SERVO_MAX_US = 2400;

// ---------- OBJEK ----------
enum Move {
  MOVE_STOP = 0, MOVE_MAJU = 1, MOVE_MUNDUR = 2, MOVE_KIRI = 3, MOVE_KANAN = 4,
  MOVE_MAJU_KIRI = 5, MOVE_MAJU_KANAN = 6, MOVE_MUNDUR_KIRI = 7, MOVE_MUNDUR_KANAN = 8,
};
const char* MOVE_NAMES[] = { "STOP", "MAJU", "MUNDUR", "PUTAR KIRI", "PUTAR KANAN", "MAJU-KIRI", "MAJU-KANAN", "MUNDUR-KIRI", "MUNDUR-KANAN" };

char MQTT_CLIENT[] = "garuda13-phantom";
Ubidots ubidots(UBIDOTS_TOKEN, MQTT_CLIENT);
WiFiClientSecure emqxNet;
PubSubClient emqx(emqxNet);
SemaphoreHandle_t emqxLock;
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
  bool viaUbidots;
  char* ubiVar;
  const char* emqxTopic;
};
enum { ACK_GERAK = 0, ACK_LENGAN = 1, ACK_CAPIT = 2, ACK_JUMLAH = 3 };
Ack acks[ACK_JUMLAH] = {
  { false, 0, false, VAR_ACK_GERAK,  "garuda13/phantom/ack/gerak" },
  { false, 0, false, VAR_ACK_LENGAN, "garuda13/phantom/ack/lengan" },
  { false, 0, false, VAR_ACK_CAPIT,  "garuda13/phantom/ack/capit" },
};
const uint8_t ASAL_UBIDOTS = 0, ASAL_EMQX = 1;
volatile bool emqxBaruTersambung = false;
bool emqxAktif = false;
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

void requestHotspot(bool manual);

bool mlxOk = false, rtcOk = false, sdOk = false;
bool wifiWasConnected = false, wifiPernahTersambung = false;
unsigned long lastWifiAttemptMs = 0, lastMqttAttemptMs = 0, lastSensorMs = 0, lastPublishMs = 0, lastMlxRetryMs = 0;

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

void applyMove(Move m) {
  currentMove = m;
  switch (m) {
    case MOVE_MAJU:          driveMotors(1, 1, 1.0, 1.0);   break;
    case MOVE_MUNDUR:        driveMotors(-1, -1, 1.0, 1.0); break;
    case MOVE_KIRI:          driveMotors(-1, 1, 1.0, 1.0);  break;
    case MOVE_KANAN:         driveMotors(1, -1, 1.0, 1.0);  break;
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
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  lastWifiAttemptMs = millis();
  Serial.printf("Menghubungkan ke hotspot \"%s\"...\n", WIFI_SSID);
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
    WiFi.begin(WIFI_SSID, WIFI_PASS);
  }
}

// =====================================================================
// UBIDOTS MQTT
// =====================================================================
void tandaiAck(int idx, int v, bool viaUbidots) {
  acks[idx].value = v;
  acks[idx].viaUbidots = viaUbidots;
  acks[idx].pending = true;
}

void terimaGerak(int value, bool viaUbidots) {
  lastCommandMs = millis();
  Move m = MOVE_STOP;
  if (value >= MOVE_STOP && value <= MOVE_MUNDUR_KANAN) m = (Move)value;
  bool berubah = m != currentMove || m != lastCmdGerak;
  lastCmdGerak = m;
  applyMove(m);
  if (berubah) tandaiAck(ACK_GERAK, currentMove, viaUbidots);
}

void prosesPerintah(const char* nama, const char* teks, uint8_t asal) {
  int value = (int)lroundf(atof(teks));
  bool viaUbidots = asal == ASAL_UBIDOTS;
  if (strcmp(nama, VAR_GERAK) == 0) {
    terimaGerak(value, viaUbidots);
  } else if (strcmp(nama, VAR_SPEED) == 0) {
    currentSpeed = constrain(value, 0, 255);
    applyMove(currentMove);
  } else if (strcmp(nama, VAR_LENGAN) == 0) {
    setLengan(value);
    tandaiAck(ACK_LENGAN, lenganDeg, viaUbidots);
  } else if (strcmp(nama, VAR_CAPIT) == 0) {
    setCapit(value);
    tandaiAck(ACK_CAPIT, capitDeg, viaUbidots);
  } else if (strcmp(nama, VAR_BATAS_SUHU) == 0) {
    float b = atof(teks);
    if (b > 0) batasSuhu = b;
  } else if (strcmp(nama, VAR_KIRIM_HOTSPOT) == 0) {
    if (value == 1) requestHotspot(true);
  }
  if (viaUbidots) {
    Serial.printf("RX Ubidots %s = %d\n", nama, value);
  } else {
    Serial.printf("RX EMQX %s = %d\n", nama, value);
  }
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
  prosesPerintah(nama, teks, ASAL_UBIDOTS);
}

// =====================================================================
// EMQX MQTT (TLS 8883) — koneksi dibuat di task core 0, loop() tidak pernah menunggu
// =====================================================================
void onEmqxMessage(char* topic, byte* payload, unsigned int length) {
  char nama[24], teks[16];
  if (!ambilNama(topic, EMQX_PREFIX_CMD, "", nama, sizeof(nama))) return;
  salinPayload(payload, length, teks, sizeof(teks));
  prosesPerintah(nama, teks, ASAL_EMQX);
}

void emqxSambung() {
  if (emqx.connect(EMQX_CLIENT_ID, EMQX_USER, EMQX_PASS, EMQX_STATUS, 1, true, "offline")) {
    emqx.publish(EMQX_STATUS, "online", true);
    emqx.subscribe(EMQX_SUB_CMD, 1);
    emqxBaruTersambung = true;
  } else {
    Serial.printf("EMQX gagal, rc=%d\n", emqx.state());
  }
}

void emqxConnectTask(void* arg) {
  for (;;) {
    if (WiFi.status() == WL_CONNECTED && xSemaphoreTake(emqxLock, portMAX_DELAY) == pdTRUE) {
      if (!emqx.connected()) emqxSambung();
      xSemaphoreGive(emqxLock);
    }
    vTaskDelay(pdMS_TO_TICKS(EMQX_RETRY_MS));
  }
}

void setupEmqx() {
  emqxLock = xSemaphoreCreateMutex();
  emqxNet.setInsecure();
  emqxNet.setHandshakeTimeout(8);
  emqx.setServer(EMQX_HOST, EMQX_PORT);
  emqx.setKeepAlive(EMQX_KEEPALIVE_S);
  emqx.setSocketTimeout(5);
  emqx.setBufferSize(256);
  emqx.setCallback(onEmqxMessage);
  xTaskCreatePinnedToCore(emqxConnectTask, "emqx", 10240, nullptr, 1, nullptr, 0);
}

void handleEmqx() {
  if (xSemaphoreTake(emqxLock, 0) != pdTRUE) {
    emqxAktif = false;
    return;
  }
  emqxAktif = emqx.connected();
  if (emqxAktif) emqx.loop();
  xSemaphoreGive(emqxLock);
  if (emqxBaruTersambung) {
    emqxBaruTersambung = false;
    Serial.println("EMQX terhubung");
    tandaiAck(ACK_GERAK, currentMove, false);
  }
}

void kirimAckEmqx() {
  if (xSemaphoreTake(emqxLock, 0) != pdTRUE) return;
  if (emqx.connected()) {
    char buf[12];
    for (int i = 0; i < ACK_JUMLAH; i++) {
      if (!acks[i].pending || acks[i].viaUbidots) continue;
      snprintf(buf, sizeof(buf), "%d", acks[i].value);
      if (emqx.publish(acks[i].emqxTopic, buf)) acks[i].pending = false;
    }
  }
  xSemaphoreGive(emqxLock);
}

void kirimAckUbidots() {
  if (WiFi.status() != WL_CONNECTED || !ubidots.connected()) return;
  int count = 0;
  for (int i = 0; i < ACK_JUMLAH; i++) {
    if (!acks[i].pending) continue;
    ubidots.add(acks[i].ubiVar, acks[i].value);
    acks[i].pending = false;
    count++;
  }
  if (count > 0) ubidots.ubidotsPublish(DEVICE_LABEL);
}

void kirimAck() {
  kirimAckEmqx();
  kirimAckUbidots();
}

void logHeap() {
  if (!DEBUG_HEAP || millis() - lastHeapLogMs < HEAP_LOG_MS) return;
  lastHeapLogMs = millis();
  if (emqxAktif) {
    Serial.printf("Heap bebas %lu B (minimum %lu B), EMQX tersambung\n", (unsigned long)ESP.getFreeHeap(), (unsigned long)ESP.getMinFreeHeap());
  } else {
    Serial.printf("Heap bebas %lu B (minimum %lu B), EMQX belum tersambung\n", (unsigned long)ESP.getFreeHeap(), (unsigned long)ESP.getMinFreeHeap());
  }
}

void onMqttConnected() {
  Serial.println("MQTT Ubidots terhubung");
  tandaiAck(ACK_GERAK, MOVE_STOP, false);
  ubidots.add(VAR_GERAK, 0);
  ubidots.add(VAR_KIRIM_HOTSPOT, 0);
  ubidots.ubidotsPublish(DEVICE_LABEL);
  ubidots.ubidotsSubscribe(DEVICE_LABEL, VAR_GERAK);
  ubidots.ubidotsSubscribe(DEVICE_LABEL, VAR_SPEED);
  ubidots.ubidotsSubscribe(DEVICE_LABEL, VAR_LENGAN);
  ubidots.ubidotsSubscribe(DEVICE_LABEL, VAR_CAPIT);
  ubidots.ubidotsSubscribe(DEVICE_LABEL, VAR_BATAS_SUHU);
  ubidots.ubidotsSubscribe(DEVICE_LABEL, VAR_KIRIM_HOTSPOT);
}

void handleMqtt() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (ubidots.connected()) {
    ubidots.loop();
    return;
  }
  if (millis() - lastMqttAttemptMs < MQTT_RETRY_MS && lastMqttAttemptMs != 0) return;
  lastMqttAttemptMs = millis();
  if (!emqxAktif) stopMotors();
  if (ubidots.connect()) onMqttConnected();
  else Serial.println("MQTT gagal, coba lagi...");
}

void publishSensors() {
  if (WiFi.status() != WL_CONNECTED || !ubidots.connected()) return;
  int count = 0;
  if (!isnan(suhuObjek)) { ubidots.add(VAR_SUHU_OBJEK, suhuObjek); count++; }
  if (count > 0) ubidots.ubidotsPublish(DEVICE_LABEL);
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
  http.addHeader("X-Auth-Token", UBIDOTS_TOKEN);
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
  if (!ubidots.connected()) return;
  ubidots.add(VAR_FB_CODE, r.code);
  ubidots.add(VAR_FB_JENIS, r.jenis);
  if (!isnan(r.suhu)) ubidots.add(VAR_FB_SUHU, r.suhu);
  if (r.jenis == FB_HOTSPOT && r.code >= 200 && r.code < 300) ubidots.add(VAR_HOTSPOT, 1);
  ubidots.ubidotsPublish(DEVICE_LABEL);
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
// FAILSAFE
// =====================================================================
void handleFailsafe() {
  if (currentMove == MOVE_STOP) return;
  bool linkOk = WiFi.status() == WL_CONNECTED && (ubidots.connected() || emqxAktif);
  if (!linkOk || millis() - lastCommandMs > FAILSAFE_TIMEOUT_MS) {
    stopMotors();
    tandaiAck(ACK_GERAK, MOVE_STOP, false);
    if (linkOk) Serial.printf("FAILSAFE: tidak ada heartbeat > %lu ms\n", FAILSAFE_TIMEOUT_MS);
    else Serial.println("FAILSAFE: koneksi terputus");
  }
}

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

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000);
  setupSensors();
  setupRtc();
  setupSd();

  setupWiFi();
  ubidots.begin(onMqttMessage);
  setupEmqx();

  fbResults = xQueueCreate(4, sizeof(FbResult));
  loggerJobs = xQueueCreate(1, sizeof(LoggerJob));
  loggerResults = xQueueCreate(2, sizeof(LoggerResult));
  xTaskCreatePinnedToCore(firebaseTask, "firebase", 12288, nullptr, 1, nullptr, 0);
}

void loop() {
  handleWiFi();
  handleMqtt();
  handleEmqx();
  handleFailsafe();
  kirimAck();
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
