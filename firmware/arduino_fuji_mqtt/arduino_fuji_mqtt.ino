/**
 * Fujitsu Ducted Aircon Wireless Controller
 * Firmware: Arduino C++ / PlatformIO
 * Hardware: ESP32 DevKitC (38-pin) + MCP2021A-330 LIN Transceiver
 * Bus: Fujitsu Polar 3-Wire Bus (Terminal 1: 12V, Terminal 2: Signal, Terminal 3: GND)
 * Role: Secondary Controller (Works seamlessly with physical UTY-RVNYM wall remote)
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <FujiHeatPump.h>

// Wi-Fi Settings
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

// MQTT Broker Settings (Your local Docker server)
const char* MQTT_SERVER = "192.168.1.25";
const int   MQTT_PORT   = 1883;
const char* MQTT_CLIENT_ID = "esp32-fujitsu-ac";

// GPIO Pin Definitions
// ESP32 Hardware Serial 2 (connected to MCP2021A TXD / RXD)
#define FUJI_RX_PIN 16
#define FUJI_TX_PIN 17

WiFiClient espClient;
PubSubClient mqttClient(espClient);
FujiHeatPump hp;

// Track last state to avoid redundant publications
bool lastOnOff = false;
byte lastMode = 0;
byte lastFanMode = 0;
byte lastTemp = 24;
float lastRoomTemp = 0.0;
unsigned long lastStatusPublish = 0;

void setupWiFi() {
  delay(10);
  Serial.println();
  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  int retries = 0;
  while (WiFi.status() != WL_CONNECTED && retries < 30) {
    delay(500);
    Serial.print(".");
    retries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected! IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\nWiFi connection failed! Continuing in offline mode...");
  }
}

void mqttCallback(char* topic, byte* message, unsigned int length) {
  String topicStr = String(topic);
  String payload = "";
  for (unsigned int i = 0; i < length; i++) {
    payload += (char)message[i];
  }
  payload.trim();

  Serial.println("MQTT Message [" + topicStr + "] -> " + payload);

  if (topicStr.endsWith("/set/power")) {
    bool on = (payload.equalsIgnoreCase("ON") || payload == "1");
    hp.setOnOff(on);
    Serial.println("Action: Set Power -> " + String(on ? "ON" : "OFF"));
  }
  else if (topicStr.endsWith("/set/target_temp")) {
    int targetTemp = payload.toInt();
    if (targetTemp >= 16 && targetTemp <= 30) {
      hp.setTemp(targetTemp);
      Serial.println("Action: Set Target Temp -> " + String(targetTemp));
    }
  }
  else if (topicStr.endsWith("/set/mode")) {
    if (payload.equalsIgnoreCase("cool")) hp.setMode(fujiModeCool);
    else if (payload.equalsIgnoreCase("heat")) hp.setMode(fujiModeHeat);
    else if (payload.equalsIgnoreCase("dry")) hp.setMode(fujiModeDry);
    else if (payload.equalsIgnoreCase("fan_only") || payload.equalsIgnoreCase("fan")) hp.setMode(fujiModeFan);
    else if (payload.equalsIgnoreCase("auto")) hp.setMode(fujiModeAuto);
    Serial.println("Action: Set Mode -> " + payload);
  }
  else if (topicStr.endsWith("/set/fan_mode")) {
    if (payload.equalsIgnoreCase("quiet")) hp.setFanMode(fujiFanQuiet);
    else if (payload.equalsIgnoreCase("low")) hp.setFanMode(fujiFanLow);
    else if (payload.equalsIgnoreCase("medium") || payload.equalsIgnoreCase("med")) hp.setFanMode(fujiFanMed);
    else if (payload.equalsIgnoreCase("high")) hp.setFanMode(fujiFanHigh);
    else if (payload.equalsIgnoreCase("auto")) hp.setFanMode(fujiFanAuto);
    Serial.println("Action: Set Fan -> " + payload);
  }
}

void reconnectMQTT() {
  if (mqttClient.connected()) return;

  Serial.print("Connecting to MQTT at " + String(MQTT_SERVER) + "...");
  // Connect with LWT (Last Will and Testament)
  if (mqttClient.connect(MQTT_CLIENT_ID, "fujitsu/status", 1, true, "offline")) {
    Serial.println(" Connected!");
    mqttClient.publish("fujitsu/status", "online", true);

    // Subscribe to all control topics
    mqttClient.subscribe("fujitsu/set/#");
  } else {
    Serial.print(" Failed, rc=");
    Serial.println(mqttClient.state());
  }
}

void publishState() {
  bool onOff = hp.getOnOff();
  byte mode = hp.getMode();
  byte fan = hp.getFanMode();
  byte temp = hp.getTemp();
  float roomTemp = hp.getRoomTemp();

  String modeStr = "cool";
  if (mode == fujiModeHeat) modeStr = "heat";
  else if (mode == fujiModeDry) modeStr = "dry";
  else if (mode == fujiModeFan) modeStr = "fan_only";
  else if (mode == fujiModeAuto) modeStr = "auto";

  String fanStr = "auto";
  if (fan == fujiFanQuiet) fanStr = "quiet";
  else if (fan == fujiFanLow) fanStr = "low";
  else if (fan == fujiFanMed) fanStr = "medium";
  else if (fan == fujiFanHigh) fanStr = "high";

  // Build JSON payload
  String json = "{";
  json += "\"power\":\"" + String(onOff ? "ON" : "OFF") + "\",";
  json += "\"mode\":\"" + modeStr + "\",";
  json += "\"target_temperature\":" + String(temp) + ",";
  json += "\"current_temperature\":" + String(roomTemp, 1) + ",";
  json += "\"fan_mode\":\"" + fanStr + "\",";
  json += "\"controller_role\":\"secondary\",";
  json += "\"device_online\":true";
  json += "}";

  mqttClient.publish("fujitsu/state", json.c_str(), true);
  mqttClient.publish("fujitsu/power", onOff ? "ON" : "OFF", true);
  mqttClient.publish("fujitsu/mode", modeStr.c_str(), true);
  mqttClient.publish("fujitsu/target_temp", String(temp).c_str(), true);
  mqttClient.publish("fujitsu/current_temp", String(roomTemp, 1).c_str(), true);
  mqttClient.publish("fujitsu/fan_mode", fanStr.c_str(), true);

  lastOnOff = onOff;
  lastMode = mode;
  lastFanMode = fan;
  lastTemp = temp;
  lastRoomTemp = roomTemp;
  lastStatusPublish = millis();
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n=== Fujitsu Ducted AC Wireless Controller Initializing ===");

  setupWiFi();

  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);

  // Initialize FujiHeatPump as Secondary (Slave) controller
  // Second parameter 'true' sets secondary mode so it works alongside the wall controller
  Serial.println("Initializing Fujitsu bus connection on UART (RX=16, TX=17)...");
  hp.connect(&Serial2, true, FUJI_RX_PIN, FUJI_TX_PIN);

  Serial.println("Setup complete! Listening for Fujitsu 3-wire bus packets...");
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!mqttClient.connected()) {
      static unsigned long lastMqttRetry = 0;
      if (millis() - lastMqttRetry > 5000) {
        lastMqttRetry = millis();
        reconnectMQTT();
      }
    } else {
      mqttClient.loop();
    }
  }

  // Update AC communication state machine
  if (hp.update()) {
    // If state changed or periodic 30-second heartbeat
    bool stateChanged = (hp.getOnOff() != lastOnOff ||
                         hp.getMode() != lastMode ||
                         hp.getFanMode() != lastFanMode ||
                         hp.getTemp() != lastTemp ||
                         abs(hp.getRoomTemp() - lastRoomTemp) >= 0.2);

    if (stateChanged || (millis() - lastStatusPublish > 30000)) {
      if (mqttClient.connected()) {
        publishState();
      }
    }
  }
}
