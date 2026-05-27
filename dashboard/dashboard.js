// dashboard.js — Sentinel Dashboard for edge monitoring with takeover alerts

const API_BASE = "http://10.204.16.158:5000/api";
const API_KEY = "SAVITHA_SENTINEL_DEMO";

let lastHeartbeat = null;
let knownEvents = new Set();
let knownSecurity = new Set();
let consecutiveErrors = 0;
let pollIntervalMs = 2000;

// Helper: add event to a feed
function addEvent(targetId, message, prefix = "", isSynced = false) {
  const feed = document.getElementById(targetId);
  if (!feed) return;

  const item = document.createElement("div");
  item.className = "event";

  const time = new Date().toLocaleTimeString();
  const syncedLabel = isSynced ? " [synced]" : "";
  const tag = prefix ? `[${prefix}] ` : "";

  item.innerText = `${time} - ${tag}${message}${syncedLabel}`;
  feed.prepend(item);
}

// Heartbeat age text
function heartbeatAgeText() {
  if (!lastHeartbeat) return "--";
  const seconds = Math.floor((Date.now() - lastHeartbeat) / 1000);
  return seconds + " sec";
}

// Update ONLINE / STALE / DISCONNECTED badge
function updateBadge(ageSeconds) {
  const badge = document.getElementById("globalStatus");
  if (!badge) return;

  if (ageSeconds < 15) {
    badge.innerText = "ONLINE";
    badge.className = "status-badge online";
  } else if (ageSeconds < 60) {
    badge.innerText = "STALE";
    badge.className = "status-badge offline";
  } else {
    badge.innerText = "DISCONNECTED";
    badge.className = "status-badge offline";
  }
}

// Is this a takeover / ownership-related alert?
function isTakeoverAlert(sec) {
  const t = (sec.type || "").toLowerCase();
  const msg = (sec.message || "").toLowerCase();
  if (!t && !msg) return false;

  if (t.includes("pair_rejected")) return true;
  if (t.includes("tamper_alert")) return true;
  if (t.includes("suspicious_event")) return true;
  if (t.includes("unpaired_heartbeat")) return true;

  if (msg.includes("unauthorized ownership") ||
      msg.includes("takeover") ||
      msg.includes("unpaired device token") ||
      msg.includes("suspicious event")) {
    return true;
  }
  return false;
}

// Main poll function
async function pollDashboard() {
  try {
    // STATUS
    const statusRes = await fetch(`${API_BASE}/status`, {
      headers: { "X-API-KEY": API_KEY }
    });
    if (!statusRes.ok) throw new Error(`Status ${statusRes.status}`);

    const status = await statusRes.json();

    document.getElementById("nodeId").innerText = status.device_id ?? "UNKNOWN";
    document.getElementById("mode").innerText = status.mode ?? "WAITING";
    document.getElementById("queueDepth").innerText = status.queue ?? 0;

    if (status.last_heartbeat) {
      const ts = new Date(status.last_heartbeat).getTime();
      if (!isNaN(ts)) lastHeartbeat = ts;
    }

    const age = lastHeartbeat ? Math.floor((Date.now() - lastHeartbeat) / 1000) : 9999;
    document.getElementById("heartbeatAge").innerText = heartbeatAgeText();
    updateBadge(age);

    // EVENTS + SECURITY
    const eventsRes = await fetch(`${API_BASE}/events`, {
      headers: { "X-API-KEY": API_KEY }
    });
    if (!eventsRes.ok) throw new Error(`Events ${eventsRes.status}`);

    const payload = await eventsRes.json();
    const now = Date.now();

    // Live event feed
    for (const ev of payload.events || []) {
      const evTime = new Date(ev.time).getTime();
      if (isNaN(evTime)) continue;

      const key = evTime + ev.message;
      if (!knownEvents.has(key)) {
        knownEvents.add(key);
        const isSynced = now - evTime > 10000;
        addEvent("eventFeed", ev.message, "", isSynced);
      }
    }

    // Security alerts, including takeover attempts
    const security = payload.security || [];
    const securityFeed = document.getElementById("securityAlerts");

    if (security.length > 0 && securityFeed && securityFeed.querySelectorAll(".event").length === 1) {
      // Clear default "No security alerts" message
      securityFeed.innerHTML = "";
    }

    for (const sec of security) {
      const secTime = new Date(sec.time).getTime();
      if (isNaN(secTime)) continue;

      const key = secTime + sec.message + (sec.type || "");
      if (knownSecurity.has(key)) continue;
      knownSecurity.add(key);

      const takeover = isTakeoverAlert(sec);
      const prefix = takeover ? "TAKEOVER" : "SECURITY";

      addEvent("securityAlerts", sec.message, prefix, false);

      // Optionally echo takeover alerts into the main event feed too
      if (takeover) {
        addEvent("eventFeed", sec.message, "TAKEOVER", false);
      }
    }

    // Success: reset error state
    consecutiveErrors = 0;
    pollIntervalMs = 2000;
  } catch (err) {
    console.error("Dashboard poll error:", err);

    const badge = document.getElementById("globalStatus");
    if (badge) {
      badge.innerText = "DISCONNECTED";
      badge.className = "status-badge offline";
    }

    if (consecutiveErrors === 0) {
      addEvent("eventFeed", `Dashboard disconnected: ${err.message}`, "ERROR", false);
    }

    consecutiveErrors++;
    pollIntervalMs = Math.min(Math.round(pollIntervalMs * 1.5), 30000);
  }
}

// Use dynamic backoff via setInterval + pollIntervalMs
setInterval(() => {
  pollDashboard();
}, pollIntervalMs);

// Initial call
pollDashboard();