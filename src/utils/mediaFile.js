import fs from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpRoot, tmpName } from "../io/tmp.js";
import { AppError } from "../infra/errors.js";

const STREAM_BUFFER_BYTES = 1024 * 1024;
export const ALLOWED_EXTS = new Set([
  "mp4", "m4a", "mp3", "ogg", "opus", "wav", "webm", "amr", "aac", "mkv", "mov", "gif", "jpg", "jpeg", "png", "webp",
]);
// Only whitelisted extensions reach the file system; everything else is "bin".
export function safeExt(ext, fallback = "bin") {
  const e = String(ext || "").toLowerCase().replace(/^\./, "").replace(/[^a-z0-9]/g, "");
  return ALLOWED_EXTS.has(e) ? e : fallback;
}
// Shared per-process folder for callers that cannot use withTempDir (they must still remove their file).
export async function sharedDownloadDir() {
  const dir = path.join(await tmpRoot(), "dl");
  await mkdir(dir, { recursive: true });
  return dir;
}
// Stream to <dir>/<uuid>.<ext>, enforcing a byte cap and an idle timeout; destroys the source on failure.
export async function streamToTempFile(
  stream,
  { ext = "bin", dir, title = null, totalBytes = null, onProgress, maxBytes = 0, idleMs = 0 } = {},
) {
  const target = dir || (await sharedDownloadDir());
  const filePath = tmpName(target, safeExt(ext));
  let received = 0;
  let idle = null;
  const bump = () => {
    if (!idleMs) return;
    clearTimeout(idle);
    idle = setTimeout(() => stream.destroy(new AppError("timeout", "idle", { retryable: true })), idleMs);
  };
  const meter = new Transform({
    highWaterMark: STREAM_BUFFER_BYTES,
    transform(chunk, _enc, cb) {
      received += chunk.length;
      if (maxBytes > 0 && received > maxBytes) return cb(new AppError("too_large", "stream_cap"));
      bump();
      try { onProgress?.(received, totalBytes); } catch {}
      cb(null, chunk);
    },
  });
  bump();
  try {
    await pipeline(stream, meter, fs.createWriteStream(filePath, { flags: "wx", mode: 0o600, highWaterMark: STREAM_BUFFER_BYTES }));
    const info = await stat(filePath);
    if (!info.size) throw new AppError("upstream", "empty_file");
    return { filePath, path: filePath, bytes: info.size, title: title || "وسائط" };
  } catch (error) {
    stream.destroy?.();
    await rm(filePath, { force: true }).catch(() => {});
    throw error;
  } finally { clearTimeout(idle); }
}
export async function removeTempFile(filePath) {
  if (filePath) await rm(filePath, { force: true }).catch(() => {});
}
