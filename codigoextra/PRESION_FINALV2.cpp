#if defined(ESP32)
  #include <WiFi.h>
  #include <WiFiMulti.h>
  WiFiMulti wifiMulti;
  #define DEVICE "ESP32"
#elif defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266WiFiMulti.h>
  ESP8266WiFiMulti wifiMulti;
  #define DEVICE "ESP8266"
#endif

#include <WiFiClient.h>
#include <PubSubClient.h>

// -------------------- LED --------------------
#define LED_PIN 2
#define LED_ON  LOW

// -------------------- WiFi --------------------
#define WIFI_SSID     "JUNTA DE AGUA"
#define WIFI_PASSWORD "juntadeagua-2325"

// -------------------- MQTT ThingSpeak --------------------
const char* ts_host      = "mqtt3.thingspeak.com";
const int   ts_port      = 1883;
const char* ts_client_id = "Oyk6MgcFHTEdNzMEJQsLEzs";
const char* ts_user      = "Oyk6MgcFHTEdNzMEJQsLEzs";
const char* ts_pass      = "dslPNQ0RZ7JkKh4q+BQO7pLH";
const char* ts_topic     = "channels/2941382/publish/fields/field2";

WiFiClient tsNet;
PubSubClient tsClient(tsNet);

// -------------------- MQTT Local (tu laptop 192.168.1.250) --------------------
const char* local_host  = "192.168.1.250";
const int   local_port  = 1883;

// Topic compatible con tu app: hydromonit/<device>/<metric>
const char* local_topic = "hydromonit/sim-01/presion_psi";

WiFiClient localNet;
PubSubClient localClient(localNet);

String pendienteLocal = "";

// -------------------- Gestión WiFi mejorada --------------------
unsigned long lastWiFiCheck = 0;
const unsigned long wifiCheckInterval = 10000;
bool wifiInitialized = false;

// -------------------- Reset automático por falta de Internet --------------------
unsigned long lastSuccessfulInternet = 0;
unsigned long connectionTimeout = 300000; // 5 min
unsigned long bootTime = 0;
bool hasConnectedOnce = false;

// -------------------- Sensor y calibración --------------------
const int sensorPin = 35;

// Calibración
const float voltage0  = 0.35;  const float pressure0  = 0;
const float voltage1  = 0.47;  const float pressure1  = 16;
const float voltage2  = 0.64;  const float pressure2  = 34;
const float voltage3  = 0.70;  const float pressure3  = 42;
const float voltage4  = 0.82;  const float pressure4  = 60;

// ADC ESP32
const int adcResolution = 4095;
const float adcMaxVoltage = 3.3;

// Filtro promedio
const int numReadings = 10;
int readings[numReadings];
int readIndex = 0;
long total = 0;

// Tiempos
unsigned long lastSampleTime = 0;
unsigned long sampleInterval = 5000;
unsigned long lastPublishTime = 0;
unsigned long publishInterval = 60000;

float currentPressure = 0;
bool systemStabilized = false;
int stabilizationCount = 0;
const int requiredStabilizationSamples = 3;

// -------------------- Utilidades --------------------
static String makeLocalClientId() {
#if defined(ESP32)
  uint64_t mac = ESP.getEfuseMac();
  char buf[40];
  snprintf(buf, sizeof(buf), "ESP32-PSI-%08X%08X",
           (uint32_t)(mac >> 32), (uint32_t)mac);
  return String(buf);
#else
  return String("ESP8266-PSI-") + String(ESP.getChipId());
#endif
}

void ledPulse(int ms = 80) {
  digitalWrite(LED_PIN, LED_ON);
  delay(ms);
  digitalWrite(LED_PIN, !LED_ON);
}

void resetESP32() {
  Serial.println("=== RESET POR SOFTWARE ===");
  Serial.flush();
  delay(800);
  ESP.restart();
}

bool verificarConectividadInternet() {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClient testClient;
  if (testClient.connect("8.8.8.8", 53)) {
    testClient.stop();
    return true;
  }
  return false;
}

void gestionarResetAutomatico() {
  unsigned long now = millis();

  if (verificarConectividadInternet()) {
    lastSuccessfulInternet = now;
    if (!hasConnectedOnce) {
      hasConnectedOnce = true;
      Serial.println("Primera conexión a Internet OK.");
    }
  }

  if (hasConnectedOnce && (now - lastSuccessfulInternet > connectionTimeout)) {
    Serial.println("Sin Internet > 5 min. Reiniciando...");
    resetESP32();
  }

  // diagnóstico simple cada minuto
  if (now - bootTime > 60000 && (now - bootTime) % 60000 < 1000) {
    Serial.println("--- Estado ---");
    Serial.println("Uptime(s): " + String((now - bootTime) / 1000));
    Serial.println("WiFi: " + String(WiFi.status() == WL_CONNECTED ? "OK" : "FAIL"));
    Serial.println("Internet: " + String(verificarConectividadInternet() ? "OK" : "FAIL"));
    Serial.println("-------------");
  }
}

void limpiarConfiguracionWiFi() {
  Serial.println("Limpiando configuración WiFi previa...");
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  delay(1000);
  WiFi.mode(WIFI_STA);
  delay(1000);
}

void wifi_and_connection_init() {
  if (!wifiInitialized) {
    limpiarConfiguracionWiFi();
    wifiInitialized = true;
  }

  WiFi.mode(WIFI_STA);
  wifiMulti.addAP(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Conectando a WiFi");
  int intentos = 0;
  while (wifiMulti.run() != WL_CONNECTED && intentos < 30) {
    Serial.print(".");
    delay(500);
    intentos++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(" conectado.");
    Serial.print("IP asignada: ");
    Serial.println(WiFi.localIP());

    if (verificarConectividadInternet()) {
      lastSuccessfulInternet = millis();
    }
  } else {
    Serial.println(" FALLO en conexión WiFi!");
    wifiInitialized = false;
  }
}

void reconectarWiFi() {
  unsigned long now = millis();

  if ((now - lastWiFiCheck >= wifiCheckInterval) || (WiFi.status() != WL_CONNECTED)) {
    lastWiFiCheck = now;

    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("WiFi desconectado. Intentando reconectar...");
      WiFi.reconnect();
      delay(5000);

      if (WiFi.status() != WL_CONNECTED) {
        Serial.println("Reconexión rápida falló. Reiniciando WiFi completo...");
        wifiInitialized = false;
        wifi_and_connection_init();
      } else {
        if (verificarConectividadInternet()) {
          lastSuccessfulInternet = now;
          Serial.println("Reconectado a Internet.");
        } else {
          Serial.println("WiFi OK pero sin Internet.");
        }
      }
    }
  }
}

// -------------------- MQTT --------------------
void conectarThingSpeakMQTT() {
  tsClient.setServer(ts_host, ts_port);

  int intentos = 0;
  while (!tsClient.connected() && intentos < 5) {
    Serial.print("Conectando a ThingSpeak MQTT...");
    if (tsClient.connect(ts_client_id, ts_user, ts_pass)) {
      Serial.println(" conectado.");
      // prueba rápida
      tsClient.publish(ts_topic, "Iniciando");
    } else {
      intentos++;
      Serial.print(" fallo, rc=");
      Serial.print(tsClient.state());
      Serial.println(" reintentando en 5s");
      delay(5000);
    }
  }
}

void conectarLocalMQTT() {
  localClient.setServer(local_host, local_port);

  String cid = makeLocalClientId();
  int intentos = 0;
  while (!localClient.connected() && intentos < 5) {
    Serial.print("Conectando a MQTT local (192.168.1.250)...");
    // sin user/pass (allow_anonymous true)
    if (localClient.connect(cid.c_str())) {
      Serial.println(" conectado.");
    } else {
      intentos++;
      Serial.print(" fallo, rc=");
      Serial.print(localClient.state());
      Serial.println(" reintentando en 5s");
      delay(5000);
    }
  }
}

// -------------------- Presión --------------------
float calculatePressure(float measuredVoltage) {
  float pressure;

  if (measuredVoltage <= voltage0) {
    pressure = pressure0;
  } else if (measuredVoltage < voltage1) {
    float slope = (pressure1 - pressure0) / (voltage1 - voltage0);
    pressure = pressure0 + (measuredVoltage - voltage0) * slope;
  } else if (measuredVoltage <= voltage2) {
    float slope = (pressure2 - pressure1) / (voltage2 - voltage1);
    pressure = pressure1 + (measuredVoltage - voltage1) * slope;
  } else if (measuredVoltage <= voltage3) {
    float slope = (pressure3 - pressure2) / (voltage3 - voltage2);
    pressure = pressure2 + (measuredVoltage - voltage2) * slope;
  } else {
    float slope = (pressure4 - pressure3) / (voltage4 - voltage3);
    pressure = pressure3 + (measuredVoltage - voltage3) * slope;
  }

  return pressure;
}

// -------------------- Setup --------------------
void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println("\n\n----- INICIANDO SISTEMA -----");
  Serial.println("PSI -> ThingSpeak (field2) + MQTT local 192.168.1.250");

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, !LED_ON);

  bootTime = millis();
  lastSuccessfulInternet = bootTime;

  Serial.println("Iniciando WiFi...");
  wifi_and_connection_init();
  delay(1500);

  Serial.println("Conectando MQTT...");
  conectarThingSpeakMQTT();
  conectarLocalMQTT();

  for (int i = 0; i < numReadings; i++) readings[i] = 0;

  Serial.println("Sistema iniciado. Topic local: " + String(local_topic));
}

// -------------------- Loop --------------------
void loop() {
  unsigned long now = millis();

  gestionarResetAutomatico();
  reconectarWiFi();

  if (WiFi.status() == WL_CONNECTED) {
    if (!tsClient.connected()) conectarThingSpeakMQTT();
    tsClient.loop();

    if (!localClient.connected()) conectarLocalMQTT();
    localClient.loop();

    // Reintento de pendiente local
    if (!pendienteLocal.isEmpty() && localClient.connected()) {
      if (localClient.publish(local_topic, pendienteLocal.c_str())) {
        Serial.println("Pendiente local enviado: " + pendienteLocal);
        ledPulse();
        pendienteLocal = "";
      }
    }
  }

  // muestreo
  if (now - lastSampleTime >= sampleInterval) {
    lastSampleTime = now;

    total -= readings[readIndex];
    readings[readIndex] = analogRead(sensorPin) + 148; // tu offset
    total += readings[readIndex];
    readIndex = (readIndex + 1) % numReadings;

    int averageReading = total / numReadings;
    float measuredVoltage = (float)averageReading * adcMaxVoltage / adcResolution;
    float newPressure = calculatePressure(measuredVoltage);

    Serial.print("ADC: ");
    Serial.print(averageReading);
    Serial.print(" -> ");
    Serial.print(measuredVoltage, 3);
    Serial.print("V -> ");
    Serial.print(newPressure, 1);
    Serial.print(" psi | WiFi: ");
    Serial.println(WiFi.status() == WL_CONNECTED ? "OK" : "FAIL");

    if (!systemStabilized) {
      if (newPressure > 0) {
        stabilizationCount++;
        if (stabilizationCount >= requiredStabilizationSamples) {
          systemStabilized = true;
          Serial.println("Sistema estabilizado!");
        }
      } else {
        stabilizationCount = 0;
      }
    }

    currentPressure = newPressure;
  }

  // publicación cada minuto (si estabilizado y WiFi)
  if (systemStabilized && WiFi.status() == WL_CONNECTED && (now - lastPublishTime >= publishInterval)) {
    lastPublishTime = now;

    String payload = String((int)currentPressure);

    // ThingSpeak (field2)
    bool okTS = false;
    for (int i = 0; i < 3 && !okTS; i++) {
      if (tsClient.connected() && tsClient.publish(ts_topic, payload.c_str())) {
        okTS = true;
        Serial.println("ThingSpeak OK: " + payload);
      } else {
        Serial.println("ThingSpeak publish fallo (" + String(i + 1) + ")");
        delay(1000);
        if (!tsClient.connected()) conectarThingSpeakMQTT();
      }
    }

    // Local (192.168.1.250)
    if (localClient.connected()) {
      if (localClient.publish(local_topic, payload.c_str())) {
        Serial.println("Local MQTT OK (" + String(local_host) + "): " + payload);
        ledPulse();
        pendienteLocal = "";
      } else {
        Serial.println("Local MQTT fallo, guardando: " + payload);
        pendienteLocal = payload;
      }
    } else {
      Serial.println("Local MQTT desconectado, guardando: " + payload);
      pendienteLocal = payload;
    }
  }

  delay(100);
}

