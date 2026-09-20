import asyncio
import json
import logging
import os
import time
from typing import Dict, Any, Set
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
import paho.mqtt.client as mqtt

# Logging setup
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("fujitsu-ac")

# Environment configurations
MQTT_BROKER = os.getenv("MQTT_BROKER", "mosquitto")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_TOPIC_PREFIX = os.getenv("MQTT_TOPIC_PREFIX", "fujitsu")
SIMULATE_AC = os.getenv("SIMULATE_AC", "true").lower() in ("true", "1", "yes")

# Aircon state schema
class ACControlPayload(BaseModel):
    power: str | None = None          # "ON" or "OFF"
    mode: str | None = None           # "cool", "heat", "dry", "fan_only", "auto"
    target_temperature: float | None = None  # 16.0 - 30.0
    fan_mode: str | None = None       # "quiet", "low", "medium", "high", "auto"
    swing_mode: str | None = None     # "off", "vertical"

# Global state
ac_state: Dict[str, Any] = {
    "power": "OFF",
    "mode": "cool",
    "target_temperature": 24.0,
    "current_temperature": 26.5,
    "fan_mode": "auto",
    "swing_mode": "off",
    "device_online": SIMULATE_AC,
    "is_simulated": SIMULATE_AC,
    "controller_role": "secondary",
    "last_updated": time.time(),
}

connected_websockets: Set[WebSocket] = set()
mqtt_client: mqtt.Client | None = None
last_hardware_seen: float = 0.0

async def broadcast_state():
    """Broadcast current state to all connected WebSockets."""
    if not connected_websockets:
        return
    message = json.dumps({"type": "state_update", "data": ac_state})
    dead_sockets = set()
    for ws in list(connected_websockets):
        try:
            await ws.send_text(message)
        except Exception:
            dead_sockets.add(ws)
    connected_websockets.difference_update(dead_sockets)

def publish_mqtt_command(topic_suffix: str, payload: str):
    """Publish a command to the MQTT broker."""
    if mqtt_client and mqtt_client.is_connected():
        topic = f"{MQTT_TOPIC_PREFIX}/set/{topic_suffix}"
        mqtt_client.publish(topic, payload, qos=1, retain=False)
        logger.info(f"Published MQTT command -> {topic}: {payload}")

def apply_state_change(new_state: Dict[str, Any]):
    """Apply updates to ac_state and validate bounds."""
    changed = False
    if "power" in new_state and new_state["power"] in ("ON", "OFF"):
        if ac_state["power"] != new_state["power"]:
            ac_state["power"] = new_state["power"]
            publish_mqtt_command("power", ac_state["power"])
            changed = True

    if "mode" in new_state and new_state["mode"] in ("cool", "heat", "dry", "fan_only", "auto"):
        if ac_state["mode"] != new_state["mode"]:
            ac_state["mode"] = new_state["mode"]
            publish_mqtt_command("mode", ac_state["mode"])
            changed = True

    if "target_temperature" in new_state:
        val = round(float(new_state["target_temperature"]), 1)
        val = max(16.0, min(30.0, val))
        if ac_state["target_temperature"] != val:
            ac_state["target_temperature"] = val
            publish_mqtt_command("target_temp", str(val))
            changed = True

    if "fan_mode" in new_state and new_state["fan_mode"] in ("quiet", "low", "medium", "high", "auto"):
        if ac_state["fan_mode"] != new_state["fan_mode"]:
            ac_state["fan_mode"] = new_state["fan_mode"]
            publish_mqtt_command("fan_mode", ac_state["fan_mode"])
            changed = True

    if "swing_mode" in new_state:
        if ac_state["swing_mode"] != new_state["swing_mode"]:
            ac_state["swing_mode"] = new_state["swing_mode"]
            publish_mqtt_command("swing_mode", ac_state["swing_mode"])
            changed = True

    if changed:
        ac_state["last_updated"] = time.time()
    return changed

# MQTT callbacks
def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        logger.info(f"Successfully connected to MQTT Broker at {MQTT_BROKER}:{MQTT_PORT}")
        # Subscribe to all state topics from ESPHome or custom firmware
        client.subscribe(f"{MQTT_TOPIC_PREFIX}/#")
        client.subscribe("fujitsu_ac/#")
    else:
        logger.warning(f"MQTT connect returned result code {rc}")

def on_message(client, userdata, msg):
    global last_hardware_seen
    topic = msg.topic
    try:
        payload_str = msg.payload.decode("utf-8")
    except Exception:
        return

    logger.debug(f"Received MQTT message: {topic} -> {payload_str}")

    # Ignore our own set commands
    if "/set/" in topic:
        return

    # Check for live device presence
    if topic.endswith("/status") or topic.endswith("/availability"):
        if payload_str.lower() in ("online", "true", "connected"):
            ac_state["device_online"] = True
            ac_state["is_simulated"] = False
            last_hardware_seen = time.time()
        elif payload_str.lower() in ("offline", "false", "disconnected"):
            if not SIMULATE_AC:
                ac_state["device_online"] = False

    # Check for state payloads (JSON or plain text)
    updated = False
    if topic.endswith("/state") or topic.endswith("/json"):
        try:
            data = json.loads(payload_str)
            for k in ("power", "mode", "target_temperature", "current_temperature", "fan_mode", "swing_mode"):
                if k in data and ac_state.get(k) != data[k]:
                    ac_state[k] = data[k]
                    updated = True
            ac_state["device_online"] = True
            ac_state["is_simulated"] = False
            last_hardware_seen = time.time()
        except Exception:
            pass
    elif topic.endswith("/current_temp") or topic.endswith("/current_temperature"):
        try:
            val = round(float(payload_str), 1)
            ac_state["current_temperature"] = val
            updated = True
            last_hardware_seen = time.time()
        except ValueError:
            pass
    elif topic.endswith("/target_temp") or topic.endswith("/target_temperature"):
        try:
            val = round(float(payload_str), 1)
            ac_state["target_temperature"] = val
            updated = True
            last_hardware_seen = time.time()
        except ValueError:
            pass
    elif topic.endswith("/power"):
        ac_state["power"] = payload_str.upper()
        updated = True
        last_hardware_seen = time.time()
    elif topic.endswith("/mode"):
        ac_state["mode"] = payload_str.lower()
        updated = True
        last_hardware_seen = time.time()
    elif topic.endswith("/fan_mode"):
        ac_state["fan_mode"] = payload_str.lower()
        updated = True
        last_hardware_seen = time.time()

    if updated:
        ac_state["last_updated"] = time.time()
        # Schedule broadcast on running loop
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(broadcast_state())
        except RuntimeError:
            pass

# Simulator background task
async def background_simulator_task():
    """Simulates realistic room temperature response when hardware is not yet online."""
    while True:
        await asyncio.sleep(4.0)
        # Only simulate if simulator mode is active and no real hardware seen recently
        now = time.time()
        if ac_state["is_simulated"] or (now - last_hardware_seen > 120 and SIMULATE_AC):
            ac_state["device_online"] = True
            ac_state["is_simulated"] = True
            target = ac_state["target_temperature"]
            current = ac_state["current_temperature"]
            power = ac_state["power"]
            mode = ac_state["mode"]

            if power == "ON":
                if mode == "cool":
                    if current > target:
                        ac_state["current_temperature"] = round(current - 0.1, 1)
                        await broadcast_state()
                elif mode == "heat":
                    if current < target:
                        ac_state["current_temperature"] = round(current + 0.1, 1)
                        await broadcast_state()
            else:
                # Drift back towards ambient 26°C slowly
                ambient = 26.0
                if abs(current - ambient) >= 0.1:
                    drift = 0.05 if current < ambient else -0.05
                    ac_state["current_temperature"] = round(current + drift, 1)
                    await broadcast_state()

@asynccontextmanager
async def lifespan(app: FastAPI):
    global mqtt_client
    logger.info("Initializing Fujitsu Ducted AC Backend Service...")
    # Start MQTT Client
    try:
        mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="fujitsu-webapp-backend")
    except AttributeError:
        mqtt_client = mqtt.Client(client_id="fujitsu-webapp-backend")

    mqtt_client.on_connect = on_connect
    mqtt_client.on_message = on_message

    try:
        mqtt_client.connect_async(MQTT_BROKER, MQTT_PORT, 60)
        mqtt_client.loop_start()
        logger.info(f"MQTT client started connecting to {MQTT_BROKER}:{MQTT_PORT}")
    except Exception as e:
        logger.warning(f"Could not connect to MQTT Broker ({MQTT_BROKER}:{MQTT_PORT}): {e}. Simulator is active.")

    # Start background simulator
    sim_task = asyncio.create_task(background_simulator_task())

    yield

    logger.info("Shutting down Fujitsu Ducted AC Backend...")
    sim_task.cancel()
    if mqtt_client:
        mqtt_client.loop_stop()
        mqtt_client.disconnect()

app = FastAPI(title="Fujitsu Ducted AC Controller", lifespan=lifespan)

# REST API Endpoints
@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "mqtt_connected": mqtt_client.is_connected() if mqtt_client else False,
        "device_online": ac_state["device_online"],
        "is_simulated": ac_state["is_simulated"]
    }

@app.get("/api/status")
async def get_status():
    return ac_state

@app.post("/api/control")
async def control_ac(payload: ACControlPayload):
    changes = payload.model_dump(exclude_unset=True)
    changed = apply_state_change(changes)
    if changed:
        await broadcast_state()
    return {"success": True, "state": ac_state}

# WebSocket Endpoint
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_websockets.add(websocket)
    logger.info(f"WebSocket client connected. Total clients: {len(connected_websockets)}")
    try:
        # Send immediate state on connect
        await websocket.send_text(json.dumps({"type": "state_update", "data": ac_state}))
        while True:
            text = await websocket.receive_text()
            try:
                msg = json.loads(text)
                action = msg.get("action")
                value = msg.get("value")
                updates = {}
                if action == "set_power":
                    updates["power"] = value
                elif action == "set_mode":
                    updates["mode"] = value
                elif action == "set_temp":
                    updates["target_temperature"] = value
                elif action == "set_fan":
                    updates["fan_mode"] = value
                elif action == "set_swing":
                    updates["swing_mode"] = value

                if updates and apply_state_change(updates):
                    await broadcast_state()
            except json.JSONDecodeError:
                pass
    except WebSocketDisconnect:
        connected_websockets.discard(websocket)
        logger.info(f"WebSocket client disconnected. Total clients: {len(connected_websockets)}")
    except Exception as e:
        connected_websockets.discard(websocket)
        logger.warning(f"WebSocket error: {e}")

# Static Frontend Files Mount
frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.exists(frontend_dir):
    app.mount("/static", StaticFiles(directory=frontend_dir), name="static")

    @app.get("/")
    async def serve_index():
        return FileResponse(os.path.join(frontend_dir, "index.html"))

    @app.get("/manifest.json")
    async def serve_manifest():
        return FileResponse(os.path.join(frontend_dir, "manifest.json"))

    @app.get("/sw.js")
    async def serve_sw():
        return FileResponse(os.path.join(frontend_dir, "sw.js"), media_type="application/javascript")
