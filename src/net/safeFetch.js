// Single outbound HTTP layer: SSRF guard on every hop, overall deadline,
// body-inclusive idle timeout, streaming byte cap, idempotent-only retries.
// Limitation: DNS is validated right before connect; true IP pinning needs a
// custom dispatcher (undici) which Bun does not expose.
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { assertSafeUrl } from "../utils/ssrfGuard.js";
import { AppError } from "../infra/errors.js";

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);
const UA = "Mozilla/5.0 (compatible; SunkenBot/6.0)";

export function hostAllowed(url, allowHosts) {
  if (!allowHosts?.length) return true;
  const h = new URL(url).hostname.toLowerCase();
  return allowHosts.some((a) => h === a || h.endsWith("." + a));
}

async function hop(url, opts, signal) {
  if (!opts.allowPrivate) {
    try { await assertSafeUrl(url); }
    catch (e) { throw new AppError("blocked_url", e.message, { cause: e }); }
  }
  if (!hostAllowed(url, opts.allowHosts)) throw new AppError("blocked_url", "host_not_allowed");
  return fetch(url, {
    method: opts.method,
    headers: { "User-Agent": UA, ...(opts.headers || {}) },
    body: opts.body,
    redirect: "manual",
    signal,
  });
}

export async function safeFetch(rawUrl, opts = {}) {
  const o = { method: "GET", timeoutMs: 20000, maxRedirects: 5, retries: 0, ...opts };
  o.method = o.method.toUpperCase();
  const attempts = IDEMPOTENT.has(o.method) ? o.retries + 1 : 1;
  let lastErr;
  for (let a = 0; a < attempts; a++) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(o.signal.reason);
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(new AppError("timeout", "deadline", { retryable: true })), o.timeoutMs);
    try {
      let url = String(rawUrl);
      for (let i = 0; ; i++) {
        const res = await hop(url, o, ctl.signal);
        const loc = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && loc) {
          await res.body?.cancel().catch(() => {});
          if (i >= o.maxRedirects) throw new AppError("upstream", "too_many_redirects");
          const next = new URL(loc, url);
          if (url.startsWith("https:") && next.protocol === "http:") throw new AppError("blocked_url", "https_downgrade");
          url = next.href;
          continue;
        }
        if (!res.ok && !o.allowErrorStatus) {
          await res.body?.cancel().catch(() => {});
          const retryable = res.status === 429 || res.status >= 500;
          throw new AppError("upstream", `HTTP ${res.status}`, { status: res.status, retryable });
        }
        // keep the deadline alive until the caller finishes reading the body
        res.__done = () => { clearTimeout(timer); o.signal?.removeEventListener("abort", onAbort); };
        return res;
      }
    } catch (e) {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      lastErr = ctl.signal.aborted && ctl.signal.reason instanceof AppError ? ctl.signal.reason : e;
      const retry = lastErr instanceof AppError ? lastErr.retryable : true;
      if (a + 1 >= attempts || !retry) throw lastErr;
      await new Promise((r) => setTimeout(r, 400 * 2 ** a + Math.random() * 200));
    }
  }
  throw lastErr;
}

async function readCapped(res, maxBytes) {
  const len = Number(res.headers.get("content-length"));
  if (maxBytes && len > maxBytes) { await res.body?.cancel().catch(() => {}); throw new AppError("too_large", "content_length"); }
  const chunks = [];
  let total = 0;
  try {
    for await (const c of Readable.fromWeb(res.body)) {
      total += c.length;
      if (maxBytes && total > maxBytes) throw new AppError("too_large", "stream_cap");
      chunks.push(c);
    }
  } finally { res.__done?.(); }
  return Buffer.concat(chunks);
}

export async function fetchBuffer(url, opts = {}) {
  const res = await safeFetch(url, opts);
  return readCapped(res, opts.maxBytes ?? 25 * 1024 * 1024);
}
export async function fetchText(url, opts = {}) {
  return (await fetchBuffer(url, { maxBytes: 5 * 1024 * 1024, ...opts })).toString("utf8");
}
export async function fetchJson(url, opts = {}) {
  const body = opts.body && typeof opts.body === "object" && !(opts.body instanceof Uint8Array) && typeof opts.body.append !== "function"
    ? JSON.stringify(opts.body) : opts.body;
  const headers = { Accept: "application/json", ...(body !== opts.body || typeof body === "string" ? { "Content-Type": "application/json" } : {}), ...(opts.headers || {}) };
  const text = await fetchText(url, { ...opts, body, headers });
  try { return JSON.parse(text); }
  catch (e) { throw new AppError("upstream", "invalid_json", { cause: e }); }
}
// Stream to disk with a byte cap; removes the partial file on failure.
export async function fetchToFile(url, dest, opts = {}) {
  const fs = await import("node:fs/promises");
  const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
  const res = await safeFetch(url, opts);
  const len = Number(res.headers.get("content-length"));
  if (len > maxBytes) { await res.body?.cancel().catch(() => {}); res.__done?.(); throw new AppError("too_large", "content_length"); }
  let total = 0;
  const src = Readable.fromWeb(res.body);
  src.on("data", (c) => { total += c.length; if (total > maxBytes) src.destroy(new AppError("too_large", "stream_cap")); });
  try {
    await pipeline(src, createWriteStream(dest, { flags: "wx", mode: 0o600 }));
  } catch (e) {
    await fs.rm(dest, { force: true });
    throw e;
  } finally { res.__done?.(); }
  return { path: dest, bytes: total, contentType: res.headers.get("content-type") || "" };
}
export const sniffImage = (buf) => {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "jpg";
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "webp";
  if (buf.slice(0, 3).toString() === "GIF") return "gif";
  return null;
};
export default { safeFetch, fetchBuffer, fetchText, fetchJson, fetchToFile, sniffImage };
