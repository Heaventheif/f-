"use strict";
import fs from "fs-extra";
import os from "os";
import path from "path";
import { execFile } from "child_process";
const MAX_PART_BYTES = 24 * 1024 * 1024;
const TARGET_PART_BYTES = Math.floor(MAX_PART_BYTES * 0.9);
const MAX_SPLIT_ATTEMPTS = 3; 
function NEEDS_SPLIT(sizeBytes) {
  return sizeBytes > MAX_PART_BYTES;
}
function runFfprobe(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { timeout: 30000 },
      (err, stdout) => {
        if (err) return reject(err);
        const duration = parseFloat(String(stdout).trim());
        if (!duration || !isFinite(duration) || duration <= 0) {
          return reject(new Error("تعذّر قراءة مدة الملف عبر ffprobe"));
        }
        resolve(duration);
      }
    );
  });
}
function runFfmpegSegment(filePath, ext, segmentSeconds, outDir) {
  const pattern = path.join(outDir, `part_%03d.${ext}`);
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y", "-i", filePath,
        "-c", "copy",
        "-map", "0",
        "-f", "segment",
        "-segment_time", String(Math.max(1, Math.floor(segmentSeconds))),
        "-reset_timestamps", "1",
        pattern,
      ],
      { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 * 10 },
      (err, _stdout, stderr) => {
        if (err) return reject(new Error(`ffmpeg فشل: ${stderr?.toString().slice(-300) || err.message}`));
        resolve();
      }
    );
  });
}
async function segmentOnce(filePath, ext, size, workDir) {
  const duration = await runFfprobe(filePath);
  const bytesPerSecond = size / duration;
  const segmentSeconds = Math.max(1, TARGET_PART_BYTES / bytesPerSecond);
  await runFfmpegSegment(filePath, ext, segmentSeconds, workDir);
  const files = (await fs.readdir(workDir))
    .filter(f => f.startsWith("part_"))
    .sort()
    .map(f => path.join(workDir, f));
  if (files.length === 0) throw new Error("ffmpeg لم ينتج أي أجزاء");
  return files;
}
async function splitFile(filePath, ext = "mp4") {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "split_"));
  let parts = [];
  try {
    parts = await segmentOnce(filePath, ext, (await fs.stat(filePath)).size, workDir);
    for (let attempt = 0; attempt < MAX_SPLIT_ATTEMPTS; attempt++) {
      const oversized = [];
      for (const p of parts) {
        const st = await fs.stat(p);
        if (st.size > MAX_PART_BYTES) oversized.push(p);
      }
      if (oversized.length === 0) break;
      for (const p of oversized) {
        const subDir = await fs.mkdtemp(path.join(os.tmpdir(), "resplit_"));
        try {
          const st = await fs.stat(p);
          const subParts = await segmentOnce(p, ext, st.size, subDir);
          const finalSubParts = [];
          for (const sp of subParts) {
            const dest = path.join(workDir, `${path.basename(p, path.extname(p))}_${path.basename(sp)}`);
            await fs.move(sp, dest, { overwrite: true });
            finalSubParts.push(dest);
          }
          const idx = parts.indexOf(p);
          parts.splice(idx, 1, ...finalSubParts);
          await fs.remove(p).catch(() => {});
        } finally {
          await fs.remove(subDir).catch(() => {});
        }
      }
    }
    if (parts.length === 0) {
      const err = new Error("تعذّر تقسيم الملف إلى أجزاء صالحة.");
      err.code = "FILE_TOO_LARGE";
      throw err;
    }
    return parts;
  } catch (e) {
    // On error: clean up the entire work dir (parts are unusable)
    await fs.remove(workDir).catch(() => {});
    if (e.code === "FILE_TOO_LARGE") throw e;
    const err = new Error(`تعذّر تقسيم الملف: ${e.message}`);
    err.code = "FILE_TOO_LARGE";
    throw err;
    // On success: workDir is NOT removed here — callers use cleanupParts()
    // which correctly removes each part file and then the containing directory.
    // This ensures the caller has time to consume the files before cleanup.
  }
}
async function cleanupParts(partPaths) {
  await Promise.allSettled((partPaths || []).map(p => fs.remove(p)));
  const dirs = new Set((partPaths || []).map(p => path.dirname(p)));
  await Promise.allSettled([...dirs].map(d => fs.remove(d)));
}
export { splitFile, cleanupParts, NEEDS_SPLIT, MAX_PART_BYTES };

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-utils-media-splitter',
  meta: { category: 'utils', path: 'src/utils/mediaSplitter.js' },
  setup(_ctx) {
    // provides: MAX_PART_BYTES, NEEDS_SPLIT, cleanupParts, splitFile
  },
};
