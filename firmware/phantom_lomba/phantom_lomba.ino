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
#include <time.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
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

// ---------- VARIABEL UBIDOTS ----------
char VAR_GERAK[]        = "gerak";
char VAR_SPEED[]        = "speed";
char VAR_LENGAN[]       = "lengan";
char VAR_CAPIT[]        = "capit";
char VAR_SUHU_OBJEK[]   = "suhu_objek";
char VAR_SUHU_AMBIENT[] = "suhu_ambient";
char VAR_BATAS_SUHU[]   = "batas_suhu";
char VAR_KIRIM_HOTSPOT[] = "kirim_hotspot";
char VAR_HOTSPOT[]      = "hotspot";
char VAR_FB_CODE[]      = "fb_code";
char VAR_FB_JENIS[]     = "fb_jenis";
char VAR_FB_SUHU[]      = "fb_suhu";

// ---------- PARAMETER ----------
const unsigned long PUBLISH_INTERVAL_MS = 5000;   // kirim suhu ke Ubidots
const unsigned long SENSOR_INTERVAL_MS  = 1000;   // baca sensor & log microSD
const unsigned long HEARTBEAT_MS        = 1500;   // dashboard kirim ulang "gerak" tiap 1,5 dtk saat ditahan
const unsigned long FAILSAFE_TIMEOUT_MS = HEARTBEAT_MS + 1500;   // toleransi antrean request + jaringan
const unsigned long MQTT_RETRY_MS       = 3000;
const unsigned long WIFI_RETRY_MS       = 10000;
const long          GMT_OFFSET_S        = 7 * 3600;   // WIB
const char*         LOG_FILE            = "/phantom_lomba.csv";

const unsigned long FIREBASE_DATA_MS    = 5000;   // kirim {"suhu":..,"wifi":true} ke web dosen
const unsigned long HOTSPOT_RETRY_MS    = 5000;   // jeda coba ulang hotspot bila gagal
const uint16_t      FIREBASE_TIMEOUT_MS = 4000;
const float         BATAS_SUHU_DEFAULT  = 50.0;   // bisa diubah dari dashboard (batas_suhu)
const int           FB_DITOLAK          = -3;     // kode untuk dashboard: suhu di bawah batas

const uint32_t MOTOR_PWM_FREQ    = 1000;
const uint8_t  MOTOR_PWM_BITS    = 8;
const bool     MOTOR_KIRI_BALIK  = false;   // ubah jika arah roda kiri terbalik
const bool     MOTOR_KANAN_BALIK = false;
const uint8_t  SPEED_DEFAULT     = 150;
const float    CURVE_RATIO       = 0.4;     // kecepatan roda sisi dalam saat belok melengkung

const int SERVO_MIN_DEG = 0, SERVO_MAX_DEG = 180;
const int LENGAN_AWAL = 135, CAPIT_AWAL = 90;   // PARKIR & TUTUP di dashboard
const int SERVO_MIN_US = 500, SERVO_MAX_US = 2400;

// ---------- OBJEK ----------
enum Move {
  MOVE_STOP = 0, MOVE_MAJU = 1, MOVE_MUNDUR = 2, MOVE_KIRI = 3, MOVE_KANAN = 4,
  MOVE_MAJU_KIRI = 5, MOVE_MAJU_KANAN = 6, MOVE_MUNDUR_KIRI = 7, MOVE_MUNDUR_KANAN = 8,
};
const char* MOVE_NAMES[] = { "STOP", "MAJU", "MUNDUR", "PUTAR KIRI", "PUTAR KANAN", "MAJU-KIRI", "MAJU-KANAN", "MUNDUR-KIRI", "MUNDUR-KANAN" };

Ubidots ubidots(UBIDOTS_TOKEN);
Adafruit_MLX90614 mlx;
RTC_DS3231 rtc;
Servo servoLengan, servoCapit;
ESP32PWM pwmKiri, pwmKanan;

// ---------- STATUS ----------
Move currentMove = MOVE_STOP;
uint8_t currentSpeed = SPEED_DEFAULT;
int lenganDeg = LENGAN_AWAL, capitDeg = CAPIT_AWAL;
unsigned long lastCommandMs = 0;
float suhuObjek = NAN, suhuAmbient = NAN;
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
bool wifiWasConnected = false, timeSynced = false, ntpStarted = false;
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
  lenganDeg = constrain(deg, SERVO_MIN_DEG, SERVO_MAX_DEG);
  servoLengan.write(lenganDeg);
}

void setCapit(int deg) {
  capitDeg = constrain(deg, SERVO_MIN_DEG, SERVO_MAX_DEG);
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
    suhuAmbient = mlx.readAmbientTempC();
  } else {
    suhuObjek = NAN;
    suhuAmbient = NAN;
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
      f.println("waktu,suhu_objek,suhu_ambient,gerak,speed,lengan,capit,fb_code");
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
  f.printf("%s,%.2f,%.2f,%d,%d,%d,%d,%d\n", ts, suhuObjek, suhuAmbient, (int)currentMove, currentSpeed, lenganDeg, capitDeg, lastFbCode);
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
bool topicIs(const char* topic, const char* variable) {
  char suffix[40];
  snprintf(suffix, sizeof(suffix), "/%s/lv", variable);
  return strstr(topic, suffix) != nullptr;
}

void onMqttMessage(char* topic, byte* payload, unsigned int length) {
  char buf[16];
  unsigned int n;
  if (length < sizeof(buf) - 1) {
    n = length;
  } else {
    n = sizeof(buf) - 1;
  }
  memcpy(buf, payload, n);
  buf[n] = '\0';
  int value = (int)lroundf(atof(buf));

  if (topicIs(topic, VAR_GERAK)) {
    lastCommandMs = millis();
    if (value >= MOVE_STOP && value <= MOVE_MUNDUR_KANAN) {
      applyMove((Move)value);
    } else {
      applyMove(MOVE_STOP);
    }
  } else if (topicIs(topic, VAR_SPEED)) {
    currentSpeed = constrain(value, 0, 255);
    applyMove(currentMove);
  } else if (topicIs(topic, VAR_LENGAN)) {
    setLengan(value);
  } else if (topicIs(topic, VAR_CAPIT)) {
    setCapit(value);
  } else if (topicIs(topic, VAR_BATAS_SUHU)) {
    float b = atof(buf);
    if (b > 0) batasSuhu = b;
  } else if (topicIs(topic, VAR_KIRIM_HOTSPOT)) {
    if (value == 1) requestHotspot(true);
  }
  Serial.printf("RX %s = %d\n", topic, value);
}

void onMqttConnected() {
  Serial.println("MQTT Ubidots terhubung");
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
  stopMotors();
  if (ubidots.connect()) onMqttConnected();
  else Serial.println("MQTT gagal, coba lagi...");
}

void publishSensors() {
  if (WiFi.status() != WL_CONNECTED || !ubidots.connected()) return;
  int count = 0;
  if (!isnan(suhuObjek))   { ubidots.add(VAR_SUHU_OBJEK, suhuObjek); count++; }
  if (!isnan(suhuAmbient)) { ubidots.add(VAR_SUHU_AMBIENT, suhuAmbient); count++; }
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

void firebaseTask(void*) {
  for (;;) {
    if (WiFi.status() == WL_CONNECTED && (wantHotspot || wantData)) {
      FbResult r;
      String body;
      if (wantHotspot) {
        wantHotspot = false;
        r.jenis = FB_HOTSPOT;
        body = "{\"hotspot\":true}";
      } else {
        wantData = false;
        r.jenis = FB_DATA;
        body = String("{\"suhu\":") + String(pendingSuhu, 1) + ",\"wifi\":true}";
      }
      r.suhu = pendingSuhu;
      r.code = firebasePatch(body);
      xQueueSend(fbResults, &r, 0);
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
  bool linkOk = WiFi.status() == WL_CONNECTED && ubidots.connected();
  if (!linkOk || millis() - lastCommandMs > FAILSAFE_TIMEOUT_MS) {
    stopMotors();
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

  fbResults = xQueueCreate(4, sizeof(FbResult));
  xTaskCreatePinnedToCore(firebaseTask, "firebase", 12288, nullptr, 1, nullptr, 0);
}

void loop() {
  handleWiFi();
  handleMqtt();
  handleFailsafe();
  handleTimeSync();
  handleFirebase();

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
