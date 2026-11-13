// Image delivery: capped, temp-dir scoped, N+1 batch prefetched while N is sent,
// per-image failure reasons, never restarts from page 1.
import { writeFile } from "node:fs/promises";
import { fetchBuffer, sniffImage } from "../net/safeFetch.js";
import { withTempDir, tmpName } from "../io/tmp.js";
import { pool } from "../infra/limiter.js";
import { AppError } from "../infra/errors.js";

export const MAX_PAGES = 140;
export const BATCH_SIZE = 14;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MIN_IMAGE_BYTES = 1000;
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export function reasonOf(e) {
  const code = e?.code;
  if (code === "timeout") return "مهلة";
  if (code === "too_large") return "حجم كبير";
  if (code === "blocked_url") return "رابط محظور";
  if (code === "not_image") return "ليست صورة";
  if (e?.status) return `HTTP ${e.status}`;
  return "خطأ";
}

// Default downloader: safeFetch + magic-byte sniff, written into `dir`.
export async function downloadPage(url, dir, { headers, allowHosts, timeoutMs = 25000 } = {}) {
  const buf = await fetchBuffer(url, { headers, allowHosts, timeoutMs, maxBytes: MAX_IMAGE_BYTES, retries: 1 });
  const kind = sniffImage(buf);
  if (!kind) throw new AppError("not_image", "not_image");
  if (buf.length < MIN_IMAGE_BYTES) throw new AppError("upstream", "image_too_small");
  const p = tmpName(dir, kind);
  await writeFile(p, buf, { flag: "wx", mode: 0o600 });
  return p;
}

export function planBatches(total, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < total; i += size) out.push([i, Math.min(total, i + size)]);
  return out;
}

/**
 * deliverImages({ urls, send(files, info) , download?, headers, allowHosts, ... })
 *  send(files, { batch, batches, firstPage, lastPage, isFirst }) must resolve or throw.
 * Returns { total, truncated, sent, failures:[{page,reason}], aborted:null|{page,error} }.
 * A batch whose send fails twice stops delivery (aborted) - later batches are NOT attempted
 * and nothing is re-sent.
 */
export async function deliverImages({
  urls, send, download = downloadPage, headers, allowHosts, cap = MAX_PAGES, batchSize = BATCH_SIZE,
  concurrency = 4, delayMs = 0, sleep = sleepReal, startAt = 0,
}) {
  const all = urls.slice(0, cap);
  const result = { total: all.length, truncated: urls.length > cap, sent: 0, failures: [], aborted: null, firstSentPage: null };
  const batches = planBatches(all.length, batchSize).filter(([a]) => a >= startAt);
  if (!batches.length) return result;
  return withTempDir(async (dir) => {
    const fetchBatch = async ([a, b]) => {
      const rs = await pool(all.slice(a, b), concurrency, (u) => download(u, dir, { headers, allowHosts }));
      const files = [];
      rs.forEach((r, i) => {
        if (r.ok) files.push({ page: a + i + 1, path: r.value });
        else result.failures.push({ page: a + i + 1, reason: reasonOf(r.error) });
      });
      return files;
    };
    let next = fetchBatch(batches[0]);
    try {
      for (let i = 0; i < batches.length; i++) {
        const files = await next;
        next = i + 1 < batches.length ? fetchBatch(batches[i + 1]) : null; // prefetch N+1
        if (next) next.catch(() => {});
        if (files.length) {
          const info = { batch: i + 1, batches: batches.length, firstPage: files[0].page, lastPage: files[files.length - 1].page, isFirst: result.sent === 0 };
          let err = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try { await send(files.map((f) => f.path), info); err = null; break; }
            catch (e) { err = e; if (attempt === 0) await sleep(1500); }
          }
          if (err) { result.aborted = { page: files[0].page, error: err }; break; }
          result.sent += files.length;
          result.firstSentPage ??= files[0].page;
        }
        if (delayMs && i + 1 < batches.length) await sleep(delayMs);
      }
    } finally {
      if (next) await next.catch(() => {}); // never remove the dir under a running prefetch
    }
    return result;
  }, "manga");
}

export function failureSummary(r) {
  const parts = [];
  if (r.truncated) parts.push(`⚠️ أُرسلت أول ${r.total} صفحة فقط (حد الأمان).`);
  if (r.failures.length) {
    const shown = r.failures.slice(0, 8).map((f) => `${f.page} (${f.reason})`).join("، ");
    parts.push(`⚠️ تعذر تحميل ${r.failures.length} صفحة: ${shown}${r.failures.length > 8 ? " ..." : ""}`);
  }
  if (r.aborted) parts.push(`⛔ توقف الإرسال عند الصفحة ${r.aborted.page} بعد إرسال ${r.sent} صفحة. لن أعيد إرسال ما أُرسل.`);
  return parts.join("\n");
}
