import { Readable } from "node:stream";
import { safeFetch } from "../net/safeFetch.js";
import { AppError } from "../infra/errors.js";
import { streamToTempFile } from "./mediaFile.js";

const DEFAULT_API_URL = "https://yy-two-ruddy.vercel.app";
const USER_AGENT = "Mozilla/5.0 (compatible; SunkenBot/6.0)";
// Time to first byte may include server-side conversion; the body only needs to keep flowing.
const HEADER_WAIT_MS = 120_000;
const BODY_IDLE_MS = 45_000;
const HARD_CAP_MS = 20 * 60_000;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

function cleanBase(value, fallback, variable) {
  const base = String(value || fallback).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) throw new AppError("upstream", `متغير البيئة ${variable} غير مضبوط أو غير صالح`);
  return base;
}
export function getApiUrl() {
  return cleanBase(process.env.API_URL, DEFAULT_API_URL, "API_URL");
}

// `code` follows AppError codes; the API's own error code lives in `apiCode`.
export class YYApiError extends AppError {
  constructor(message, { status = 0, code = null, retryable = false, requestId = null, appCode } = {}) {
    super(appCode || (status === 408 || status === 504 ? "timeout" : "upstream"), message, { status, retryable });
    this.name = "YYApiError";
    this.apiCode = code;
    this.requestId = requestId;
  }
}

export function filenameFromDisposition(value) {
  const header = String(value || "");
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { return encoded; }
  }
  return header.match(/filename="?([^";]+)"?/i)?.[1] || null;
}

async function responseError(response) {
  const text = await response.text().catch(() => "");
  let data = null;
  try { data = JSON.parse(text); } catch {}
  const detail = data?.error;
  const code = typeof detail === "object" ? detail.code : null;
  const message = typeof detail === "object" ? detail.message : detail;
  const requestId = data?.request_id || response.headers.get("x-request-id") || null;
  const upstream = typeof detail === "object" && detail?.upstream_status ? ` (رفض المصدر HTTP ${detail.upstream_status})` : "";
  const suffix = requestId ? ` [request_id: ${requestId}]` : "";
  return new YYApiError(
    `${code ? `${code}: ` : ""}${message || text.slice(0, 300) || `HTTP ${response.status}`}${upstream}${suffix}`,
    { status: response.status, code, retryable: Boolean(detail?.retryable), requestId },
  );
}

function toYYError(error) {
  if (error instanceof YYApiError) return error;
  if (error instanceof AppError) {
    const e = new YYApiError(error.message, { status: error.status || 0, retryable: error.retryable, appCode: error.code });
    return e;
  }
  return new YYApiError(error?.message || "تعذر الاتصال بخدمة yy.", { retryable: true });
}

// GET with one retry on transient failures. `idleMs` bounds the wait for response headers only.
async function fetchWithRetry(url, { signal, headerWaitMs = HEADER_WAIT_MS, hardCapMs = HARD_CAP_MS } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort(signal.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const waiter = setTimeout(() => ctl.abort(new AppError("timeout", "yy_header_wait", { retryable: true })), headerWaitMs);
    try {
      const response = await safeFetch(url, {
        headers: { "User-Agent": USER_AGENT },
        timeoutMs: hardCapMs,
        signal: ctl.signal,
        allowErrorStatus: true,
      });
      clearTimeout(waiter);
      if (response.ok) { response.__abortBridge = () => signal?.removeEventListener("abort", onAbort); return response; }
      lastError = await responseError(response);
      response.__done?.();
    } catch (error) {
      clearTimeout(waiter);
      signal?.removeEventListener("abort", onAbort);
      lastError = toYYError(ctl.signal.aborted && ctl.signal.reason instanceof AppError ? ctl.signal.reason : error);
    }
    signal?.removeEventListener("abort", onAbort);
    const canRetry = lastError.retryable || [502, 503, 504].includes(lastError.status);
    if (attempt === 1 || !canRetry || signal?.aborted) break;
    await new Promise((resolve) => setTimeout(resolve, 900));
  }
  throw lastError;
}

// Resolve API-relative links (e.g. "/api/v1/download?...") against the API origin.
export function resolveDownloadUrl(value, base = getApiUrl()) {
  return new URL(String(value), `${base}/`).href;
}

async function downloadUrl(url, { extension = "mp4", title = null, onProgress, signal, dir, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const response = await fetchWithRetry(String(url), { signal });
  try {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json") || contentType.startsWith("text/html")) throw await responseError(response);
    if (!response.body) throw new YYApiError("خدمة yy لم تُرجع تدفق تنزيل.", { status: 502 });
    const total = Number(response.headers.get("content-length")) || null;
    if (total && total > maxBytes) { await response.body.cancel().catch(() => {}); throw new AppError("too_large", "content_length"); }
    return await streamToTempFile(Readable.fromWeb(response.body, { highWaterMark: 1024 * 1024 }), {
      dir, ext: extension, maxBytes, idleMs: BODY_IDLE_MS, totalBytes: total, onProgress,
      title: title || filenameFromDisposition(response.headers.get("content-disposition")) || "وسائط",
    });
  } finally {
    response.__done?.();
    response.__abortBridge?.();
  }
}

export function isYoutubeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch { return false; }
}
function qualityHeight(format) {
  const explicit = Number(format?.height);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const label = String(format?.quality || format?.qualityLabel || "");
  return Number(label.match(/(\d{3,4})\s*p?/i)?.[1]) || 0;
}
async function getYoutubeFormats(sourceUrl, signal) {
  const url = new URL(`${getApiUrl()}/api/v1/youtube/formats`);
  url.searchParams.set("url", sourceUrl);
  const response = await fetchWithRetry(url.href, { signal, headerWaitMs: 60_000, hardCapMs: 90_000 });
  let data;
  try { data = JSON.parse(await response.text()); } catch { data = null; } finally { response.__done?.(); response.__abortBridge?.(); }
  if (!data?.ok || !Array.isArray(data.formats)) {
    const detail = data?.error;
    throw new YYApiError(
      (typeof detail === "object" ? detail?.message : detail) || "لم تُرجع خدمة yy صيغ YouTube قابلة للتنزيل.",
      { status: response.status, code: detail?.code, retryable: Boolean(detail?.retryable), requestId: data?.request_id },
    );
  }
  return data;
}

// Pure: pick the best progressive MP4 not above maxHeight (else the smallest available).
export function pickProgressiveFormat(formats, maxHeight = 360) {
  const progressive = (formats || []).filter((f) => f?.download_url && f.kind === "progressive");
  if (!progressive.length) return null;
  const ranked = [...progressive].sort((a, b) => qualityHeight(a) - qualityHeight(b));
  const eligible = ranked.filter((f) => qualityHeight(f) > 0 && qualityHeight(f) <= maxHeight);
  return eligible.at(-1) || ranked[0];
}

export async function downloadYoutubeVideo(sourceUrl, maxHeight = 360, options = {}) {
  const data = await getYoutubeFormats(sourceUrl, options.signal);
  const selected = pickProgressiveFormat(data.formats, maxHeight);
  if (!selected) throw new YYApiError("لم تُرجع خدمة yy صيغة MP4 تحتوي الصوت والصورة معًا.", { status: 502, retryable: true });
  return downloadUrl(resolveDownloadUrl(selected.download_url), { extension: "mp4", title: data.title || "YouTube video", ...options });
}

export async function downloadYoutubeAudio(sourceUrl, format = "mp3", options = {}) {
  const fmt = format === "m4a" ? "m4a" : "mp3";
  const url = new URL(`${getApiUrl()}/api/v1/audio`);
  url.searchParams.set("url", String(sourceUrl));
  url.searchParams.set("format", fmt);
  return downloadUrl(url.href, { extension: fmt, ...options });
}
export const downloadYoutubeMp4 = downloadYoutubeVideo;

export async function downloadYYMedia(sourceUrl, { type = "video", format = "mp3", maxHeight = 360, ...options } = {}) {
  if (!sourceUrl) throw new YYApiError("الرابط مطلوب.", { status: 400, appCode: "bad_args" });
  if (type === "audio") return downloadYoutubeAudio(String(sourceUrl), format, options);
  if (isYoutubeUrl(String(sourceUrl))) return downloadYoutubeVideo(String(sourceUrl), maxHeight, options);
  const url = new URL(`${getApiUrl()}/api/v1/download`);
  url.searchParams.set("url", String(sourceUrl));
  return downloadUrl(url.href, { extension: "mp4", ...options });
}
