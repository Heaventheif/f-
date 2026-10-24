"use strict";
/**
 * src/core/monitor.js — مراقبة الصحة + تنبيه المشرف
 * ─────────────────────────────────────────────────────
 * مُجمَّع من: fca-unofficial Watchdog + nkxfca healthcheck + تصميم مخصَّص
 */

import fs   from "node:fs";
import { STATE_FILE } from "../fca/appStatePersist.js";

const CHECK_MS  = (parseInt(process.env.MONITOR_INTERVAL_MIN ?? "15", 10) || 15) * 60_000;
const DEDUP_MS  = 30 * 60_000;

const THRESHOLDS = {
  maxConsecErrors:   parseInt(process.env.MONITOR_MAX_CONSEC_ERR  ?? "3",   10),
  maxReconnectsPerH: parseInt(process.env.MONITOR_MAX_RECONNECTS  ?? "5",   10),
  maxMemMB:          parseInt(process.env.MONITOR_MAX_MEM_MB      ?? "400", 10),
  stateMaxAgeMs:     3 * 60 * 60_000,
};

const _alertHistory = new Map();

function _shouldAlert(key) {
  const last = _alertHistory.get(key) ?? 0;
  if (Date.now() - last < DEDUP_MS) return false;
  _alertHistory.set(key, Date.now()); return true;
}

async function _dm(api, msg) {
  try {
    const adminId = String(global.config?.admins?.[0] ?? global.config?.developers?.[0] ?? "").trim();
    if (!adminId) return;
    await new Promise((res, rej) =>
      api.sendMessage(`🔔 ${msg}`, adminId, (e) => e ? rej(e) : res())
    );
    console.log(`[MONITOR] ✉️ ${msg}`);
  } catch (_) {}
}

export function startMonitoring(api, botIndex, label) {
  label = label || `Bot-${botIndex}`;
  let rph = 0, prevTotal = 0;
  const resetRph = setInterval(() => { rph = 0; }, 3_600_000);
  resetRph?.unref?.();

  const timer = setInterval(async () => {
    try {
      const h   = api.__mqttHealth ?? {};
      const mem = process.memoryUsage().rss / 1_048_576;

      // تتبع إعادة الاتصال في الساعة
      const delta = Math.max(0, (h.totalReconnects ?? 0) - prevTotal);
      prevTotal = h.totalReconnects ?? 0;
      rph += delta;

      // سجّل الصحة
      console.log(`[MONITOR:${label}] state=${h.state ?? "?"} ok=${h.ok} events=${h.eventsReceived ?? 0} reconn=${h.totalReconnects ?? 0} mem=${mem.toFixed(0)}MB`);

      // تحقق من الشروط
      const checks = [];
      if (!h.ok && _shouldAlert(`mqtt_${label}`))
        checks.push(`⚠️ ${label}: MQTT غير صحية — state=${h.state}`);
      if ((h.consecutiveErrors ?? 0) >= THRESHOLDS.maxConsecErrors && _shouldAlert(`err_${label}`))
        checks.push(`⚠️ ${label}: ${h.consecutiveErrors} أخطاء متتالية`);
      if (h.state === "AUTH_FAILED" && _shouldAlert(`auth_${label}`))
        checks.push(`🔒 ${label}: AUTH_FAILED — AppState محجوبة`);
      if (mem > THRESHOLDS.maxMemMB && _shouldAlert(`mem_${label}`))
        checks.push(`⚠️ ${label}: ذاكرة عالية ${mem.toFixed(0)}MB`);
      if (rph > THRESHOLDS.maxReconnectsPerH && _shouldAlert(`rph_${label}`))
        checks.push(`⚠️ ${label}: ${rph} إعادة اتصال في الساعة`);
      // فحص عمر ملف الحالة
      try {
        if (fs.existsSync(STATE_FILE)) {
          const age = Date.now() - fs.statSync(STATE_FILE).mtimeMs;
          if (age > THRESHOLDS.stateMaxAgeMs && _shouldAlert(`state_${label}`))
            checks.push(`⚠️ ${label}: ملف الحالة لم يُحدَّث منذ ${(age / 3_600_000).toFixed(1)}h`);
        }
      } catch (_) {}

      for (const msg of checks) await _dm(api, msg);
    } catch (e) {
      console.warn(`[MONITOR:${label}] خطأ:`, e.message);
    }
  }, CHECK_MS);

  timer?.unref?.();
  console.log(`[MONITOR:${label}] ▶️ المراقبة نشطة (كل ${CHECK_MS / 60_000} دقيقة)`);

  return function stopMonitoring() {
    clearInterval(timer);
    clearInterval(resetRph);
    console.log(`[MONITOR:${label}] ⏹️ المراقبة متوقفة`);
  };
}

export default startMonitoring;
