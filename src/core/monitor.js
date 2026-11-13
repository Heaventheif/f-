"use strict";
import { stat } from "node:fs/promises";
import { STATE_FILE, getPersistInfo } from "../fca/appStatePersist.js";
import { safeFetch } from "../net/safeFetch.js";

// Default matches render.yaml (MONITOR_INTERVAL_MIN=30).
const CHECK_MS = (parseInt(process.env.MONITOR_INTERVAL_MIN ?? "30", 10) || 30) * 6e4;
const DEDUP_MS = 30 * 6e4;
export const THRESHOLDS = {
  maxConsecErrors: parseInt(process.env.MONITOR_MAX_CONSEC_ERR ?? "3", 10),
  maxReconnectsPerH: parseInt(process.env.MONITOR_MAX_RECONNECTS ?? "5", 10),
  maxMemMB: parseInt(process.env.MONITOR_MAX_MEM_MB ?? "400", 10),
  stateMaxAgeMs: 3 * 60 * 6e4,
};
const BOOT_AT = Date.now();
const _alertHistory = new Map();
const _registry = new Map(); // label -> api

function _shouldAlert(key, now = Date.now()) {
  const last = _alertHistory.get(key) ?? 0;
  if (now - last < DEDUP_MS) return false;
  _alertHistory.set(key, now);
  return true;
}

// Pure: turn a health snapshot into alert candidates (key + message). No I/O, no dedup.
export function evaluateHealth({ label, h = {}, memMB = 0, rph = 0, stateAgeMs = 0, thresholds = THRESHOLDS }) {
  const out = [];
  const connecting = h.state === "CONNECTING" || h.state === "RECONNECTING" || h.state === "RECONNECT_WAIT";
  if (!h.ok && !connecting && h.state !== "AUTH_FAILED" && h.state !== "STOPPED")
    out.push({ key: `mqtt_${label}`, msg: `⚠️ ${label}: MQTT غير صحية — state=${h.state}` });
  if ((h.consecutiveErrors ?? 0) >= thresholds.maxConsecErrors)
    out.push({ key: `err_${label}`, msg: `⚠️ ${label}: ${h.consecutiveErrors} أخطاء متتالية` });
  if (h.state === "AUTH_FAILED")
    out.push({ key: `auth_${label}`, msg: `🔒 ${label}: AUTH_FAILED — AppState محجوبة` });
  if (memMB > thresholds.maxMemMB)
    out.push({ key: `mem_${label}`, msg: `⚠️ ${label}: ذاكرة عالية ${memMB.toFixed(0)}MB` });
  if (rph > thresholds.maxReconnectsPerH)
    out.push({ key: `rph_${label}`, msg: `⚠️ ${label}: ${rph} إعادة اتصال في الساعة` });
  if (stateAgeMs > thresholds.stateMaxAgeMs)
    out.push({
      key: `state_${label}`,
      msg: `⚠️ ${label}: لم يُتحقق من ملف الحالة بنجاح منذ ${(stateAgeMs / 36e5).toFixed(1)}h`,
    });
  return out;
}

// Age of the AppState persistence: measured from the last SUCCESSFUL check (an unchanged hash
// is still a successful check) or the last file write, whichever is newer.
export function computeStateAge({ now, lastSuccessfulCheckAt, lastSaveAt, fileMtimeMs }) {
  const newest = Math.max(lastSuccessfulCheckAt || 0, lastSaveAt || 0, fileMtimeMs || 0);
  return newest ? Math.max(0, now - newest) : 0; // nothing yet = no evidence of staleness
}

async function _dm(api, msg) {
  try {
    const adminId = String(
      global.config?.admins?.[0] ?? global.config?.developers?.[0] ?? "",
    ).trim();
    if (!adminId) return;
    await new Promise((res, rej) =>
      api.sendMessage(`🔔 ${msg}`, adminId, (e) => (e ? rej(e) : res())),
    );
  } catch (e) {
    console.warn("[MONITOR] DM failed:", e?.message || e);
  }
}

async function _webhook(msg) {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  try {
    await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: msg, content: msg }), // Slack + Discord style
      timeoutMs: 8000,
    });
  } catch (e) {
    console.warn("[MONITOR] webhook failed:", e?.code || e?.message || e);
  }
}

export async function sendAlert(api, msg) {
  console.log(`[MONITOR] ✉️ ${msg}`);
  await Promise.allSettled([_dm(api, msg), _webhook(msg)]);
}

// Snapshot for /health style endpoints.
export function getHealth() {
  const api = global.botApi ?? [..._registry.values()][0] ?? null;
  const h = api?.__mqttManager?.health?.() ?? api?.__mqttHealth ?? null;
  return {
    mqtt: h?.ok === true,
    state: h?.state ?? "NO_BOT",
    lastEventAt: h?.lastEventAt ?? null,
    uptime: Math.round((Date.now() - BOOT_AT) / 1000),
  };
}

export function startMonitoring(api, botIndex, label) {
  label = label || `Bot-${botIndex}`;
  let rph = 0,
    prevTotal = 0;
  _registry.set(label, api);
  const resetRph = setInterval(() => {
    rph = 0;
  }, 36e5);
  resetRph.unref?.();
  const timer = setInterval(async () => {
    try {
      const h = api.__mqttManager?.health?.() ?? api.__mqttHealth ?? {};
      const mem = process.memoryUsage().rss / 1048576;
      const delta = Math.max(0, (h.totalReconnects ?? 0) - prevTotal);
      prevTotal = h.totalReconnects ?? 0;
      rph += delta;
      console.log(
        `[MONITOR:${label}] state=${h.state ?? "?"} ok=${h.ok} events=${h.eventsReceived ?? 0} reconn=${h.totalReconnects ?? 0} mem=${mem.toFixed(0)}MB`,
      );
      let fileMtimeMs = 0;
      try {
        fileMtimeMs = (await stat(STATE_FILE)).mtimeMs;
      } catch (_) {}
      const info = getPersistInfo();
      const stateAgeMs = computeStateAge({
        now: Date.now(),
        lastSuccessfulCheckAt: info.lastSuccessfulCheckAt,
        lastSaveAt: info.lastSaveAt,
        fileMtimeMs,
      });
      for (const a of evaluateHealth({ label, h, memMB: mem, rph, stateAgeMs })) {
        if (_shouldAlert(a.key)) await sendAlert(api, a.msg);
      }
    } catch (e) {
      console.warn(`[MONITOR:${label}] خطأ:`, e.message);
    }
  }, CHECK_MS);
  timer.unref?.();
  console.log(`[MONITOR:${label}] ▶️ المراقبة نشطة (كل ${CHECK_MS / 6e4} دقيقة)`);
  return function stopMonitoring() {
    clearInterval(timer);
    clearInterval(resetRph);
    _registry.delete(label);
    console.log(`[MONITOR:${label}] ⏹️ المراقبة متوقفة`);
  };
}
export default startMonitoring;
