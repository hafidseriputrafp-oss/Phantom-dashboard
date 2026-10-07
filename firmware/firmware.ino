/*
 * PHANTOM — rescue robot GARUDA Operation
 * Board  : ESP32 DevKit V1 (30-pin)
 * Library: Ubidots MQTT for ESP32 and ESP8266 (UbidotsESPMQTT.h) + PubSubClient,
 *          WiFiManager (tzapu), ESP32Servo, Adafruit MLX90614, Adafruit SSD1306 + GFX,
 *          RTClib (Adafruit), SD/SPI/Wire (bawaan core ESP32)
 */

#include <Wire.h>
#include <SPI.h>
#include <SD.h>
#include <time.h>
#include <WiFi.h>
#include <WiFiManager.h>
#include <UbidotsESPMQTT.h>
#include <ESP32Servo.h>
#include <Adafruit_MLX90614.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <RTClib.h>

// ---------- PIN ----------
#define PIN_I2C_SDA        21   // MLX90614 (0x5A), SSD1306 (0x3C), DS3231 (0x68, EEPROM 0x57)
#define PIN_I2C_SCL        22
#define PIN_SD_SCK         18   // VSPI
#define PIN_SD_MISO        19
#define PIN_SD_MOSI        23
#define PIN_SD_CS          5
#define PIN_MOTOR_ENA      32   // L298N ENA -> PWM roda kiri (2 motor paralel)
#define PIN_MOTOR_IN1      33
#define PIN_MOTOR_IN2      25
#define PIN_MOTOR_IN3      26
#define PIN_MOTOR_IN4      27
#define PIN_MOTOR_ENB      13   // L298N ENB -> PWM roda kanan (2 motor paralel)
#define PIN_SERVO_LENGAN   16
#define PIN_SERVO_CAPIT    17
#define PIN_BATT_MOTOR     34   // ADC1 (ADC2 tidak bisa dipakai saat WiFi aktif)
#define PIN_BATT_SERVO     35
#define PIN_WIFI_RESET     14   // tombol ke GND; isi 0 untuk memakai tombol BOOT onboard

// ---------- KREDENSIAL (placeholder) ----------
char UBIDOTS_TOKEN[] = "BBUS-GANTI_DENGAN_TOKEN_UBIDOTS";
char DEVICE_LABEL[]  = "phantom";
const char* WIFI_SSID_DEFAULT = "";   // opsional; kosongkan = atur lewat Phantom-Setup
const char* WIFI_PASS_DEFAULT = "";
const char* AP_NAME = "Phantom-Setup";
const char* AP_PASS = "phantom123";

// ---------- VARIABEL UBIDOTS ----------
char VAR_GERAK[]        = "gerak";
char VAR_SPEED[]        = "speed";
char VAR_LENGAN[]       = "lengan";
char VAR_CAPIT[]        = "capit";
char VAR_SUHU_OBJEK[]   = "suhu_objek";
char VAR_SUHU_AMBIENT[] = "suhu_ambient";
char VAR_BATT_MOTOR[]   = "batt_motor";
char VAR_BATT_SERVO[]   = "batt_servo";

// ---------- PARAMETER ----------
const unsigned long PUBLISH_INTERVAL_MS  = 5000;   // kirim sensor ke Ubidots (hemat kuota STEM)
const unsigned long SENSOR_INTERVAL_MS   = 1000;   // baca sensor, OLED & log microSD
const unsigned long HEARTBEAT_MS         = 1500;   // dashboard mengirim ulang "gerak" tiap 1,5 dtk saat tombol ditahan
const unsigned long FAILSAFE_TIMEOUT_MS  = HEARTBEAT_MS + 1000;   // toleransi jeda jaringan
const unsigned long OLED_INTERVAL_MS     = 500;
const unsigned long MQTT_RETRY_MS        = 3000;
const unsigned long RESET_HOLD_MS        = 3000;
const uint16_t      WIFI_CONNECT_TIMEOUT_S = 15;
const uint16_t      PORTAL_TIMEOUT_S     = 180;
const long          GMT_OFFSET_S         = 7 * 3600;   // WIB
const char*         LOG_FILE             = "/phantom_log.csv";

const uint32_t MOTOR_PWM_FREQ   = 1000;
const uint8_t  MOTOR_PWM_BITS   = 8;
const bool     MOTOR_KIRI_BALIK  = false;   // ubah jika arah roda kiri terbalik
const bool     MOTOR_KANAN_BALIK = false;
const uint8_t  SPEED_DEFAULT    = 180;

const int LENGAN_MIN = 0, LENGAN_MAX = 180, LENGAN_AWAL = 90;
const int CAPIT_BUKA_DEG = 90, CAPIT_TUTUP_DEG = 20;
const int SERVO_MIN_US = 500, SERVO_MAX_US = 2400;

// pembagi tegangan: Vbat -> R1 -> ADC -> R2 -> GND
const float BATT_MOTOR_R1 = 30000.0, BATT_MOTOR_R2 = 7500.0;
const float BATT_SERVO_R1 = 30000.0, BATT_SERVO_R2 = 7500.0;
const float BATT_CAL      = 1.00;   // koreksi hasil ukur multimeter

// ---------- OBJEK ----------
enum Move { MOVE_STOP = 0, MOVE_MAJU = 1, MOVE_MUNDUR = 2, MOVE_KIRI = 3, MOVE_KANAN = 4 };
const char* MOVE_NAMES[] = { "STOP", "MAJU", "MUNDUR", "KIRI", "KANAN" };

Ubidots ubidots(UBIDOTS_TOKEN);
WiFiManager wm;
Adafruit_MLX90614 mlx;
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
RTC_DS3231 rtc;
Servo servoLengan, servoCapit;
ESP32PWM pwmKiri, pwmKanan;

// ---------- STATUS ----------
Move currentMove = MOVE_STOP;
uint8_t currentSpeed = SPEED_DEFAULT;
unsigned long lastCommandMs = 0;

float suhuObjek = NAN, suhuAmbient = NAN, battMotor = NAN, battServo = NAN;

bool mlxOk = false, oledOk = false, rtcOk = false, sdOk = false;
bool wifiWasConnected = false, portalWasActive = false, timeSynced = false, ntpStarted = false;
unsigned long wifiLostSince = 0, lastMqttAttemptMs = 0, lastSensorMs = 0, lastPublishMs = 0, lastOledMs = 0, lastMlxRetryMs = 0;

// =====================================================================
// MOTOR
// =====================================================================
void setMotor(ESP32PWM& pwm, uint8_t pinA, uint8_t pinB, int dir, uint8_t speed, bool invert) {
  if (invert) dir = -dir;
  digitalWrite(pinA, dir > 0 ? HIGH : LOW);
  digitalWrite(pinB, dir < 0 ? HIGH : LOW);
  pwm.write(dir == 0 ? 0 : speed);
}

void driveMotors(int kiri, int kanan) {
  setMotor(pwmKiri, PIN_MOTOR_IN1, PIN_MOTOR_IN2, kiri, currentSpeed, MOTOR_KIRI_BALIK);
  setMotor(pwmKanan, PIN_MOTOR_IN3, PIN_MOTOR_IN4, kanan, currentSpeed, MOTOR_KANAN_BALIK);
}

void applyMove(Move m) {
  currentMove = m;
  switch (m) {
    case MOVE_MAJU:   driveMotors(1, 1);   break;
    case MOVE_MUNDUR: driveMotors(-1, -1); break;
    case MOVE_KIRI:   driveMotors(-1, 1);  break;
    case MOVE_KANAN:  driveMotors(1, -1);  break;
    default:          driveMotors(0, 0);   currentMove = MOVE_STOP; break;
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
  servoLengan.write(constrain(deg, LENGAN_MIN, LENGAN_MAX));
}

void setCapit(bool buka) {
  servoCapit.write(buka ? CAPIT_BUKA_DEG : CAPIT_TUTUP_DEG);
}

void setupServos() {
  servoLengan.setPeriodHertz(50);
  servoCapit.setPeriodHertz(50);
  servoLengan.attach(PIN_SERVO_LENGAN, SERVO_MIN_US, SERVO_MAX_US);
  servoCapit.attach(PIN_SERVO_CAPIT, SERVO_MIN_US, SERVO_MAX_US);
  setLengan(LENGAN_AWAL);
  setCapit(false);
}

// =====================================================================
// SENSOR
// =====================================================================
float readBattery(uint8_t pin, float r1, float r2) {
  uint32_t mv = 0;
  for (int i = 0; i < 16; i++) mv += analogReadMilliVolts(pin);
  return (mv / 16.0f) / 1000.0f * ((r1 + r2) / r2) * BATT_CAL;
}

void readSensors() {
  if (!mlxOk && millis() - lastMlxRetryMs > 5000) {
    lastMlxRetryMs = millis();
    mlxOk = mlx.begin(MLX90614_I2CADDR, &Wire);
  }
  suhuObjek = mlxOk ? mlx.readObjectTempC() : NAN;
  suhuAmbient = mlxOk ? mlx.readAmbientTempC() : NAN;
  battMotor = readBattery(PIN_BATT_MOTOR, BATT_MOTOR_R1, BATT_MOTOR_R2);
  battServo = readBattery(PIN_BATT_SERVO, BATT_SERVO_R1, BATT_SERVO_R2);
}

void setupSensors() {
  analogReadResolution(12);
  mlxOk = mlx.begin(MLX90614_I2CADDR, &Wire);
  Serial.printf("MLX90614: %s\n", mlxOk ? "OK" : "TIDAK ADA");
}

// =====================================================================
// RTC & WAKTU
// =====================================================================
void setupRtc() {
  rtcOk = rtc.begin(&Wire);
  if (rtcOk && rtc.lostPower()) rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
  Serial.printf("DS3231: %s\n", rtcOk ? "OK" : "TIDAK ADA");
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
// SD CARD LOG
// =====================================================================
void setupSd() {
  SPI.begin(PIN_SD_SCK, PIN_SD_MISO, PIN_SD_MOSI, PIN_SD_CS);
  sdOk = SD.begin(PIN_SD_CS, SPI, 4000000);
  if (sdOk && !SD.exists(LOG_FILE)) {
    File f = SD.open(LOG_FILE, FILE_WRITE);
    if (f) {
      f.println("waktu,suhu_objek,suhu_ambient,batt_motor,batt_servo,gerak");
      f.close();
    } else {
      sdOk = false;
    }
  }
  Serial.printf("microSD: %s\n", sdOk ? "OK" : "TIDAK ADA (lanjut tanpa log)");
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
  f.printf("%s,%.2f,%.2f,%.2f,%.2f,%d\n", ts, suhuObjek, suhuAmbient, battMotor, battServo, (int)currentMove);
  f.close();
}

// =====================================================================
// OLED
// =====================================================================
void showMessage(const char* line1, const char* line2) {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setCursor(0, 0);
  oled.setTextSize(2);
  oled.println(line1);
  oled.setTextSize(1);
  oled.println();
  oled.println(line2);
  oled.display();
}

void setupOled() {
  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  if (!oledOk) {
    Serial.println("SSD1306: TIDAK ADA");
    return;
  }
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  showMessage("PHANTOM", "Booting...");
}

void printValue(const char* label, float v, const char* unit) {
  oled.print(label);
  if (isnan(v)) oled.print("--");
  else oled.print(v, unit[0] == 'V' ? 2 : 1);
  oled.print(unit);
}

void updateOled() {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextSize(1);
  oled.setCursor(0, 0);

  if (wm.getConfigPortalActive()) {
    oled.println("== MODE SETUP WIFI ==");
    oled.println();
    oled.println("Sambung ke WiFi:");
    oled.print("AP  : "); oled.println(AP_NAME);
    oled.print("Pass: "); oled.println(AP_PASS);
    oled.println();
    oled.println("Buka 192.168.4.1");
    oled.display();
    return;
  }

  bool wifiOk = WiFi.status() == WL_CONNECTED;
  oled.print("PHANTOM ");
  oled.println(wifiOk ? (ubidots.connected() ? "ONLINE" : "WiFi OK") : "NO WIFI");
  if (wifiOk) oled.println(WiFi.localIP());
  else oled.println("menghubungkan...");
  printValue("Obj:", suhuObjek, "C ");
  printValue("Amb:", suhuAmbient, "C");
  oled.println();
  printValue("Bat motor: ", battMotor, "V");
  oled.println();
  printValue("Bat servo: ", battServo, "V");
  oled.println();
  oled.print("Gerak: ");
  oled.print(MOVE_NAMES[currentMove]);
  oled.print(" spd ");
  oled.println(currentSpeed);
  char ts[24];
  formatTimestamp(ts, sizeof(ts));
  oled.print(ts + (rtcOk ? 11 : 0));
  oled.print(sdOk ? " SD" : " noSD");
  oled.display();
}

// =====================================================================
// WIFI (WiFiManager)
// =====================================================================
void startPortal() {
  stopMotors();
  if (ubidots.connected()) ubidots.disconnect();
  Serial.printf("Membuka AP %s\n", AP_NAME);
  wm.startConfigPortal(AP_NAME, AP_PASS);
  updateOled();
}

void setupWiFi() {
  WiFi.mode(WIFI_STA);
  wm.setConfigPortalBlocking(false);
  wm.setConnectTimeout(WIFI_CONNECT_TIMEOUT_S);
  wm.setConfigPortalTimeout(PORTAL_TIMEOUT_S);
  wm.setTitle("Phantom Setup");
  if (!wm.getWiFiIsSaved() && strlen(WIFI_SSID_DEFAULT) > 0) {
    WiFi.begin(WIFI_SSID_DEFAULT, WIFI_PASS_DEFAULT);
  }
  showMessage("WiFi", "Menghubungkan...");
  if (!wm.autoConnect(AP_NAME, AP_PASS)) Serial.println("Mode setup WiFi aktif");
  wifiLostSince = millis();
}

void onWiFiConnected() {
  Serial.print("WiFi terhubung, IP: ");
  Serial.println(WiFi.localIP());
  if (wm.getConfigPortalActive()) wm.stopConfigPortal();
  lastMqttAttemptMs = 0;
}

void handleWiFi() {
  bool portalActive = wm.getConfigPortalActive();
  if (portalActive) wm.process();

  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasConnected) onWiFiConnected();
    wifiWasConnected = true;
    wifiLostSince = 0;
    portalWasActive = wm.getConfigPortalActive();
    return;
  }

  if (wifiWasConnected) {
    Serial.println("WiFi terputus");
    stopMotors();
  }
  wifiWasConnected = false;
  if (wifiLostSince == 0) wifiLostSince = millis();

  if (portalWasActive && !portalActive) {
    WiFi.begin();
    wifiLostSince = millis();
  }
  portalWasActive = portalActive;

  if (!portalActive && millis() - wifiLostSince > WIFI_CONNECT_TIMEOUT_S * 1000UL) {
    startPortal();
    portalWasActive = true;
  }
}

void resetWiFi() {
  stopMotors();
  Serial.println("Tombol ditahan: hapus WiFi tersimpan");
  showMessage("RESET", "WiFi dihapus...");
  if (ubidots.connected()) ubidots.disconnect();
  if (wm.getConfigPortalActive()) wm.stopConfigPortal();
  wm.resetSettings();
  wifiWasConnected = false;
  startPortal();
  portalWasActive = true;
}

void handleResetButton() {
  static unsigned long pressedAt = 0;
  static bool fired = false;
  if (digitalRead(PIN_WIFI_RESET) == LOW) {
    if (pressedAt == 0) pressedAt = millis();
    if (!fired && millis() - pressedAt >= RESET_HOLD_MS) {
      fired = true;
      resetWiFi();
    }
  } else {
    pressedAt = 0;
    fired = false;
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
  unsigned int n = length < sizeof(buf) - 1 ? length : sizeof(buf) - 1;
  memcpy(buf, payload, n);
  buf[n] = '\0';
  int value = (int)lroundf(atof(buf));

  if (topicIs(topic, VAR_GERAK)) {
    lastCommandMs = millis();
    applyMove((value >= MOVE_STOP && value <= MOVE_KANAN) ? (Move)value : MOVE_STOP);
  } else if (topicIs(topic, VAR_SPEED)) {
    currentSpeed = constrain(value, 0, 255);
    applyMove(currentMove);
  } else if (topicIs(topic, VAR_LENGAN)) {
    setLengan(value);
  } else if (topicIs(topic, VAR_CAPIT)) {
    setCapit(value == 1);
  }
  Serial.printf("RX %s = %d\n", topic, value);
}

void onMqttConnected() {
  Serial.println("MQTT Ubidots terhubung");
  ubidots.add(VAR_GERAK, 0);
  ubidots.ubidotsPublish(DEVICE_LABEL);
  ubidots.ubidotsSubscribe(DEVICE_LABEL, VAR_GERAK);
  ubidots.ubidotsSubscribe(DEVICE_LABEL, VAR_SPEED);
  ubidots.ubidotsSubscribe(DEVICE_LABEL, VAR_LENGAN);
  ubidots.ubidotsSubscribe(DEVICE_LABEL, VAR_CAPIT);
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
  ubidots.add(VAR_BATT_MOTOR, battMotor); count++;
  ubidots.add(VAR_BATT_SERVO, battServo); count++;
  if (count > 0) ubidots.ubidotsPublish(DEVICE_LABEL);
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
  pinMode(PIN_WIFI_RESET, INPUT_PULLUP);

  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  setupMotors();
  setupServos();

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  Wire.setClock(100000);
  setupOled();
  setupSensors();
  setupRtc();
  setupSd();

  setupWiFi();
  ubidots.begin(onMqttMessage);
}

void loop() {
  handleResetButton();
  handleWiFi();
  handleMqtt();
  handleFailsafe();
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
  if (now - lastOledMs >= OLED_INTERVAL_MS) {
    lastOledMs = now;
    updateOled();
  }
}
