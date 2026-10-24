import fs from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const STREAM_BUFFER_BYTES = 1024 * 1024;

/** Stream a Node readable to a temporary file without buffering the whole media in memory. */
export async function streamToTempFile(stream, {
  prefix = "media",
  ext = "bin",
  dir = os.tmpdir(),
  title = null,
  totalBytes = null,
  onProgress,
  maxBytes = 0,
} = {}) {
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${prefix}_${Date.now()}_${randomUUID()}.${ext}`);
  let received = 0;
  const meter = new Transform({
    highWaterMark: STREAM_BUFFER_BYTES,
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (maxBytes > 0 && received > maxBytes) {
        const error = new Error(`الملف تجاوز الحد الأقصى (${Math.round(maxBytes / 1024 / 1024)}MB) أثناء التحميل`);
        error.code = "FILE_TOO_LARGE";
        callback(error);
        return;
      }
      try { onProgress?.(received, totalBytes); } catch {}
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      stream,
      meter,
      fs.createWriteStream(filePath, { highWaterMark: STREAM_BUFFER_BYTES }),
    );
    const fileInfo = await stat(filePath);
    if (!fileInfo.size) throw new Error("الملف المُنزَّل فارغ.");
    return { filePath, path: filePath, bytes: fileInfo.size, title: title || "وسائط" };
  } catch (error) {
    await rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function removeTempFile(filePath) {
  if (filePath) await rm(filePath, { force: true }).catch(() => {});
}
