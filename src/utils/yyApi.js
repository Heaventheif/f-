import { Readable } from "node:stream";
import { streamToTempFile } from "./mediaFile.js";
import { assertSafeUrl } from "./fetchHttp.js";

// These are the published homepages of the selected yy and tS repositories.
// Environment variables may override them for preview or self-hosted deployments.
const DEFAULT_API_URL = "https://yy-two-ruddy.vercel.app";
const DEFAULT_TIKTOK_API = "https://heaventheif-ts.vercel.app";
const USER_AGENT = "Mozilla/5.0 (compatible; SunkenBot/5.0)";

function cleanBase(value, fallback, variable) {
  const base = String(value || fallback).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(`متغير البيئة ${variable} غير مضبوط أو غير صالح`);
  }
  return base;
}

export function getApiUrl() {
  return cleanBase(process.env.API_URL, DEFAULT_API_URL, "API_URL");
}

export function getTiktokApiUrl() {
  return cleanBase(process.env.TIKTOK_API, DEFAULT_TIKTOK_API, "TIKTOK_API");
}

export class YYApiError extends Error {
  constructor(message, { status = 0, code = null, retryable = false, requestId = null } = {}) {
    super(message);
    this.name = "YYApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.requestId = requestId;
  }
}

function filenameFromDisposition(value) {
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
  const upstream = typeof detail === "object" && detail.upstream_status
    ? ` (رفض المصدر HTTP ${detail.upstream_status})` : "";
  const suffix = requestId ? ` [request_id: ${requestId}]` : "";
  return new YYApiError(
    `${code ? `${code}: ` : ""}${message || text.slice(0, 300) || `HTTP ${response.status}`}${upstream}${suffix}`,
    { status: response.status, code, retryable: Boolean(detail?.retryable), requestId },
  );
}

// روابط التنزيل (download_url) تأتي من خدمة خارجية ولا نتحكم فيها، وقد تحوّل إلى
// عناوين داخلية. أصل API_URL نفسه موثوق (قد يكون self-hosted على localhost عمداً)،
// أما أي أصل آخر — بما فيه وجهات إعادة التوجيه — فيمرّ على حاجز SSRF.
async function safeFetch(url, options = {}, maxRedirects = 5) {
  const apiOrigin = new URL(getApiUrl()).origin;
  let current = new URL(String(url));
  for (let hop = 0; ; hop++) {
    if (current.origin !== apiOrigin) await assertSafeUrl(current.href);
    const response = await fetch(current, { ...options, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    if (hop >= maxRedirects) throw new YYApiError("تجاوز الحد الأقصى لإعادة التوجيه.", { status: 502 });
    await response.body?.cancel().catch(() => {});
    current = new URL(location, current);
  }
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await safeFetch(url, {
        ...options,
        headers: { "User-Agent": USER_AGENT, ...(options.headers || {}) },
        signal: options.signal || AbortSignal.timeout(180_000),
      });
      if (response.ok) return response;
      lastError = await responseError(response);
    } catch (error) {
      lastError = error instanceof YYApiError
        ? error
        : new YYApiError(error?.message || "تعذر الاتصال بخدمة yy.", { retryable: true });
    }
    const canRetry = lastError.retryable || [502, 503, 504].includes(lastError.status);
    if (attempt === 1 || !canRetry) break;
    await new Promise(resolve => setTimeout(resolve, 900));
  }
  throw lastError;
}

async function downloadUrl(url, { extension = "mp4", prefix = "yy", title = null, onProgress, signal } = {}) {
  const response = await fetchWithRetry(url, { signal });
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json") || contentType.startsWith("text/html")) {
    throw await responseError(response);
  }
  if (!response.body) throw new YYApiError("خدمة yy لم تُرجع تدفق تنزيل.", { status: 502 });
  // Stream the response body directly to a bounded-buffer file writer.
  return streamToTempFile(Readable.fromWeb(response.body, { highWaterMark: 1024 * 1024 }), {
    prefix,
    ext: extension,
    title: title || filenameFromDisposition(response.headers.get("content-disposition")) || "وسائط",
    totalBytes: Number(response.headers.get("content-length")) || null,
    onProgress,
  });
}

function isYoutubeUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    return host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com");
  } catch {
    return false;
  }
}

function qualityHeight(format) {
  const explicit = Number(format?.height);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const label = String(format?.quality || format?.qualityLabel || "");
  return Number(label.match(/(\d{3,4})\s*p?/i)?.[1]) || 0;
}

async function getYoutubeFormats(sourceUrl) {
  const url = new URL(`${getApiUrl()}/api/v1/youtube/formats`);
  url.searchParams.set("url", sourceUrl);
  const response = await fetchWithRetry(url);
  const data = await response.json().catch(() => null);
  if (!data?.ok || !Array.isArray(data.formats)) {
    const detail = data?.error;
    throw new YYApiError(
      (typeof detail === "object" ? detail.message : detail) || "لم تُرجع خدمة yy صيغ YouTube قابلة للتنزيل.",
      { status: response.status, code: detail?.code, retryable: Boolean(detail?.retryable), requestId: data?.request_id },
    );
  }
  return data;
}

export async function downloadYoutubeVideo(sourceUrl, maxHeight = 360, options = {}) {
  const data = await getYoutubeFormats(sourceUrl);
  const formats = data.formats.filter(format => format?.download_url);
  if (!formats.length) throw new YYApiError("لم تُرجع خدمة yy صيغة فيديو قابلة للتنزيل.", { status: 502 });
  // Prefer progressive formats so the MP4 includes audio as well as video.
  const progressive = formats.filter(format => format.kind === "progressive");
  if (!progressive.length) {
    throw new YYApiError("لم تُرجع خدمة yy صيغة MP4 تحتوي الصوت والصورة معًا.", { status: 502, retryable: true });
  }
  const ranked = progressive.sort((a, b) => qualityHeight(a) - qualityHeight(b));
  const eligible = ranked.filter(format => qualityHeight(format) > 0 && qualityHeight(format) <= maxHeight);
  const selected = eligible.at(-1) || ranked[0];
  return downloadUrl(selected.download_url, {
    extension: "mp4",
    prefix: "yy_youtube",
    title: data.title || "YouTube video",
    ...options,
  });
}

export async function downloadYYMedia(sourceUrl, { type = "video", format = "mp3", maxHeight = 360, onProgress, signal } = {}) {
  if (!sourceUrl) throw new YYApiError("الرابط مطلوب.", { status: 400 });
  if (type === "audio") {
    const url = new URL(`${getApiUrl()}/api/v1/audio`);
    url.searchParams.set("url", String(sourceUrl));
    url.searchParams.set("format", format === "m4a" ? "m4a" : "mp3");
    return downloadUrl(url, { extension: format === "m4a" ? "m4a" : "mp3", prefix: "yy_audio", onProgress, signal });
  }
  if (isYoutubeUrl(String(sourceUrl))) return downloadYoutubeVideo(String(sourceUrl), maxHeight, { onProgress, signal });
  const url = new URL(`${getApiUrl()}/api/v1/download`);
  url.searchParams.set("url", String(sourceUrl));
  return downloadUrl(url, { extension: "mp4", prefix: "yy_video", onProgress, signal });
}

export async function downloadYoutubeAudio(sourceUrl, format = "mp3", options = {}) {
  const url = new URL(`${getApiUrl()}/api/v1/audio`);
  url.searchParams.set("url", String(sourceUrl));
  url.searchParams.set("format", format === "m4a" ? "m4a" : "mp3");
  return downloadUrl(url, { extension: format === "m4a" ? "m4a" : "mp3", prefix: "yy_youtube_audio", ...options });
}

export async function downloadYoutubeMp4(sourceUrl, maxHeight = 360, options = {}) {
  return downloadYoutubeVideo(sourceUrl, maxHeight, options);
}
