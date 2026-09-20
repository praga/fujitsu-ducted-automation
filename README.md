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
│ Portainer / Docker Server (192.168.1.25)                   │
│                                                            │
│   ├── Mosquitto MQTT Broker (Port 1883 & 9001)             │
│   └── Mobile WebApp Container (Port 8188 -> 8085)          │
└───────────────────────────┬────────────────────────────────┘
                            │ HTTP & WebSockets
                            ▼
           [Mobile Phone / Tablet Browser (PWA)]
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

## Portainer Deployment (Local Server `192.168.1.25`)

1. Open Portainer at `https://192.168.1.25:31015`.
2. Navigate to **Stacks** -> **Add stack**.
3. Name: `fujitsu-ducted-automation`.
4. Paste the contents of `docker-compose.yml` or connect to this Git repository.
5. Click **Deploy the stack**.
6. Access your mobile dashboard at:  
   👉 **`http://192.168.1.25:8188`**

---

## Mobile Web App Features (PWA)

* **Touch Dial:** Large temperature target dial with 0.5°C step adjustment.
* **Ambient Sensor:** Real-time room temperature synchronization.
* **Modes:** Cool ❄️, Heat ☀️, Dry 💧, Fan 🌀, Auto 🔄.
* **Fan Speeds:** Quiet, Low, Med, High, Auto.
* **Quick Presets:** Chill (21°C), Comfort (24°C), Eco (26°C).
* **Live Sync:** Bidirectional WebSocket state updates with optimistic response.
* **Add to Home Screen:** Fully supports iOS / Android PWA installation with custom app icon.
* **Mock Simulator Engine:** Allows immediate interactive UI testing before physical hardware is connected.

---

## MQTT Topic Reference

| Topic | Payload | Direction |
| :--- | :--- | :--- |
| `fujitsu/status` | `online` / `offline` | Device -> Broker |
| `fujitsu/state` | Full JSON state object | Device -> Broker |
| `fujitsu/current_temp` | Float string (e.g. `24.5`) | Device -> Broker |
| `fujitsu/set/power` | `ON` / `OFF` | WebApp -> Device |
| `fujitsu/set/target_temp`| Float string (e.g. `23.5`) | WebApp -> Device |
| `fujitsu/set/mode` | `cool`, `heat`, `dry`, `fan_only`, `auto` | WebApp -> Device |
| `fujitsu/set/fan_mode` | `quiet`, `low`, `medium`, `high`, `auto` | WebApp -> Device |
