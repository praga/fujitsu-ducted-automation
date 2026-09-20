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
  is_simulated: false,
  controller_role: "secondary"
};

// DOM Elements
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

const modeButtons = document.querySelectorAll(".control-btn");
const fanButtons = document.querySelectorAll(".fan-btn");
const presetButtons = document.querySelectorAll(".preset-pill");

// Mode visual properties
const modeDetails = {
  cool: { name: "COOLING", color: "#00d2ff", glow: "rgba(0, 210, 255, 0.3)" },
  heat: { name: "HEATING", color: "#ff6b35", glow: "rgba(255, 107, 53, 0.3)" },
  dry: { name: "DRYING", color: "#00c9a7", glow: "rgba(0, 201, 167, 0.3)" },
  fan_only: { name: "FAN ONLY", color: "#a78bfa", glow: "rgba(167, 139, 250, 0.3)" },
  auto: { name: "AUTO CLIMATE", color: "#10b981", glow: "rgba(16, 185, 129, 0.3)" },
};

function triggerHaptic() {
  if (navigator.vibrate) {
    try {
      navigator.vibrate(15);
    } catch (e) {}
  }
}

// Update UI to match current state
function renderState(state) {
  currentACState = { ...currentACState, ...state };

  // Room Temp
  if (currentACState.current_temperature !== undefined) {
    roomTempEl.textContent = Number(currentACState.current_temperature).toFixed(1);
  }

  // Target Temp
  if (currentACState.target_temperature !== undefined) {
    targetTempEl.textContent = Number(currentACState.target_temperature).toFixed(1);
  }

  // Power
  const isPowerOn = currentACState.power === "ON";
  btnPower.classList.toggle("on", isPowerOn);
  powerText.textContent = isPowerOn ? "ON" : "OFF";
  tempDial.classList.toggle("power-off", !isPowerOn);

  // Mode Theme & Badge
  const curMode = currentACState.mode || "cool";
  const details = modeDetails[curMode] || modeDetails.cool;
  activeModeBadge.textContent = isPowerOn ? details.name : "STANDBY";
  
  // Set dynamic CSS variables for theme glow
  document.documentElement.style.setProperty("--active-color", details.color);
  document.documentElement.style.setProperty("--active-glow", details.glow);

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
  } else if (currentACState.device_online) {
    statusDot.classList.add("online");
    statusText.textContent = "Live • 3-Wire Sync";
  } else {
    statusDot.classList.add("offline");
    statusText.textContent = "ESP32 Offline";
  }

  if (currentACState.controller_role) {
    controllerRole.textContent = currentACState.controller_role === "secondary" ? "Secondary Remote (Wall Active)" : "Master Remote";
  }

  // Last update timestamp
  const now = new Date();
  lastSyncText.textContent = `Synced at ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

// Send Command via WebSocket
function sendAction(action, value) {
  triggerHaptic();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action, value }));
  } else {
    // Fallback to REST API if WebSocket is reconnecting
    fetch("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [action.replace("set_", "")]: value })
    }).catch(err => console.warn("HTTP fallback failed:", err));
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
      if (msg.type === "state_update" && msg.data) {
        renderState(msg.data);
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

// Event Listeners
btnPower.addEventListener("click", () => {
  const nextPower = currentACState.power === "ON" ? "OFF" : "ON";
  renderState({ power: nextPower });
  sendAction("set_power", nextPower);
});

btnTempUp.addEventListener("click", () => {
  const nextTemp = Math.min(30.0, Math.round((currentACState.target_temperature + 0.5) * 10) / 10);
  renderState({ target_temperature: nextTemp });
  sendAction("set_temp", nextTemp);
});

btnTempDown.addEventListener("click", () => {
  const nextTemp = Math.max(16.0, Math.round((currentACState.target_temperature - 0.5) * 10) / 10);
  renderState({ target_temperature: nextTemp });
  sendAction("set_temp", nextTemp);
});

modeButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;
    renderState({ mode });
    sendAction("set_mode", mode);
  });
});

fanButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const fan = btn.dataset.fan;
    renderState({ fan_mode: fan });
    sendAction("set_fan", fan);
  });
});

presetButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    const temp = parseFloat(btn.dataset.preset);
    renderState({ target_temperature: temp, power: "ON" });
    sendAction("set_temp", temp);
    sendAction("set_power", "ON");
  });
});

// Initial load
window.addEventListener("DOMContentLoaded", () => {
  connectWebSocket();

  // Register PWA service worker if available
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(err => console.log("SW error:", err));
  }
});
