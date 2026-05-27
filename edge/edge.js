const API_BASE = "http://10.204.16.158:5000/api";
const API_KEY = "SAVITHA_SENTINEL_DEMO";
const DEMO_PAIR_CODE = "DEMO2026";

let deviceToken = localStorage.getItem("edge_owner_token");
if (!deviceToken) {
  deviceToken = crypto.randomUUID();
  localStorage.setItem("edge_owner_token", deviceToken);
}

let paired = false;
let locked = false;
let stream = null;
let prevFrame = null;
let prevBrightness = null;
let freezeCounter = 0;
let lastEventTimes = {};
let offlineQueue = JSON.parse(localStorage.getItem("offline_queue") || "[]");
let detectionStarted = false;
let heartbeatStarted = false;

const video = document.getElementById("video");
const canvas = document.getElementById("analysisCanvas");
const ctx = canvas?.getContext("2d") || null;

const pairBtn = document.getElementById("pairBtn");
const pairCode = document.getElementById("pairCode");
const pairingPanel = document.getElementById("pairingPanel");

function logEvent(message) {
  const log = document.getElementById("eventLog");
  if (!log) return;
  const item = document.createElement("div");
  item.className = "event";
  item.innerText = new Date().toLocaleTimeString() + " - " + message;
  log.prepend(item);
}

function setMode(label, cls) {
  const badge = document.getElementById("modeBadge");
  if (!badge) return;
  badge.innerText = label;
  badge.className = "badge " + cls;
}

function setStatus(id, value) {
  const el = document.getElementById(id);
  if (el) el.innerText = value;
}

function updateQueueDisplay() {
  setStatus("queueStatus", `${offlineQueue.length} queued`);
  setStatus("queueDepth", offlineQueue.length);
}

function saveQueue() {
  localStorage.setItem("offline_queue", JSON.stringify(offlineQueue));
  updateQueueDisplay();
}

function queueEvent(endpoint, payload) {
  offlineQueue.push({
    endpoint,
    payload,
    ts: Date.now()
  });
  saveQueue();
}

async function postEvent(endpoint, payload) {
  const res = await fetch(`${API_BASE}/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": API_KEY
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${text}`);
  }

  return res.json().catch(() => ({}));
}

async function syncQueue() {
  if (!navigator.onLine || offlineQueue.length === 0) return;

  logEvent("Syncing queued events...");

  const pending = [...offlineQueue];
  offlineQueue = [];
  saveQueue();

  for (const item of pending) {
    try {
      await postEvent(item.endpoint, item.payload);
    } catch (err) {
      offlineQueue.push(item);
    }
  }

  saveQueue();

  if (offlineQueue.length === 0) {
    logEvent("Offline sync completed");
  }
}

function raiseEvent(type) {
  const now = Date.now();

  if (lastEventTimes[type] && now - lastEventTimes[type] < 8000) return;
  lastEventTimes[type] = now;

  const payload = {
    message: type,
    ts: now,
    owner_token: deviceToken,
    paired,
    locked
  };

  logEvent(type);
  queueEvent("event", payload);

  if (navigator.onLine) {
    syncQueue();
  }
}

async function requestPairing() {
  const code = pairCode?.value?.trim() || "";

  try {
    const result = await postEvent("pair", {
      pair_code: code,
      owner_token: deviceToken
    });

    paired = true;
    locked = !!result.locked;

    if (pairingPanel) pairingPanel.style.display = "none";

    if (locked) {
      logEvent("Ownership locked to this browser");
      setMode("ACTIVE", "active");
      setStatus("connectivityStatus", "Connected");
    } else {
      logEvent("Pair accepted without lock");
    }

    await syncQueue();
  } catch (err) {
    const msg = String(err.message || "");

    if (msg.includes("403")) {
      logEvent("Pair rejected: ownership locked elsewhere");
      setStatus("pairStatus", "Unauthorized ownership claim");
      setMode("LOCKED", "offline");
      setStatus("connectivityStatus", "Locked");
      locked = false;
    } else {
      logEvent("Pair failed");
      setStatus("pairStatus", "Pair failed");
    }
  }
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });

    if (video) video.srcObject = stream;

    setStatus("systemStatus", "Monitoring");
    setStatus("heartbeatStatus", "Active");
    setMode(navigator.onLine ? "ACTIVE" : "AUTONOMOUS", navigator.onLine ? "active" : "offline");

    logEvent("Camera initialized");

    if (!detectionStarted) {
      detectionStarted = true;
      startDetection();
    }

    if (!heartbeatStarted) {
      heartbeatStarted = true;
      startHeartbeatLoop();
    }
  } catch (err) {
    console.error("Camera error", err);
    setStatus("systemStatus", "Camera Error");
    setMode("ERROR", "offline");
  }
}

function startDetection() {
  setInterval(() => {
    if (video.videoWidth === 0 || !ctx) return;

    ctx.drawImage(video, 0, 0, 160, 120);
    const frame = ctx.getImageData(0, 0, 160, 120);
    const data = frame.data;

    let brightness = 0;
    let motion = 0;
    let edges = 0;

    for (let i = 0; i < data.length; i += 4) {
      const gray = data[i];
      brightness += gray;
      if (prevFrame) motion += Math.abs(gray - prevFrame[i]);
    }

    brightness /= (data.length / 4);

    for (let y = 1; y < 119; y++) {
      for (let x = 1; x < 159; x++) {
        const i = (y * 160 + x) * 4;
        const right = (y * 160 + (x + 1)) * 4;
        const down = ((y + 1) * 160 + x) * 4;

        const dx = Math.abs(data[i] - data[right]);
        const dy = Math.abs(data[i] - data[down]);

        if (dx + dy > 45) edges++;
      }
    }

    if (motion > 400000) raiseEvent("Motion detected");
    if (brightness < 25 || edges < 100) raiseEvent("Camera obstruction detected");

    if (prevBrightness !== null) {
      const delta = Math.abs(brightness - prevBrightness);
      if (delta > 60) raiseEvent("Camera tamper / tilt detected");
    }

    if (prevFrame) {
      if (motion < 5000) freezeCounter++;
      else freezeCounter = 0;

      if (freezeCounter >= 10) {
        raiseEvent("Camera freeze suspected");
        freezeCounter = 0;
      }
    }

    prevBrightness = brightness;
    prevFrame = new Uint8ClampedArray(data);
  }, 1000);
}

function startHeartbeatLoop() {
  setInterval(async () => {
    const mode = navigator.onLine ? "CONNECTED" : "AUTONOMOUS";

    try {
      const res = await postEvent("heartbeat", {
        mode,
        queue: offlineQueue.length,
        owner_token: deviceToken,
        paired,
        locked
      });

      if (res.locked) {
        locked = true;
        setMode("ACTIVE", "active");
      }
    } catch (err) {
      if (!navigator.onLine) {
        setMode("AUTONOMOUS", "offline");
        setStatus("connectivityStatus", "Autonomous");
      }
    }
  }, 3000);
}

window.addEventListener("offline", () => {
  setMode("AUTONOMOUS", "offline");
  setStatus("connectivityStatus", "Autonomous");
});

window.addEventListener("online", async () => {
  setMode("ACTIVE", "active");
  setStatus("connectivityStatus", locked ? "Locked" : "Connected");
  await syncQueue();
});

if (pairBtn && pairCode && pairingPanel) {
  pairBtn.addEventListener("click", requestPairing);
}

window.addEventListener("load", () => {
  setMode("AUTONOMOUS", "offline");
  setStatus("systemStatus", "Initializing camera...");
  setStatus("connectivityStatus", navigator.onLine ? "Connected" : "Autonomous");
  updateQueueDisplay();
  startCamera();
});