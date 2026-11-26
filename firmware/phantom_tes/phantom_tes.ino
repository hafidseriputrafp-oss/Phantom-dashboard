/*
 * PHANTOM — program TES (kontrol + sensor, tanpa kirim ke web dosen)
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
#include <time.h>
#include <WiFi.h>
#include <Preferences.h>
#include <WebServer.h>
#include <DNSServer.h>
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

// ---------- VARIABEL UBIDOTS ----------
char VAR_GERAK[]        = "gerak";
char VAR_SPEED[]        = "speed";
char VAR_LENGAN[]       = "lengan";
char VAR_CAPIT[]        = "capit";
char VAR_SUHU_OBJEK[]   = "suhu_objek";
char VAR_ACK_GERAK[]    = "ack_gerak";
char VAR_ACK_LENGAN[]   = "ack_lengan";
char VAR_ACK_CAPIT[]    = "ack_capit";

// ---------- PARAMETER ----------
const bool DEBUG_HEAP = true;
const unsigned long HEAP_LOG_MS = 10000;
const unsigned long PUBLISH_INTERVAL_MS = 5000;   // kirim suhu ke Ubidots
const unsigned long SENSOR_INTERVAL_MS  = 1000;   // baca sensor & log microSD
const unsigned long HEARTBEAT_MS        = 1500;   // dashboard kirim ulang "gerak" tiap 1,5 dtk saat ditahan
const unsigned long FAILSAFE_TIMEOUT_MS = HEARTBEAT_MS + 1500;   // toleransi antrean request + jaringan
const unsigned long MQTT_RETRY_MS       = 3000;
const unsigned long WIFI_RETRY_MS       = 30000;
const unsigned long SETUP_TAHAN_MS      = 3000;     // lama tahan tombol BOOT
const unsigned long SETUP_TIMEOUT_MS    = 300000;   // portal tutup sendiri setelah 5 menit
const unsigned long SETUP_RESTART_MS    = 1500;
const char*         SETUP_AP_SSID       = "Phantom-Setup";
const char*         SETUP_AP_PASS       = "phantom123";
const char*         PREFS_NAMA          = "phantom";
const long          GMT_OFFSET_S        = 7 * 3600;   // WIB
const char*         LOG_FILE            = "/phantom_tes.csv";

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
unsigned long lastHeapLogMs = 0;
float suhuObjek = NAN;

bool mlxOk = false, rtcOk = false, sdOk = false;
bool wifiWasConnected = false, timeSynced = false, ntpStarted = false;
unsigned long lastWifiAttemptMs = 0, lastMqttAttemptMs = 0, lastSensorMs = 0, lastPublishMs = 0, lastMlxRetryMs = 0;
bool modeSetup = false;
unsigned long tombolDitekanMs = 0, setupMulaiMs = 0, restartPadaMs = 0;

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
void handleTimeSync();
void formatTimestamp(char* buf, size_t len);
void setupSd();
void logToSd();
void setupWiFi();
void handleWiFi();
void tandaiAck(int idx, int v);
void terimaGerak(int value);
void prosesPerintah(const char* nama, const char* teks);
void salinPayload(byte* payload, unsigned int length, char* buf, size_t size);
bool ambilNama(const char* topic, const char* awalan, const char* akhiran, char* out, size_t size);
void onMqttMessage(char* topic, byte* payload, unsigned int length);
void kirimAck();
void logHeap();
void onMqttConnected();
void handleMqtt();
void publishSensors();
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
  kirimAck();
  logHeap();
  handleTimeSync();

  unsigned long now = millis();
  if (now - lastSensorMs >= SENSOR_INTERVAL_MS) {
    lastSensorMs = now;
    readSensors();
    logToSd();
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
// RTC & WAKTU
// =====================================================================
void setupRtc() {
  rtcOk = rtc.begin(&Wire);
  if (rtcOk && rtc.lostPower()) rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
  if (rtcOk) {
    Serial.println("DS3231: OK");
  } else {
    Serial.println("DS3231: TIDAK ADA");
  }
}

void handleTimeSync() {
  if (timeSynced || WiFi.status() != WL_CONNECTED) return;
  if (!ntpStarted) {
    configTime(0, 0, "pool.ntp.org", "time.google.com");
    ntpStarted = true;
    return;
  }
  time_t now = time(nullptr);
  if (now < 1700000000) return;
  timeSynced = true;
  if (rtcOk) rtc.adjust(DateTime((uint32_t)(now + GMT_OFFSET_S)));
  Serial.println("Waktu tersinkron NTP");
}

void formatTimestamp(char* buf, size_t len) {
  if (rtcOk) {
    DateTime n = rtc.now();
    snprintf(buf, len, "%04d-%02d-%02d %02d:%02d:%02d", n.year(), n.month(), n.day(), n.hour(), n.minute(), n.second());
  } else {
    snprintf(buf, len, "boot+%lus", millis() / 1000);
  }
}

// =====================================================================
// MICROSD LOG
// =====================================================================
void setupSd() {
  SPI.begin(PIN_SD_SCK, PIN_SD_MISO, PIN_SD_MOSI, PIN_SD_CS);
  sdOk = SD.begin(PIN_SD_CS, SPI, 4000000);
  if (sdOk && !SD.exists(LOG_FILE)) {
    File f = SD.open(LOG_FILE, FILE_WRITE);
    if (f) {
      f.println("waktu,suhu_objek,gerak,speed,lengan,capit");
      f.close();
    } else {
      sdOk = false;
    }
  }
  if (sdOk) {
    Serial.println("microSD: OK");
  } else {
    Serial.println("microSD: TIDAK ADA (lanjut tanpa log)");
  }
}

void logToSd() {
  if (!sdOk) return;
  File f = SD.open(LOG_FILE, FILE_APPEND);
  if (!f) {
    sdOk = false;
    Serial.println("microSD gagal ditulis, log dihentikan");
    return;
  }
  char ts[24];
  formatTimestamp(ts, sizeof(ts));
  f.printf("%s,%.2f,%d,%d,%d,%d\n", ts, suhuObjek, (int)currentMove, currentSpeed, lenganDeg, capitDeg);
  f.close();
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
  }
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

void kirimAck() {
  if (WiFi.status() != WL_CONNECTED || !ubidots->connected()) return;
  int count = 0;
  for (int i = 0; i < ACK_JUMLAH; i++) {
    if (!acks[i].pending) continue;
    ubidots->add(acks[i].ubiVar, acks[i].value);
    acks[i].pending = false;
    count++;
  }
  if (count > 0) ubidots->ubidotsPublish(DEVICE_LABEL);
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
  ubidots->ubidotsPublish(DEVICE_LABEL);
  ubidots->ubidotsSubscribe(DEVICE_LABEL, VAR_GERAK);
  ubidots->ubidotsSubscribe(DEVICE_LABEL, VAR_SPEED);
  ubidots->ubidotsSubscribe(DEVICE_LABEL, VAR_LENGAN);
  ubidots->ubidotsSubscribe(DEVICE_LABEL, VAR_CAPIT);
}

void handleMqtt() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (ubidots->connected()) {
    ubidots->loop();
    return;
  }
  if (millis() - lastMqttAttemptMs < MQTT_RETRY_MS && lastMqttAttemptMs != 0) return;
  lastMqttAttemptMs = millis();
  stopMotors();
  if (ubidots->connect()) onMqttConnected();
  else Serial.println("MQTT gagal, coba lagi...");
}

void publishSensors() {
  if (WiFi.status() != WL_CONNECTED || !ubidots->connected()) return;
  int count = 0;
  if (!isnan(suhuObjek))   { ubidots->add(VAR_SUHU_OBJEK, suhuObjek); count++; }
  if (count > 0) ubidots->ubidotsPublish(DEVICE_LABEL);
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
    if (linkOk) Serial.printf("FAILSAFE: tidak ada heartbeat > %lu ms\n", FAILSAFE_TIMEOUT_MS);
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
