"use strict";
import { readdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import { sweepStaleRoots, tmpRoot } from "../io/tmp.js";

// Old prefix-based sweeping is gone: every temp file now lives under one per-process root.
// This removes roots left by dead processes plus stale files in the shared download dir of this one.
async function cleanupOrphanTempFiles(maxAgeMs = 60 * 60 * 1e3) {
  try {
    let removed = await sweepStaleRoots(maxAgeMs);
    const shared = path.join(await tmpRoot(), "dl");
    for (const name of await readdir(shared).catch(() => [])) {
      const fp = path.join(shared, name);
      const st = await stat(fp).catch(() => null);
      if (st && Date.now() - st.mtimeMs > maxAgeMs) { await rm(fp, { recursive: true, force: true }).catch(() => {}); removed++; }
    }
    if (removed) console.log(`[CLEANUP] حُذف ${removed} عنصر مؤقت يتيم`);
    return removed;
  } catch (e) {
    console.warn("[CLEANUP] فشل تنظيف الملفات المؤقتة:", e.message);
    return 0;
  }
}
global.cleanupOrphanTempFiles = cleanupOrphanTempFiles;
export { cleanupOrphanTempFiles };
