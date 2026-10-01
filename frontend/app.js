// Fujitsu Ducted AC Mobile WebApp Client
let ws = null;
let reconnectInterval = 1500;
let currentACState = {
  power: "OFF",
  mode: "cool",
  target_temperature: 24.0,
  current_temperature: 26.5,
  fan_mode: "auto",
  swing_mode: "off",
  device_online: false,
  bus_connected: false,
  is_simulated: false,
  controller_role: "secondary"
};

let currentTimers = {
  countdown: { active: false, remaining_seconds: 0, duration_minutes: 0, action: "OFF" },
  schedules: []
};
let countdownLocalInterval = null;
let countdownTargetTimestamp = null;

// DOM Elements
const appContainer = document.querySelector(".app-container");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const roomTempEl = document.getElementById("roomTemp");
const targetTempEl = document.getElementById("targetTemp");
const activeModeBadge = document.getElementById("activeModeBadge");
const tempDial = document.getElementById("tempDial");
const btnPower = document.getElementById("btnPower");
const powerText = document.getElementById("powerText");
const btnTempUp = document.getElementById("btnTempUp");
const btnTempDown = document.getElementById("btnTempDown");
const lastSyncText = document.getElementById("lastSyncText");
const controllerRole = document.getElementById("controllerRole");
const offlineAlertBanner = document.getElementById("offlineAlertBanner");
const offlineAlertText = document.getElementById("offlineAlertText");
const toastContainer = document.getElementById("toastContainer");

const modeButtons = document.querySelectorAll(".control-btn");
const fanButtons = document.querySelectorAll(".fan-btn");
const presetButtons = document.querySelectorAll(".preset-pill");

// Timer DOM Elements
const activeCountdownBanner = document.getElementById("activeCountdownBanner");
const countdownBannerTitle = document.getElementById("countdownBannerTitle");
const countdownClockDisplay = document.getElementById("countdownClockDisplay");
const btnCancelCountdown = document.getElementById("btnCancelCountdown");
const quickTimerRow = document.getElementById("quickTimerRow");
const schedulesList = document.getElementById("schedulesList");
const btnAddSchedule = document.getElementById("btnAddSchedule");

// Modal Elements
const scheduleModal = document.getElementById("scheduleModal");
const btnCloseScheduleModal = document.getElementById("btnCloseScheduleModal");
const btnCancelSchedule = document.getElementById("btnCancelSchedule");
const scheduleForm = document.getElementById("scheduleForm");
const scheduleTime = document.getElementById("scheduleTime");
const scheduleLabel = document.getElementById("scheduleLabel");
const actionBtnOff = document.getElementById("actionBtnOff");
const actionBtnOn = document.getElementById("actionBtnOn");
const dayButtons = document.querySelectorAll(".day-btn");
const selectEveryday = document.getElementById("selectEveryday");
const selectWeekdays = document.getElementById("selectWeekdays");
const selectWeekends = document.getElementById("selectWeekends");

const countdownModal = document.getElementById("countdownModal");
const btnCustomCountdown = document.getElementById("btnCustomCountdown");
const btnCloseCountdownModal = document.getElementById("btnCloseCountdownModal");
const btnCancelCustomCountdown = document.getElementById("btnCancelCustomCountdown");
const countdownForm = document.getElementById("countdownForm");
const customMinutesInput = document.getElementById("customMinutes");
const btnMinMins = document.getElementById("btnMinMins");
const btnPlusMins = document.getElementById("btnPlusMins");
const btnCustomActionOff = document.getElementById("btnCustomActionOff");
const btnCustomActionOn = document.getElementById("btnCustomActionOn");

// Mode visual properties
const modeDetails = {
  cool: { name: "COOLING", color: "#00d2ff", glow: "rgba(0, 210, 255, 0.3)" },
  heat: { name: "HEATING", color: "#ff6b35", glow: "rgba(255, 107, 53, 0.3)" },
  dry: { name: "DRYING", color: "#00c9a7", glow: "rgba(0, 201, 167, 0.3)" },
  fan_only: { name: "FAN ONLY", color: "#a78bfa", glow: "rgba(167, 139, 250, 0.3)" },
  auto: { name: "AUTO CLIMATE", color: "#10b981", glow: "rgba(16, 185, 129, 0.3)" },
};

const DAY_NAMES = ["M", "T", "W", "T", "F", "S", "S"];

function triggerHaptic() {
  if (navigator.vibrate) {
    try {
      navigator.vibrate(15);
    } catch (e) {}
  }
}

function showToast(message) {
  if (!toastContainer) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode) {
      toast.parentNode.removeChild(toast);
    }
  }, 3000);
}

function requireOnline() {
  if (!currentACState.device_online) {
    showToast("⚠️ ESP32 is offline. Cannot change settings.");
    if (navigator.vibrate) {
      try {
        navigator.vibrate([40, 50, 40]);
      } catch (e) {}
    }
    return false;
  }
  return true;
}

// Update UI to match current state
function renderState(state) {
  currentACState = { ...currentACState, ...state };

  const isOnline = !!currentACState.device_online;

  // Toggle offline class on container (disables pointer events & dims UI)
  if (appContainer) {
    appContainer.classList.toggle("device-offline", !isOnline);
  }

  // Toggle offline banner
  if (offlineAlertBanner) {
    offlineAlertBanner.classList.toggle("hidden", isOnline);
    if (!isOnline && offlineAlertText) {
      offlineAlertText.textContent = "ESP32 Offline — Reconnect controller";
    }
  }

  // Room Temp
  if (currentACState.current_temperature !== undefined) {
    roomTempEl.textContent = Number(currentACState.current_temperature).toFixed(1);
  }

  // Target Temp (Integer degrees for Fujitsu)
  if (currentACState.target_temperature !== undefined) {
    targetTempEl.textContent = Math.round(Number(currentACState.target_temperature));
  }

  // Power
  const isPowerOn = currentACState.power === "ON";
  btnPower.classList.toggle("on", isPowerOn && isOnline);
  powerText.textContent = isPowerOn ? "ON" : "OFF";
  tempDial.classList.toggle("power-off", !isPowerOn || !isOnline);

  // Mode Theme & Badge
  const curMode = (currentACState.mode === "heat_cool" ? "auto" : currentACState.mode) || "cool";
  const details = modeDetails[curMode] || modeDetails.cool;
  if (!isOnline) {
    activeModeBadge.textContent = "OFFLINE";
  } else {
    activeModeBadge.textContent = isPowerOn ? details.name : "STANDBY";
  }
  
  // Set dynamic CSS variables for theme glow
  document.documentElement.style.setProperty("--active-color", details.color);
  document.documentElement.style.setProperty("--active-glow", isOnline ? details.glow : "none");

  // Active Mode Buttons
  modeButtons.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.mode === curMode);
  });

  // Active Fan Buttons
  const curFan = currentACState.fan_mode || "auto";
  fanButtons.forEach(btn => {
    btn.classList.toggle("active", btn.dataset.fan === curFan);
  });

  // Device Status Indicator
  statusDot.className = "status-dot";
  if (currentACState.is_simulated) {
    statusDot.classList.add("simulated");
    statusText.textContent = "Simulated • Standby";
  } else if (isOnline) {
    statusDot.classList.add("online");
    statusText.textContent = "Live • 3-Wire Sync";
  } else {
    statusDot.classList.add("offline");
    statusText.textContent = "ESP32 Offline";
  }

  if (currentACState.controller_role) {
    controllerRole.textContent = !isOnline
      ? "ESP32 Disconnected"
      : (currentACState.controller_role === "secondary" ? "Secondary Remote (Wall Active)" : "Master Remote");
  }

  // Last update timestamp
  const now = new Date();
  lastSyncText.textContent = `Synced at ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

// Timers Rendering Logic
function renderTimers(timers) {
  if (!timers) return;
  currentTimers = timers;

  // 1. Countdown rendering
  const cd = timers.countdown;
  if (cd && cd.active && cd.remaining_seconds > 0) {
    activeCountdownBanner.classList.remove("hidden");
    const isTurnOn = cd.action && cd.action.toUpperCase() === "ON";
    activeCountdownBanner.classList.toggle("turn-on", isTurnOn);
    countdownBannerTitle.textContent = isTurnOn ? "TURNING ON IN" : "TURNING OFF IN";

    // Set target timestamp
    if (cd.end_time) {
      countdownTargetTimestamp = cd.end_time * 1000;
    } else {
      countdownTargetTimestamp = Date.now() + (cd.remaining_seconds * 1000);
    }

    updateCountdownClockDisplay();
    if (!countdownLocalInterval) {
      countdownLocalInterval = setInterval(updateCountdownClockDisplay, 1000);
    }
  } else {
    activeCountdownBanner.classList.add("hidden");
    if (countdownLocalInterval) {
      clearInterval(countdownLocalInterval);
      countdownLocalInterval = null;
    }
    countdownTargetTimestamp = null;
  }

  // 2. Schedules rendering
  renderSchedules(timers.schedules || []);
}

function updateCountdownClockDisplay() {
  if (!countdownTargetTimestamp) return;
  const now = Date.now();
  const diffSecs = Math.max(0, Math.round((countdownTargetTimestamp - now) / 1000));
  if (diffSecs <= 0) {
    countdownClockDisplay.textContent = "00:00:00";
    if (countdownLocalInterval) {
      clearInterval(countdownLocalInterval);
      countdownLocalInterval = null;
    }
    return;
  }
  const hrs = Math.floor(diffSecs / 3600);
  const mins = Math.floor((diffSecs % 3600) / 60);
  const secs = diffSecs % 60;
  const pad = (n) => String(n).padStart(2, "0");
  countdownClockDisplay.textContent = `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
}

function formatTime12h(timeStr) {
  if (!timeStr) return "";
  const parts = timeStr.split(":");
  let h = parseInt(parts[0], 10);
  const m = parts[1] || "00";
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

function renderSchedules(schedules) {
  schedulesList.innerHTML = "";
  if (!schedules || schedules.length === 0) {
    const emptyEl = document.createElement("div");
    emptyEl.className = "no-schedules";
    emptyEl.id = "noSchedulesMsg";
    emptyEl.textContent = "No recurring schedules set";
    schedulesList.appendChild(emptyEl);
    return;
  }

  schedules.forEach(sched => {
    const card = document.createElement("div");
    card.className = `schedule-card ${sched.enabled ? "" : "disabled"}`;
    card.dataset.id = sched.id;

    const mainInfo = document.createElement("div");
    mainInfo.className = "schedule-main-info";

    const timeRow = document.createElement("div");
    timeRow.className = "schedule-time-row";

    const timeText = document.createElement("span");
    timeText.className = "schedule-time-text";
    timeText.textContent = formatTime12h(sched.time);

    const actionTag = document.createElement("span");
    const isOff = (sched.action || "OFF").toUpperCase() === "OFF";
    actionTag.className = `schedule-action-tag ${isOff ? "action-off" : "action-on"}`;
    actionTag.textContent = isOff ? "TURN OFF" : "TURN ON";

    timeRow.appendChild(timeText);
    timeRow.appendChild(actionTag);
    mainInfo.appendChild(timeRow);

    const daysRow = document.createElement("div");
    daysRow.className = "schedule-days-row";
    const schedDays = sched.days || [];
    DAY_NAMES.forEach((name, idx) => {
      const chip = document.createElement("span");
      chip.className = `schedule-day-chip ${schedDays.includes(idx) ? "active" : ""}`;
      chip.textContent = name;
      daysRow.appendChild(chip);
    });
    mainInfo.appendChild(daysRow);

    if (sched.label) {
      const labelText = document.createElement("span");
      labelText.className = "schedule-label-text";
      labelText.textContent = sched.label;
      mainInfo.appendChild(labelText);
    }

    const actionsRow = document.createElement("div");
    actionsRow.className = "schedule-actions-row";

    // iOS style toggle switch
    const switchLabel = document.createElement("label");
    switchLabel.className = "switch";
    const switchInput = document.createElement("input");
    switchInput.type = "checkbox";
    switchInput.checked = !!sched.enabled;
    switchInput.addEventListener("change", (e) => {
      e.stopPropagation();
      if (!requireOnline()) {
        switchInput.checked = !switchInput.checked;
        return;
      }
      triggerHaptic();
      toggleSchedule(sched.id);
    });
    const sliderSpan = document.createElement("span");
    sliderSpan.className = "slider";
    switchLabel.appendChild(switchInput);
    switchLabel.appendChild(sliderSpan);

    // Delete button
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "schedule-delete-btn";
    deleteBtn.setAttribute("aria-label", "Delete Schedule");
    deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      triggerHaptic();
      if (confirm(`Delete schedule for ${formatTime12h(sched.time)}?`)) {
        deleteSchedule(sched.id);
      }
    });

    actionsRow.appendChild(switchLabel);
    actionsRow.appendChild(deleteBtn);

    card.appendChild(mainInfo);
    card.appendChild(actionsRow);
    schedulesList.appendChild(card);
  });
}

function setCountdownTimer(minutes, action = "OFF") {
  if (minutes > 0 && !requireOnline()) return;
  triggerHaptic();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      action: "set_countdown",
      value: { minutes, action }
    }));
  } else {
    fetch("/api/timers/countdown", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minutes, action })
    }).then(r => r.json()).then(d => {
      if (d.timers) renderTimers(d.timers);
    }).catch(err => console.warn("Failed setting countdown:", err));
  }
}

function toggleSchedule(id) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "toggle_schedule", value: id }));
  } else {
    fetch(`/api/timers/schedule/${id}/toggle`, { method: "POST" })
      .then(r => r.json())
      .then(d => { if (d.timers) renderTimers(d.timers); })
      .catch(err => console.warn("Failed toggling schedule:", err));
  }
}

function deleteSchedule(id) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: "delete_schedule", value: id }));
  } else {
    fetch(`/api/timers/schedule/${id}`, { method: "DELETE" })
      .then(r => r.json())
      .then(d => { if (d.timers) renderTimers(d.timers); })
      .catch(err => console.warn("Failed deleting schedule:", err));
  }
}

// Send Command via WebSocket
function sendAction(action, value) {
  if (!requireOnline()) return;
  triggerHaptic();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action, value }));
  } else {
    fetch("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [action.replace("set_", "")]: value })
    })
    .then(async res => {
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(err.detail || "Command failed: ESP32 offline");
      }
    })
    .catch(err => console.warn("HTTP fallback failed:", err));
  }
}

// WebSocket Connection Setup
function connectWebSocket() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  statusText.textContent = "Connecting...";
  statusDot.className = "status-dot";

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("Connected to AC WebSocket Server");
    reconnectInterval = 1500;
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "state_update") {
        if (msg.data) renderState(msg.data);
        if (msg.timers) renderTimers(msg.timers);
      } else if (msg.type === "error") {
        showToast(msg.message || "Command rejected: ESP32 is offline");
      }
    } catch (e) {
      console.error("Message parse error:", e);
    }
  };

  ws.onclose = () => {
    console.warn("WebSocket closed. Reconnecting in", reconnectInterval, "ms");
    statusDot.className = "status-dot offline";
    statusText.textContent = "Disconnected";
    setTimeout(connectWebSocket, reconnectInterval);
    reconnectInterval = Math.min(reconnectInterval * 1.5, 6000);
  };

  ws.onerror = (err) => {
    console.error("WebSocket error:", err);
    ws.close();
  };
}

// Event Listeners for Core Controls
btnPower.addEventListener("click", () => {
  if (!requireOnline()) return;
  const nextPower = currentACState.power === "ON" ? "OFF" : "ON";
  sendAction("set_power", nextPower);
});

btnTempUp.addEventListener("click", () => {
  if (!requireOnline()) return;
  const current = Math.round(Number(currentACState.target_temperature) || 24);
  const nextTemp = Math.min(30, current + 1);
  sendAction("set_temp", nextTemp);
});

btnTempDown.addEventListener("click", () => {
  if (!requireOnline()) return;
  const current = Math.round(Number(currentACState.target_temperature) || 24);
  const nextTemp = Math.max(16, current - 1);
  sendAction("set_temp", nextTemp);
});

modeButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    if (!requireOnline()) return;
    const mode = btn.dataset.mode;
    sendAction("set_mode", mode);
  });
});

fanButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    if (!requireOnline()) return;
    const fan = btn.dataset.fan;
    // If power is OFF, turn ON so fan speed takes effect on the AC
    if (currentACState.power === "OFF") {
      sendAction("set_power", "ON");
    }
    // In dry mode, fan speed is locked by Fujitsu; switch to cool so fan speed applies
    if (currentACState.mode === "dry") {
      sendAction("set_mode", "cool");
    }
    sendAction("set_fan", fan);
  });
});

presetButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    if (!requireOnline()) return;
    const temp = parseInt(btn.dataset.preset, 10);
    sendAction("set_temp", temp);
    sendAction("set_power", "ON");
  });
});

// Timer Event Listeners
document.querySelectorAll(".timer-pill[data-mins]").forEach(btn => {
  btn.addEventListener("click", () => {
    if (!requireOnline()) return;
    const mins = parseInt(btn.dataset.mins, 10);
    setCountdownTimer(mins, "OFF");
  });
});

btnCancelCountdown.addEventListener("click", () => {
  setCountdownTimer(0, "OFF");
  activeCountdownBanner.classList.add("hidden");
});

// Custom Countdown Modal Handlers
let selectedCustomCountdownAction = "OFF";
btnCustomCountdown.addEventListener("click", () => {
  if (!requireOnline()) return;
  triggerHaptic();
  countdownModal.showModal();
});
btnCloseCountdownModal.addEventListener("click", () => countdownModal.close());
btnCancelCustomCountdown.addEventListener("click", () => countdownModal.close());

btnCustomActionOff.addEventListener("click", () => {
  selectedCustomCountdownAction = "OFF";
  btnCustomActionOff.classList.add("active");
  btnCustomActionOn.classList.remove("active");
});
btnCustomActionOn.addEventListener("click", () => {
  selectedCustomCountdownAction = "ON";
  btnCustomActionOn.classList.add("active");
  btnCustomActionOff.classList.remove("active");
});

btnMinMins.addEventListener("click", () => {
  const cur = parseInt(customMinutesInput.value, 10) || 45;
  customMinutesInput.value = Math.max(1, cur - 15);
});
btnPlusMins.addEventListener("click", () => {
  const cur = parseInt(customMinutesInput.value, 10) || 45;
  customMinutesInput.value = Math.min(720, cur + 15);
});

countdownForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const mins = parseInt(customMinutesInput.value, 10);
  if (mins > 0) {
    setCountdownTimer(mins, selectedCustomCountdownAction);
  }
  countdownModal.close();
});

// Schedule Modal Handlers
let selectedScheduleAction = "OFF";
btnAddSchedule.addEventListener("click", () => {
  triggerHaptic();
  scheduleModal.showModal();
});
btnCloseScheduleModal.addEventListener("click", () => scheduleModal.close());
btnCancelSchedule.addEventListener("click", () => scheduleModal.close());

actionBtnOff.addEventListener("click", () => {
  selectedScheduleAction = "OFF";
  actionBtnOff.classList.add("active");
  actionBtnOn.classList.remove("active");
});
actionBtnOn.addEventListener("click", () => {
  selectedScheduleAction = "ON";
  actionBtnOn.classList.add("active");
  actionBtnOff.classList.remove("active");
});

dayButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    btn.classList.toggle("active");
  });
});

selectEveryday.addEventListener("click", () => {
  dayButtons.forEach(b => b.classList.add("active"));
});
selectWeekdays.addEventListener("click", () => {
  dayButtons.forEach((b, idx) => b.classList.toggle("active", idx <= 4));
});
selectWeekends.addEventListener("click", () => {
  dayButtons.forEach((b, idx) => b.classList.toggle("active", idx >= 5));
});

scheduleForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const timeVal = scheduleTime.value;
  const labelVal = scheduleLabel.value.trim();
  const activeDays = [];
  dayButtons.forEach(b => {
    if (b.classList.contains("active")) {
      activeDays.push(parseInt(b.dataset.day, 10));
    }
  });

  if (activeDays.length === 0) {
    alert("Please select at least one day for the schedule.");
    return;
  }

  const newSchedule = {
    time: timeVal,
    action: selectedScheduleAction,
    days: activeDays,
    enabled: true,
    label: labelVal
  };

  fetch("/api/timers/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(newSchedule)
  }).then(r => r.json()).then(d => {
    if (d.timers) renderTimers(d.timers);
  }).catch(err => console.warn("Failed saving schedule:", err));

  scheduleModal.close();
});

// Initial load
window.addEventListener("DOMContentLoaded", () => {
  connectWebSocket();

  // Fetch initial state
  fetch("/api/status")
    .then(r => r.json())
    .then(data => renderState(data))
    .catch(err => console.log("Init status fetch:", err));

  // Fetch initial timers
  fetch("/api/timers")
    .then(r => r.json())
    .then(data => renderTimers(data))
    .catch(err => console.log("Init timers fetch:", err));

  // Register PWA service worker if available
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(err => console.log("SW error:", err));
  }
});
