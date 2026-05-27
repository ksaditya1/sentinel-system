const express = require("express");
const path = require("path");
const cors = require("cors");

const app = express();

const API_KEY = process.env.API_KEY || "SAVITHA_SENTINEL_DEMO";
const PORT = process.env.PORT || 5000;
const PAIR_CODE = process.env.PAIR_CODE || "DEMO2026";
const HEARTBEAT_STALE_MS = Number(process.env.HEARTBEAT_STALE_MS || 15000);

app.use(cors());
app.use(express.json());

/*
====================================================
STATIC FILES
====================================================
*/
const dashboardPath = path.resolve(__dirname, "dashboard");
const edgePath = path.resolve(__dirname, "edge");

app.use("/dashboard", express.static(dashboardPath));
app.use("/edge", express.static(edgePath));

/*
====================================================
PAGES
====================================================
*/
app.get("/", (req, res) => {
  res.sendFile(path.join(dashboardPath, "dashboard.html"));
});

app.get("/dashboard", (req, res) => {
  res.sendFile(path.join(dashboardPath, "dashboard.html"));
});

app.get("/edge", (req, res) => {
  res.sendFile(path.join(edgePath, "edge.html"));
});

/*
====================================================
IN-MEMORY STORE
====================================================
*/
const devices = new Map();
const events = [];
const securityAlerts = [];
const MAX_EVENTS = 1000;

/*
====================================================
HELPERS
====================================================
*/
function verifyApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];

  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function isSecurityMessage(message) {
  const keywords = [
    "tamper",
    "tilt",
    "obstruction",
    "freeze",
    "motion",
    "takeover",
    "unauthorized"
  ];

  const lower = String(message || "").toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

function pushEvent(list, item) {
  list.unshift(item);
  if (list.length > MAX_EVENTS) list.pop();
}

function makeDeviceId(owner_token) {
  return `EDGE-${String(owner_token).slice(0, 8).toUpperCase()}`;
}

function addSecurityAlert(owner_token, message, extra = {}) {
  const alert = {
    time: new Date().toISOString(),
    owner_token,
    message,
    ...extra
  };

  pushEvent(securityAlerts, alert);
  pushEvent(events, alert);

  return alert;
}

function getLatestDevice() {
  const all = Array.from(devices.values());

  if (all.length === 0) return null;

  return all.sort((a, b) => {
    const at = a.last_heartbeat ? Date.parse(a.last_heartbeat) : 0;
    const bt = b.last_heartbeat ? Date.parse(b.last_heartbeat) : 0;
    return bt - at;
  })[0];
}

/*
====================================================
PAIRING
====================================================
*/
app.post("/api/pair", verifyApiKey, (req, res) => {
  const { pair_code, owner_token } = req.body || {};

  if (!pair_code || !owner_token) {
    return res.status(400).json({
      error: "Missing pair_code or owner_token"
    });
  }

  if (pair_code !== PAIR_CODE) {
    addSecurityAlert(owner_token, "Unauthorized ownership claim attempt", {
      type: "pair_rejected",
      reason: "invalid_pair_code"
    });

    return res.status(403).json({
      error: "Unauthorized ownership claim"
    });
  }

  const existing = devices.get(owner_token);

  if (!existing) {
    const device = {
      device_id: makeDeviceId(owner_token),
      owner_token,
      paired: true,
      paired_at: new Date().toISOString(),
      last_heartbeat: null,
      mode: "WAITING",
      queue: 0,
      locked: true,
      takeover_attempts: 0
    };

    devices.set(owner_token, device);

    return res.json({
      success: true,
      device_id: device.device_id,
      locked: true
    });
  }

  if (existing.locked && existing.owner_token === owner_token) {
    existing.paired = true;
    devices.set(owner_token, existing);

    return res.json({
      success: true,
      device_id: existing.device_id,
      locked: true
    });
  }

  addSecurityAlert(owner_token, "Unauthorized ownership claim attempt", {
    type: "pair_rejected",
    reason: "locked_by_other_owner"
  });

  return res.status(403).json({
    error: "Device already owned / locked"
  });
});

/*
====================================================
HEARTBEAT
====================================================
*/
app.post("/api/heartbeat", verifyApiKey, (req, res) => {
  const { mode, queue, owner_token, paired } = req.body || {};

  if (!owner_token) {
    return res.status(400).json({
      error: "Missing owner_token"
    });
  }

  const now = new Date().toISOString();
  const device = devices.get(owner_token);

  if (!device) {
    const deviceId = makeDeviceId(owner_token);

    devices.set(owner_token, {
      device_id: deviceId,
      owner_token,
      paired: false,
      paired_at: null,
      last_heartbeat: now,
      mode: mode || "AUTONOMOUS",
      queue: Number(queue || 0),
      locked: false,
      takeover_attempts: 0
    });

    addSecurityAlert(owner_token, "Heartbeat from unpaired device token", {
      type: "unpaired_heartbeat"
    });

    return res.json({
      success: true,
      paired: false,
      locked: false
    });
  }

  device.last_heartbeat = now;
  device.mode = mode || "AUTONOMOUS";
  device.queue = Number(queue || 0);
  device.paired = !!paired;
  device.locked = true;

  devices.set(owner_token, device);

  return res.json({
    success: true,
    paired: device.paired,
    locked: true
  });
});

/*
====================================================
EVENT INGEST
====================================================
*/
app.post("/api/event", verifyApiKey, (req, res) => {
  const { message, ts, owner_token, paired } = req.body || {};

  if (!message || !owner_token) {
    return res.status(400).json({
      error: "Missing message or owner_token"
    });
  }

  const device = devices.get(owner_token);
  const isTrusted =
    !!device &&
    device.locked &&
    device.owner_token === owner_token;

  const event = {
    time: new Date(ts || Date.now()).toISOString(),
    message,
    owner_token,
    paired: !!paired,
    trusted: isTrusted
  };

  pushEvent(events, event);

  if (isSecurityMessage(message) || !isTrusted) {
    pushEvent(securityAlerts, {
      time: event.time,
      owner_token,
      message: !isTrusted
        ? `Suspicious event from untrusted token: ${message}`
        : message,
      type: !isTrusted ? "suspicious_event" : "security_event"
    });
  }

  return res.json({
    success: true,
    trusted: isTrusted
  });
});

/*
====================================================
DASHBOARD API
====================================================
*/
app.get("/api/status", verifyApiKey, (req, res) => {
  const latest = getLatestDevice();

  if (!latest) {
    return res.json({
      device_id: "UNKNOWN",
      mode: "WAITING",
      queue: 0,
      last_heartbeat: null,
      locked: false,
      stale: true
    });
  }

  const last = latest.last_heartbeat
    ? Date.parse(latest.last_heartbeat)
    : 0;

  const stale =
    !last ||
    Date.now() - last > HEARTBEAT_STALE_MS;

  res.json({
    device_id: latest.device_id,
    mode: latest.mode,
    queue: latest.queue,
    last_heartbeat: latest.last_heartbeat,
    locked: latest.locked,
    stale
  });
});

app.get("/api/events", verifyApiKey, (req, res) => {
  res.json({
    events: events.slice(0, 100),
    security: securityAlerts.slice(0, 50)
  });
});

app.post("/api/tamper-alert", verifyApiKey, (req, res) => {
  const { owner_token, message } = req.body || {};

  if (!owner_token) {
    return res.status(400).json({
      error: "Missing owner_token"
    });
  }

  addSecurityAlert(owner_token, message || "Tamper/takeover alert", {
    type: "tamper_alert"
  });

  res.json({ success: true });
});

/*
====================================================
HEALTH
====================================================
*/
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString()
  });
});

/*
====================================================
START
====================================================
*/
app.listen(PORT, () => {
  console.log(`Sentinel backend running on port ${PORT}`);
  console.log(`Dashboard path: ${dashboardPath}`);
  console.log(`Edge path: ${edgePath}`);
});