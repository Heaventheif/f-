"use strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
const BOT_TMP_PREFIXES = [
  "fb_", "pin_", "tumblr_", "sc_", "tts_", "ydl_", "yt_", "yt2_", "yt_a_", "yt_v_",
  "manga_", "manga_3asq_", "comic_", "slap_", "canva_", "imagine_", "autodl_img_",
  "subtitled_", "media_", "groq-tts-", "song-",
];
function cleanupOrphanTempFiles() {
  try {
    const dir = os.tmpdir();
    const now = Date.now();
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!BOT_TMP_PREFIXES.some(p => name.startsWith(p))) continue;
      const fp = path.join(dir, name);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > 60 * 60 * 1000) {
          fs.removeSync(fp);
          removed++;
        }
      } catch (_) {}
    }
    if (removed) console.log(`[CLEANUP] 🗑️ حُذف ${removed} ملف مؤقت يتيم`);
  } catch (e) {
    console.warn("[CLEANUP] ⚠️ فشل تنظيف الملفات المؤقتة:", e.message);
  }
}
global.cleanupOrphanTempFiles = cleanupOrphanTempFiles;
export { cleanupOrphanTempFiles };

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-utils-temp-cleanup',
  meta: { category: 'utils', path: 'src/utils/tempCleanup.js' },
  setup(_ctx) {
    // provides: cleanupOrphanTempFiles
  },
};
