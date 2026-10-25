# Fujitsu Ducted Aircon Wireless Controller & WebApp

A complete local smart thermostat solution for Fujitsu ducted air conditioners utilizing Fujitsu's **polar 3-wire remote controller bus**. Configured as a **Secondary (Slave) Controller**, this bridge works in parallel with your physical wall remote (e.g. **UTY-RVNYM**), keeping the wall remote fully operational while providing real-time local mobile web app control.

---

## Architecture Overview

```
[Fujitsu Ducted AC (3-Wire Bus)]
         │
         │ Terminal 1 (Red: +12V)  ───────────┐
         │ Terminal 2 (White: Signal) ──────┐ │
         │ Terminal 3 (Black: GND) ────┐    │ │
         ▼                             ▼    ▼ ▼
┌─────────────────────────┐         ┌────────────────────────┐
│      ESP32 DevKit       │◄──UART─►│     MCP2021A-330       │
│  (FujiHeatPump/ESPHome) │         │  LIN Transceiver Chip  │
└───────────┬─────────────┘         └────────────────────────┘
            │ WiFi (MQTT)
            ▼
┌────────────────────────────────────────────────────────────┐
│ Portainer / Docker Server (e.g. 192.168.1.100)             │
│                                                            │
│   ├── Mosquitto MQTT Broker (Port 1883 & 9001)             │
│   ├── Mobile WebApp Container (Port 8188 -> 8085)          │
│   └── Matterbridge Container (Port 8283 / Matter UDP 5540) │
└─────────────┬───────────────────────────────┬──────────────┘
              │ HTTP & WebSockets             │ Local Matter (mDNS/UDP)
              ▼                               ▼
 [Mobile Browser / PWA Dial]     [Google Home / Nest Speakers]
```

---

## Hardware Wiring Guide

### Phase 1: USB Bench Testing (Recommended First Step)
During initial setup and testing, **power the ESP32 via USB**. Leave the buck converter aside to ensure zero risk to your microcontroller.

| Fujitsu Bus Terminal | Bus Color | Connection Point |
| :--- | :--- | :--- |
| **Terminal 1** | Red (+12V DC) | Connect **ONLY** to MCP2021A **Pin 7 (`VBB`)** |
| **Terminal 2** | White (Signal) | Connect to MCP2021A **Pin 6 (`LBUS` / `LIN`)** |
| **Terminal 3** | Black (GND) | Connect to **both** MCP2021A **Pin 4 (`VSS`)** AND ESP32 **`GND`** |

### MCP2021A-330 Chip Connections
* **Pin 1 (`TXD`):** Connect to ESP32 **GPIO 17** (TX)
* **Pin 2 (`CS`):** Connect to `VREG` (or ESP32 GPIO to enable)
* **Pin 3 (`NC` / Fault):** Not connected
* **Pin 4 (`VSS` / GND):** Connect to Ground
* **Pin 5 (`NC`):** Not connected
* **Pin 6 (`LBUS`):** Connect to Fujitsu White wire (Terminal 2)
* **Pin 7 (`VBB`):** Connect to Fujitsu Red wire (Terminal 1, +12V)
* **Pin 8 (`VREG`):** Connect a **10µF capacitor** between `VREG` and `GND` (mandatory for regulator stability!)

---

## Portainer Deployment (Local Docker Host)

1. Open your Portainer dashboard (e.g. `https://<YOUR_DOCKER_HOST_IP>:9443` or your configured port).
2. Navigate to **Stacks** -> **Add stack**.
3. Name: `fujitsu-ducted-automation`.
4. Paste the contents of `docker-compose.yml` or connect to this Git repository.
5. Click **Deploy the stack**.
6. Access your dashboards:  
   👉 **Mobile WebApp:** `http://<YOUR_DOCKER_HOST_IP>:8188`  
   👉 **Matterbridge UI:** `http://<YOUR_DOCKER_HOST_IP>:8283`

---

## Google Home Integration (via Local Matter Bridge)

Control your Fujitsu Ducted Aircon directly using **Google Assistant voice commands** and the **Google Home app** without any cloud subscriptions or external webhooks. This setup uses **[Matterbridge](https://github.com/Luligu/matterbridge)** to expose your aircon as a native Matter **Thermostat** on your local network.

### Setup Steps:
1. **Open Matterbridge Web UI**:
   Navigate to `http://<YOUR_DOCKER_HOST_IP>:8283`.
2. **Install the MQTT Plugin**:
   Go to **Plugins** ➡️ search for `matterbridge-mqtt-devices` ➡️ click **Install**.
3. **Configure the Broker**:
   Set the MQTT broker host to `127.0.0.1` (or your Docker host IP) and port `1883`.
4. **Add Thermostat Device**:
   - Device Type: **Thermostat**
   - Device Name: `Fujitsu Ducted Aircon`
   - Map the topics as follows:
     * **Current Temperature**: `fujitsu/climate/fujitsu_ducted_aircon/current_temperature/state`
     * **Target Temperature State**: `fujitsu/climate/fujitsu_ducted_aircon/target_temperature/state`
     * **Target Temperature Set**: `fujitsu/climate/fujitsu_ducted_aircon/target_temperature/command`
     * **System Mode State**: `fujitsu/climate/fujitsu_ducted_aircon/mode/state`
     * **System Mode Set**: `fujitsu/climate/fujitsu_ducted_aircon/mode/command`
     * **Fan Mode State**: `fujitsu/climate/fujitsu_ducted_aircon/fan_mode/state`
     * **Fan Mode Set**: `fujitsu/climate/fujitsu_ducted_aircon/fan_mode/command`
     * **Availability**: `fujitsu/status`
5. **Restart Matterbridge**:
   Click restart in the Matterbridge UI to initialize the Matter accessory.
6. **Pair with Google Home**:
   - Ensure your phone is connected to the same Wi-Fi network as your Google Nest speakers.
   - Open the **Google Home** app.
   - Tap **Devices** ➡️ **+ (Add)** ➡️ **Matter device**.
   - Scan the **Matter QR Code** displayed on the Matterbridge dashboard (or enter the manual pairing code).
   - Assign the thermostat to your desired room (e.g., *Living Room*).

### Example Google Assistant Voice Commands:
* *"Hey Google, set the aircon to 23 degrees"*
* *"Hey Google, make it cooler"* / *"Hey Google, increase temperature by 2 degrees"*
* *"Hey Google, turn on the aircon"* / *"Hey Google, turn off the aircon"*
* *"Hey Google, set aircon to Cool mode"* / *"Hey Google, set aircon to Heat mode"*
* *"Hey Google, what is the temperature in the living room?"*

---

## Mobile Web App Features (PWA)

* **Touch Dial:** Large temperature target dial with 1.0°C step adjustment matching hardware.
* **Ambient Sensor:** Real-time room temperature synchronization.
* **Modes:** Cool ❄️, Heat ☀️, Dry 💧, Fan 🌀, Auto 🔄.
* **Fan Speeds:** Quiet, Low, Med, High, Auto.
* **Quick Presets:** Chill (21°C), Comfort (24°C), Eco (26°C).
* **Live Sync:** Bidirectional WebSocket state updates with optimistic response.
* **Add to Home Screen:** Fully supports iOS / Android PWA installation with custom app icon.
* **Sleep & Recurring Timers:** Built-in sleep countdown and daily on/off automation schedules.

---

## MQTT Topic Reference

| Topic | Payload | Direction | Description |
| :--- | :--- | :--- | :--- |
| `fujitsu/status` | `online` / `offline` | ESP32 -> Broker | ESP32 hardware connection status |
| `fujitsu/climate/fujitsu_ducted_aircon/mode/state` | `off`, `cool`, `heat`, `dry`, `fan_only`, `heat_cool` | ESP32 -> Broker | Active HVAC system mode |
| `fujitsu/climate/fujitsu_ducted_aircon/mode/command` | `off`, `cool`, `heat`, `dry`, `fan_only`, `heat_cool`, `auto` | Matter / WebApp -> ESP32 | Target HVAC mode command |
| `fujitsu/climate/fujitsu_ducted_aircon/current_temperature/state` | Float (e.g. `24.0`) | ESP32 -> Broker | Ambient indoor temperature |
| `fujitsu/climate/fujitsu_ducted_aircon/target_temperature/state` | Int (e.g. `25`) | ESP32 -> Broker | Active setpoint temperature |
| `fujitsu/climate/fujitsu_ducted_aircon/target_temperature/command` | Int (e.g. `24`) | Matter / WebApp -> ESP32 | Target setpoint command |
| `fujitsu/climate/fujitsu_ducted_aircon/fan_mode/state` | `quiet`, `low`, `medium`, `high`, `auto` | ESP32 -> Broker | Active fan speed |
| `fujitsu/climate/fujitsu_ducted_aircon/fan_mode/command` | `quiet`, `low`, `medium`, `high`, `auto` | Matter / WebApp -> ESP32 | Target fan speed command |
| `fujitsu/set/power` | `ON` / `OFF` | External -> WebApp | Universal power toggle |
| `fujitsu/set/target_temp`| Int (e.g. `23`) | External -> WebApp | Universal temperature command |
| `fujitsu/set/mode` | `cool`, `heat`, `dry`, `fan_only`, `auto`, `off` | External -> WebApp | Universal mode command |
