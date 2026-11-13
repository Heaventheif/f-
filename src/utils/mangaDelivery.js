import fs from "./fsCompat.js";
import { writeFile } from "node:fs/promises";
import http from "./fetchHttp.js";
import { sniffImage } from "../net/safeFetch.js";
import { pool } from "../infra/limiter.js";
import { AppError } from "../infra/errors.js";
import { tmpName } from "../io/tmp.js";
import { sharedDownloadDir } from "./mediaFile.js";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MIN_IMAGE_BYTES = 1000;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Download one image into `dir` (default: shared per-process dir; caller removes the file).
// The saved extension comes from the image's magic bytes, never from the URL.
export async function downloadImageToTemp(url, index, { timeout = 2e4, headers, requireImage = false, dir } = {}) {
  const res = await http.get(url, { responseType: "arraybuffer", timeout, headers, maxBytes: MAX_IMAGE_BYTES });
  const buf = Buffer.from(res.data);
  const kind = sniffImage(buf);
  if (requireImage && !kind) throw new AppError("upstream", `not_an_image (${res.headers["content-type"] || "?"}) #${index}`);
  if (buf.length < MIN_IMAGE_BYTES) throw new AppError("upstream", "image_too_small");
  const target = tmpName(dir || (await sharedDownloadDir()), kind || "jpg");
  await writeFile(target, buf, { flag: "wx", mode: 0o600 });
  return target;
}
// Bounded-parallel download of many images; result keeps the input order (failed entries are dropped).
export async function downloadImagesOrdered(urls, dir, { limit = 6, headers, timeout = 2e4 } = {}) {
  const results = await pool(urls, limit, (url, i) => downloadImageToTemp(url, i, { dir, headers, timeout, requireImage: true }));
  results.forEach((r, i) => { if (!r.ok) console.warn("[images] فشل تحميل صورة:", String(r.error?.message).slice(0, 100), urls[i]?.slice?.(0, 80)); });
  return results.filter((r) => r.ok).map((r) => r.value);
}
export const MAX_IMAGES_PER_MINUTE = 40;
const _imageLog = new Map();
setInterval(() => {
  const cutoff = Date.now() - 6e4;
  for (const [tid, stamps] of _imageLog) {
    while (stamps.length && stamps[0] < cutoff) stamps.shift();
    if (!stamps.length) _imageLog.delete(tid);
  }
}, 6e4).unref();
export async function acquireImageBudget(threadID, count, limit = MAX_IMAGES_PER_MINUTE) {
  const key = String(threadID);
  const need = Math.min(Math.max(1, count), limit);
  for (;;) {
    const now = Date.now();
    const stamps = _imageLog.get(key) || [];
    while (stamps.length && stamps[0] < now - 6e4) stamps.shift();
    if (stamps.length + need <= limit) {
      for (let i = 0; i < need; i++) stamps.push(now);
      _imageLog.set(key, stamps);
      return;
    }
    const waitMs = Math.max(
      250,
      stamps[Math.min(stamps.length - 1, stamps.length + need - limit - 1)] + 6e4 - now,
    );
    await sleep(Math.min(waitMs, 15e3));
  }
}
export const removeFiles = (files) => Promise.allSettled(files.map((f) => fs.remove(f)));
export async function sendImageBatches({
  files,
  batchSize,
  send,
  threadID,
  replyToID = null,
  buildBody,
  delayMs = 0,
  stopOnError = false,
  onError,
}) {
  let allSent = true;
  const totalGroups = Math.ceil(files.length / batchSize);
  for (let i = 0; i < files.length; i += batchSize) {
    const group = files.slice(i, i + batchSize);
    const isFirst = i === 0;
    await acquireImageBudget(threadID, group.length);
    const payload = { attachment: group.map((f) => fs.createReadStream(f)) };
    const body = buildBody?.({ groupNum: Math.floor(i / batchSize) + 1, totalGroups, isFirst });
    if (body !== void 0) payload.body = body;
    try {
      await new Promise((resolve, reject) => {
        send(
          payload,
          threadID,
          (err) => (err ? reject(err) : resolve()),
          isFirst ? replyToID : null,
        );
      });
    } catch (err) {
      if (stopOnError) throw err;
      allSent = false;
      onError?.(err);
    }
    if (delayMs && i + batchSize < files.length) await sleep(delayMs);
  }
  return allSent;
}
