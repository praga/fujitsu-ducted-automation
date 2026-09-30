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

try:
    from backend.timers import timer_manager, CountdownPayload, ScheduleItem
except ImportError:
    from timers import timer_manager, CountdownPayload, ScheduleItem

# Logging setup
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("fujitsu-ac")

# Environment configurations
MQTT_BROKER = os.getenv("MQTT_BROKER", "mosquitto")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))
MQTT_TOPIC_PREFIX = os.getenv("MQTT_TOPIC_PREFIX", "fujitsu")

# Aircon state schema
class ACControlPayload(BaseModel):
    power: str | None = None          # "ON" or "OFF"
    mode: str | None = None           # "cool", "heat", "dry", "fan_only", "auto"
    target_temperature: float | None = None  # 16.0 - 30.0
    fan_mode: str | None = None       # "quiet", "low", "medium", "high", "auto"
    swing_mode: str | None = None     # "off", "vertical"
    preset: str | None = None         # "eco", "none"

# Global state - 100% Real hardware sync (Simulation removed)
ac_state: Dict[str, Any] = {
    "power": "OFF",
    "mode": "cool",
    "target_temperature": 25.0,
    "current_temperature": 21.5,
    "fan_mode": "low",
    "swing_mode": "off",
    "preset": "eco",
    "device_online": False,
    "bus_connected": False,
    "is_simulated": False,
    "controller_role": "secondary",
    "last_updated": time.time(),
}

connected_websockets: Set[WebSocket] = set()
mqtt_client: mqtt.Client | None = None

async def broadcast_state():
    """Broadcast current state to all connected WebSockets."""
    if not connected_websockets:
        return
    message = json.dumps({
        "type": "state_update",
        "data": ac_state,
        "timers": timer_manager.get_timers_state()
    })
    dead_sockets = set()
    for ws in list(connected_websockets):
        try:
            await ws.send_text(message)
        except Exception:
            dead_sockets.add(ws)
    connected_websockets.difference_update(dead_sockets)

def publish_climate_command(field: str, value: str):
    """Publish command to ESPHome fujitsu_ducted_aircon climate entity and legacy topics."""
    if mqtt_client and mqtt_client.is_connected():
        # ESPHome climate command topic
        topic_esphome = f"{MQTT_TOPIC_PREFIX}/climate/fujitsu_ducted_aircon/{field}/command"
        mqtt_client.publish(topic_esphome, value, qos=1, retain=False)
        logger.info(f"Published ESPHome command -> {topic_esphome}: {value}")

        # Legacy fallback command topic
        topic_legacy = f"{MQTT_TOPIC_PREFIX}/set/{field}"
        mqtt_client.publish(topic_legacy, value, qos=1, retain=False)

def apply_state_change(new_state: Dict[str, Any], force: bool = False):
    """Apply updates to ac_state and publish to ESPHome climate entity."""
    if not ac_state.get("device_online", False):
        logger.warning("Rejected apply_state_change: ESP32 hardware is offline")
        return False

    changed = False

    # Power control
    if "power" in new_state and new_state["power"] in ("ON", "OFF"):
        new_power = new_state["power"]
        if force or ac_state["power"] != new_power:
            ac_state["power"] = new_power
            changed = True
            if new_power == "OFF":
                publish_climate_command("mode", "off")
            else:
                target_mode = ac_state.get("mode", "cool")
                if target_mode == "off":
                    target_mode = "cool"
                    ac_state["mode"] = target_mode
                publish_climate_command("mode", target_mode)

    # Mode control
    if "mode" in new_state and new_state["mode"] in ("cool", "heat", "dry", "fan_only", "auto", "off"):
        new_mode = new_state["mode"]
        if ac_state["mode"] != new_mode:
            ac_state["mode"] = new_mode
            if new_mode == "off":
                ac_state["power"] = "OFF"
            else:
                ac_state["power"] = "ON"
            publish_climate_command("mode", new_mode)
            changed = True

    # Target temperature (Fujitsu uses whole integer degrees 16-30°C)
    if "target_temperature" in new_state and new_state["target_temperature"] is not None:
        val = int(round(float(new_state["target_temperature"])))
        val = max(16, min(30, val))
        if ac_state["target_temperature"] != val:
            ac_state["target_temperature"] = val
            publish_climate_command("target_temperature", str(val))
            publish_climate_command("target_temp", str(val))
            changed = True

    # Fan mode
    if "fan_mode" in new_state and new_state["fan_mode"] in ("quiet", "low", "medium", "high", "auto"):
        new_fan = new_state["fan_mode"]
        if ac_state["fan_mode"] != new_fan:
            ac_state["fan_mode"] = new_fan
            publish_climate_command("fan_mode", new_fan)
            changed = True

    # Preset / Eco
    if "preset" in new_state and new_state["preset"] in ("eco", "none"):
        new_preset = new_state["preset"]
        if ac_state.get("preset") != new_preset:
            ac_state["preset"] = new_preset
            publish_climate_command("preset", new_preset)
            changed = True

    # Swing mode
    if "swing_mode" in new_state and new_state["swing_mode"] in ("off", "vertical"):
        new_swing = new_state["swing_mode"]
        if ac_state["swing_mode"] != new_swing:
            ac_state["swing_mode"] = new_swing
            publish_climate_command("swing_mode", new_swing)
            changed = True

    if changed:
        ac_state["last_updated"] = time.time()
    return changed

# MQTT callbacks
def on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        logger.info(f"Successfully connected to MQTT Broker at {MQTT_BROKER}:{MQTT_PORT}")
        client.subscribe(f"{MQTT_TOPIC_PREFIX}/#")
    else:
        logger.warning(f"MQTT connect returned result code {rc}")

def on_message(client, userdata, msg):
    topic = msg.topic
    try:
        payload_str = msg.payload.decode("utf-8").strip()
    except Exception:
        return

    # Ignore command topics to prevent loopback
    if "/command" in topic or "/set/" in topic:
        return

    updated = False

    # Status / connectivity
    if topic.endswith("/status") or topic.endswith("/availability"):
        online = payload_str.lower() in ("online", "true", "connected")
        if ac_state["device_online"] != online:
            ac_state["device_online"] = online
            if not online:
                ac_state["bus_connected"] = False
            updated = True
            logger.info(f"ESP32 hardware online status changed -> {online}")
    elif topic == f"{MQTT_TOPIC_PREFIX}/binary_sensor/connected/state":
        bus_conn = payload_str.upper() == "ON"
        if ac_state.get("bus_connected") != bus_conn:
            ac_state["bus_connected"] = bus_conn
            updated = True

    # Climate mode & power
    elif topic.endswith("/mode/state") or topic.endswith("/mode"):
        mode_val = payload_str.lower()
        if mode_val == "off":
            if ac_state["power"] != "OFF":
                ac_state["power"] = "OFF"
                updated = True
        else:
            if ac_state["power"] != "ON":
                ac_state["power"] = "ON"
                updated = True
            if ac_state["mode"] != mode_val:
                ac_state["mode"] = mode_val
                updated = True

    # Current temperature
    elif topic.endswith("/current_temperature/state") or topic.endswith("/current_temp"):
        try:
            val = round(float(payload_str), 1)
            if ac_state["current_temperature"] != val:
                ac_state["current_temperature"] = val
                updated = True
        except ValueError:
            pass

    # Target temperature
    elif topic.endswith("/target_temperature/state") or topic.endswith("/target_temp"):
        try:
            val = int(round(float(payload_str)))
            if ac_state["target_temperature"] != val:
                ac_state["target_temperature"] = val
                updated = True
        except ValueError:
            pass

    # Fan mode
    elif topic.endswith("/fan_mode/state") or topic.endswith("/fan_mode"):
        fan_val = payload_str.lower()
        if ac_state["fan_mode"] != fan_val:
            ac_state["fan_mode"] = fan_val
            updated = True

    # Preset
    elif topic.endswith("/preset/state") or topic.endswith("/preset"):
        preset_val = payload_str.lower()
        if ac_state.get("preset") != preset_val:
            ac_state["preset"] = preset_val
            updated = True

    # Swing mode
    elif topic.endswith("/swing_mode/state") or topic.endswith("/swing_mode"):
        swing_val = payload_str.lower()
        if ac_state["swing_mode"] != swing_val:
            ac_state["swing_mode"] = swing_val
            updated = True

    if updated:
        ac_state["is_simulated"] = False
        ac_state["last_updated"] = time.time()
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(broadcast_state())
        except RuntimeError:
            pass

async def timer_scheduler_loop():
    logger.info("Timer background scheduler started (1s tick)")
    while True:
        try:
            await timer_manager.check_triggers(lambda s: apply_state_change(s, force=True), broadcast_state)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Error in timer scheduler loop: {e}")
        await asyncio.sleep(1)

@asynccontextmanager
async def lifespan(app: FastAPI):
    global mqtt_client
    logger.info("Initializing Fujitsu Ducted AC Live Backend Service...")

    if hasattr(time, 'tzset') and os.getenv('TZ'):
        try:
            time.tzset()
            logger.info(f"System timezone set to {os.getenv('TZ')}")
        except Exception as e:
            logger.warning(f"Could not tzset: {e}")

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
        logger.warning(f"Could not connect to MQTT Broker ({MQTT_BROKER}:{MQTT_PORT}): {e}")

    # Start timer scheduler background task
    scheduler_task = asyncio.create_task(timer_scheduler_loop())

    yield

    logger.info("Shutting down Fujitsu Ducted AC Backend...")
    scheduler_task.cancel()
    try:
        await scheduler_task
    except asyncio.CancelledError:
        pass

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
        "is_simulated": False
    }

@app.get("/api/status")
async def get_status():
    return ac_state

@app.post("/api/control")
async def control_ac(payload: ACControlPayload):
    if not ac_state.get("device_online", False):
        raise HTTPException(status_code=503, detail="ESP32 hardware is offline. Reconnect the controller to send commands.")
    changes = payload.model_dump(exclude_unset=True)
    changed = apply_state_change(changes)
    if changed:
        await broadcast_state()
    return {"success": True, "state": ac_state}

# Timer Endpoints
@app.get("/api/timers")
async def get_timers():
    return timer_manager.get_timers_state()

@app.post("/api/timers/countdown")
async def set_countdown(payload: CountdownPayload):
    res = timer_manager.set_countdown(payload.minutes, payload.action)
    await broadcast_state()
    return {"success": True, "timers": res}

@app.post("/api/timers/schedule")
async def add_or_update_schedule(payload: ScheduleItem):
    entry = timer_manager.add_or_update_schedule(payload)
    await broadcast_state()
    return {"success": True, "schedule": entry, "timers": timer_manager.get_timers_state()}

@app.post("/api/timers/schedule/{timer_id}/toggle")
async def toggle_schedule(timer_id: str):
    success = timer_manager.toggle_schedule(timer_id)
    if not success:
        raise HTTPException(status_code=404, detail="Schedule not found")
    await broadcast_state()
    return {"success": True, "timers": timer_manager.get_timers_state()}

@app.delete("/api/timers/schedule/{timer_id}")
async def delete_schedule(timer_id: str):
    success = timer_manager.delete_schedule(timer_id)
    if not success:
        raise HTTPException(status_code=404, detail="Schedule not found")
    await broadcast_state()
    return {"success": True, "timers": timer_manager.get_timers_state()}

# WebSocket Endpoint
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_websockets.add(websocket)
    logger.info(f"WebSocket client connected. Total clients: {len(connected_websockets)}")
    try:
        # Send immediate live state on connect
        await websocket.send_text(json.dumps({
            "type": "state_update",
            "data": ac_state,
            "timers": timer_manager.get_timers_state()
        }))
        while True:
            text = await websocket.receive_text()
            try:
                msg = json.loads(text)
                action = msg.get("action")
                value = msg.get("value")

                if action in ("set_power", "set_mode", "set_temp", "set_fan", "set_swing", "set_preset"):
                    if not ac_state.get("device_online", False):
                        logger.warning(f"Rejected WebSocket command '{action}': ESP32 is offline")
                        await websocket.send_text(json.dumps({
                            "type": "error",
                            "message": "ESP32 hardware is offline. Reconnect controller to change settings."
                        }))
                        continue

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
                elif action == "set_preset":
                    updates["preset"] = value
                elif action == "set_countdown":
                    if isinstance(value, dict):
                        mins = int(value.get("minutes", 0))
                        act = str(value.get("action", "OFF"))
                    else:
                        mins = int(value)
                        act = "OFF"
                    timer_manager.set_countdown(mins, act)
                    await broadcast_state()
                    continue
                elif action == "toggle_schedule":
                    timer_manager.toggle_schedule(str(value))
                    await broadcast_state()
                    continue
                elif action == "delete_schedule":
                    timer_manager.delete_schedule(str(value))
                    await broadcast_state()
                    continue

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
