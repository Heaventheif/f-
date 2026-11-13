"use strict";
import cache from "../utils/cache.js";
import { sweepStaleRoots } from "../io/tmp.js";

const TEN_MIN = 10 * 60 * 1e3;
let _handle = null;
let _running = false;

// Kept export name; now delegates to the per-process temp root sweeper.
export async function cleanupOrphanTempFiles() {
  try {
    const n = await sweepStaleRoots();
    if (n) console.log(`[CLEANUP] 🗑️ حُذف ${n} مجلد مؤقت قديم`);
    return n;
  } catch (e) {
    console.warn("[CLEANUP] ⚠️ فشل تنظيف الملفات المؤقتة:", e?.message);
    return 0;
  }
}

async function cleanupOnce() {
  const now = Date.now();
  let cleaned = 0;
  const replies = global.Kagenou?.replies ?? {};
  for (const [id, data] of Object.entries(replies)) {
    if (!data._busy && now - (data.timestamp || 0) > TEN_MIN) {
      delete replies[id];
      cleaned++;
    }
  }
  try {
    cleaned += global.sweepCooldowns?.(now) ?? 0;
  } catch {}
  // Persist unsaved user data before any eviction; never drop dirty entries.
  try {
    await global.flushUsersData?.();
  } catch (e) {
    console.warn("[CLEANUP] flush usersData failed:", e?.message);
  }
  for (const [uid, data] of global.usersData?.entries?.() ?? []) {
    if (!data._dirty && data._lastSeen && now - data._lastSeen > 60 * 60 * 1e3) {
      global.usersData.delete(uid);
      cleaned++;
    }
  }
  for (const [msgID, ts] of global._reactionTimestamps?.entries?.() ?? []) {
    if (now - ts > TEN_MIN) {
      delete global.client.reactionListener[msgID];
      global._reactionTimestamps.delete(msgID);
      cleaned++;
    }
  }
  await cleanupOrphanTempFiles();
  try {
    cleaned += cache.sweep();
  } catch (_) {}
  try {
    cleaned += global.cleanupIdleThreadGates?.() ?? 0;
  } catch (_) {}
  const mem = process.memoryUsage();
  const pm = global.perfManager?.getMetrics();
  console.log(
    `[CLEANUP] 🧹 ${cleaned} مدخلة | RSS: ${Math.round(mem.rss / 1024 / 1024)}MB | Heap: ${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB` +
      (pm ? ` | avg: ${pm.avgResponseTimeMs}ms | errors: ${pm.errorCount}` : "") +
      ` | Bots: ${global.botApis?.length ?? 0}`,
  );
}

export function stopCleanupInterval() {
  if (_handle) clearInterval(_handle);
  _handle = null;
}
// Idempotent: a second call replaces the timer instead of stacking intervals.
export function startCleanupInterval() {
  stopCleanupInterval();
  _handle = setInterval(async () => {
    if (_running) return;
    _running = true;
    try {
      await cleanupOnce();
    } catch (e) {
      console.error("[CLEANUP] error:", e?.message ?? e);
    } finally {
      _running = false;
    }
  }, TEN_MIN);
  _handle.unref?.();
  return { stop: stopCleanupInterval };
}
