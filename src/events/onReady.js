"use strict";
import cache from "../utils/cache.js";
import { cleanupOrphanTempFiles } from "../utils/tempCleanup.js";

export function startCleanupInterval() {
  setInterval(() => {
    const now     = Date.now();
    let   cleaned = 0;
    for (const [id, data] of Object.entries(global.Kagenou.replies)) {
      if (now - (data.timestamp || 0) > 10 * 60 * 1000) {
        delete global.Kagenou.replies[id]; cleaned++;
      }
    }
    for (const [key, exp] of global.userCooldowns.entries()) {
      if (now >= exp) { global.userCooldowns.delete(key); cleaned++; }
    }
    for (const [uid, data] of global.usersData.entries()) {
      if (data._lastSeen && now - data._lastSeen > 60 * 60 * 1000) {
        global.usersData.delete(uid); cleaned++;
      }
    }
    for (const [msgID, ts] of global._reactionTimestamps.entries()) {
      if (now - ts > 10 * 60 * 1000) {
        delete global.client.reactionListener[msgID];
        global._reactionTimestamps.delete(msgID);
        cleaned++;
      }
    }
    cleanupOrphanTempFiles();
    try { cleaned += cache.sweep(); } catch (_) {}
    try { cleaned += global.cleanupIdleThreadGates(); } catch (_) {}
    const mem = process.memoryUsage();
    const pm  = global.perfManager?.getMetrics();
    console.log(
      `[CLEANUP] 🧹 ${cleaned} مدخلة | RSS: ${Math.round(mem.rss/1024/1024)}MB` +
      ` | Heap: ${Math.round(mem.heapUsed/1024/1024)}/${Math.round(mem.heapTotal/1024/1024)}MB` +
      (pm ? ` | avg: ${pm.avgResponseTimeMs}ms | errors: ${pm.errorCount}` : "") +
      ` | Bots: ${global.botApis.length}`
    );
  // HIGH-03 FIX: .unref() يمنع دورة cleanup من
  // إبقاء العملية حية بعد SIGTERM في حالة التخلص اللطيف من الموارد.
}, 10 * 60 * 1000).unref();
}
