import asyncio
import json
import logging
import os
import time
import uuid
from datetime import datetime
from typing import Dict, Any, List, Optional
from pydantic import BaseModel

logger = logging.getLogger("fujitsu-timers")

DATA_DIR = os.getenv("DATA_DIR")
if not DATA_DIR:
    if os.path.exists("/app"):
        DATA_DIR = "/app/data"
    else:
        DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
TIMERS_FILE = os.path.join(DATA_DIR, "timers.json")

class CountdownPayload(BaseModel):
    minutes: int              # e.g. 15, 30, 60, 120 (0 to cancel)
    action: str = "OFF"       # "ON" or "OFF"

class ScheduleItem(BaseModel):
    id: Optional[str] = None
    time: str                 # "HH:MM" (e.g. "07:30", "23:00")
    action: str = "OFF"       # "ON" or "OFF"
    days: List[int]           # 0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri, 5=Sat, 6=Sun
    enabled: bool = True
    label: str = ""

class TimerManager:
    def __init__(self):
        self.countdown_action: Optional[str] = None
        self.countdown_end_time: Optional[float] = None
        self.countdown_duration_mins: int = 0
        self.schedules: List[Dict[str, Any]] = []
        self._last_schedule_trigger: Dict[str, str] = {}  # timer_id -> "YYYY-MM-DD HH:MM"
        self._load_timers()

    def _ensure_dir(self):
        try:
            os.makedirs(os.path.dirname(TIMERS_FILE), exist_ok=True)
        except Exception as e:
            logger.warning(f"Could not create data dir: {e}")

    def _load_timers(self):
        self._ensure_dir()
        if os.path.exists(TIMERS_FILE):
            try:
                with open(TIMERS_FILE, "r") as f:
                    data = json.load(f)
                    self.schedules = data.get("schedules", [])
                    logger.info(f"Loaded {len(self.schedules)} scheduled timers from {TIMERS_FILE}")
            except Exception as e:
                logger.error(f"Failed to read {TIMERS_FILE}: {e}")
                self.schedules = []
        else:
            self.schedules = []

    def _save_timers(self):
        self._ensure_dir()
        try:
            with open(TIMERS_FILE, "w") as f:
                json.dump({"schedules": self.schedules}, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save {TIMERS_FILE}: {e}")

    def set_countdown(self, minutes: int, action: str = "OFF") -> Dict[str, Any]:
        if minutes <= 0:
            self.countdown_action = None
            self.countdown_end_time = None
            self.countdown_duration_mins = 0
            logger.info("Countdown timer cancelled")
        else:
            self.countdown_action = action.upper()
            self.countdown_duration_mins = minutes
            self.countdown_end_time = time.time() + (minutes * 60)
            logger.info(f"Countdown timer set: {action.upper()} in {minutes} minutes")
        return self.get_timers_state()

    def get_countdown_state(self) -> Dict[str, Any]:
        if not self.countdown_end_time or self.countdown_end_time <= time.time():
            return {
                "active": False,
                "action": None,
                "remaining_seconds": 0,
                "duration_minutes": 0,
            }
        rem = int(self.countdown_end_time - time.time())
        return {
            "active": True,
            "action": self.countdown_action,
            "remaining_seconds": rem,
            "duration_minutes": self.countdown_duration_mins,
            "end_time": self.countdown_end_time,
        }

    def add_or_update_schedule(self, item: ScheduleItem) -> Dict[str, Any]:
        timer_id = item.id or str(uuid.uuid4())[:8]
        new_entry = {
            "id": timer_id,
            "time": item.time,
            "action": item.action.upper(),
            "days": item.days,
            "enabled": item.enabled,
            "label": item.label or f"{item.action.upper()} at {item.time}",
        }
        # Update existing or append
        existing = False
        for idx, s in enumerate(self.schedules):
            if s.get("id") == timer_id:
                self.schedules[idx] = new_entry
                existing = True
                break
        if not existing:
            self.schedules.append(new_entry)
        self._save_timers()
        return new_entry

    def toggle_schedule(self, timer_id: str) -> bool:
        for s in self.schedules:
            if s.get("id") == timer_id:
                s["enabled"] = not s.get("enabled", True)
                self._save_timers()
                return True
        return False

    def delete_schedule(self, timer_id: str) -> bool:
        initial_len = len(self.schedules)
        self.schedules = [s for s in self.schedules if s.get("id") != timer_id]
        if len(self.schedules) != initial_len:
            self._save_timers()
            return True
        return False

    def get_timers_state(self) -> Dict[str, Any]:
        return {
            "countdown": self.get_countdown_state(),
            "schedules": self.schedules,
        }

    async def check_triggers(self, apply_state_change_cb, broadcast_cb):
        """Called periodically by background scheduler."""
        now_ts = time.time()

        # 1. Check countdown timer
        if self.countdown_end_time and now_ts >= self.countdown_end_time:
            target_action = self.countdown_action or "OFF"
            logger.info(f"⏱️ Countdown timer expired! Executing AC {target_action}")
            self.countdown_end_time = None
            self.countdown_action = None
            self.countdown_duration_mins = 0
            try:
                apply_state_change_cb({"power": target_action})
            except Exception as e:
                logger.error(f"Failed applying countdown state change: {e}")
            await broadcast_cb()

        # 2. Check recurring schedules
        now_dt = datetime.now()
        current_minute_str = now_dt.strftime("%H:%M")
        current_day = now_dt.weekday()  # 0=Monday, 6=Sunday
        today_key = now_dt.strftime("%Y-%m-%d %H:%M")

        for sched in self.schedules:
            if not sched.get("enabled", True):
                continue
            if sched.get("time") == current_minute_str and current_day in sched.get("days", []):
                timer_id = sched.get("id")
                # Ensure we only trigger once per minute
                if self._last_schedule_trigger.get(timer_id) != today_key:
                    self._last_schedule_trigger[timer_id] = today_key
                    act = sched.get("action", "OFF").upper()
                    logger.info(f"📅 Scheduled timer [{sched.get('label')}] triggered! Executing AC {act}")
                    try:
                        apply_state_change_cb({"power": act})
                    except Exception as e:
                        logger.error(f"Failed applying scheduled state change: {e}")
                    await broadcast_cb()

timer_manager = TimerManager()
