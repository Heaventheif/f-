"use strict";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./atomicFile.js";

export function collectHealth(g = globalThis) {
  const mqtt = g.botApi?.__mqttManager?.health?.() || g.botApi?.__mqttHealth || {};
  const lastEventAt = mqtt.lastEventAt || g.__lastEventAt || 0;
  const mem = process.memoryUsage();
  return {
    ts: Date.now(), uptimeSec: Math.floor(process.uptime()), mqttState: mqtt.state || "NO_BOT",
    staleSec: lastEventAt ? Math.floor((Date.now() - lastEventAt) / 1000) : null,
    rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576),
    commands: g.commands?.size ?? 0, cacheEntries: g.__cacheSize?.() ?? null,
  };
}
export function startHealthWriter({ file = process.env.HEALTH_FILE || path.join(process.cwd(), "data", "health.json"), intervalMs = 30000 } = {}) {
  const tick = () => { try { atomicWriteJson(file, collectHealth(), { backup: false }); } catch { /* disk full etc. */ } };
  tick(); const t = setInterval(tick, intervalMs); t.unref?.(); return t;
}
