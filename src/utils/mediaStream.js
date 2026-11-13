"use strict";
import fs from "./fsCompat.js";
import { Readable } from "node:stream";
import { safeFetch } from "../net/safeFetch.js";
import { AppError } from "../infra/errors.js";
import { withTempDir } from "../io/tmp.js";
import { splitFile, NEEDS_SPLIT } from "./mediaSplitter.js";
import { directSend, directSendParts } from "./send.js";
import { streamToTempFile, safeExt } from "./mediaFile.js";

const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const BODY_IDLE_MS = 45_000;

// Streaming GET. The returned stream releases the deadline when it closes and is destroyed on failure.
async function fetchStream(url, { allowHosts, timeoutMs = 10 * 60_000, signal } = {}) {
  const res = await safeFetch(url, { allowHosts, timeoutMs, signal });
  if (!res.body) { res.__done?.(); throw new AppError("upstream", "empty_body"); }
  const stream = Readable.fromWeb(res.body, { highWaterMark: 1024 * 1024 });
  stream.once("close", () => res.__done?.());
  return { stream, contentLength: Number(res.headers.get("content-length")) || 0, contentType: res.headers.get("content-type") || "" };
}

// Download into `dir` (caller owns the directory, normally from withTempDir).
async function downloadToTemp(url, ext = "mp4", { dir, allowHosts, maxBytes = MAX_DOWNLOAD_BYTES, signal } = {}) {
  const { stream, contentLength } = await fetchStream(url, { allowHosts, signal });
  try {
    if (contentLength > maxBytes) throw new AppError("too_large", "content_length");
    const media = await streamToTempFile(stream, { dir, ext: safeExt(ext), totalBytes: contentLength || null, maxBytes, idleMs: BODY_IDLE_MS });
    return { tmpPath: media.filePath, size: media.bytes, contentLength };
  } catch (e) {
    stream.destroy();
    throw e;
  }
}

async function streamAndSend(api, threadID, mediaUrl, title, ext = "mp4", replyToID = void 0) {
  try {
    return await withTempDir(async (dir) => {
      const { tmpPath, size } = await downloadToTemp(mediaUrl, ext, { dir });
      if (NEEDS_SPLIT(size)) {
        const parts = await splitFile(tmpPath, ext, { dir });
        const streams = parts.map((p) => ({ stream: fs.createReadStream(p), reopen: () => fs.createReadStream(p) }));
        const { sent } = await directSendParts(api, threadID, title, streams, replyToID);
        return sent > 0;
      }
      return directSend(api, threadID, { attachment: fs.createReadStream(tmpPath) }, replyToID);
    }, "stream");
  } catch (e) {
    console.error("[MEDIA_STREAM] خطأ:", String(e?.message).slice(0, 200));
    if (e?.code === "too_large") {
      await global.safeSend(api, "⚠️ الملف كبير جدًا للإرسال.", threadID, null, replyToID).catch(() => {});
      return true;
    }
    return false;
  }
}
export { streamAndSend, downloadToTemp, fetchStream };
