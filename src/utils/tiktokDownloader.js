import { Readable } from "node:stream";
import { streamToTempFile } from "./mediaFile.js";
import { assertSafeUrl } from "./fetchHttp.js";

const DEFAULT_API = "https://toshiro-api-editz6t9.vercel.app/api/downloader/alldl";
const USER_AGENT = "Mozilla/5.0 (compatible; SunkenBot/4.0)";
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export function getTikTokDownloadApi() {
  const value = String(process.env.TIKTOK_DOWNLOAD_API || DEFAULT_API).trim();
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "toshiro-api-editz6t9.vercel.app") {
    throw new Error("TIKTOK_DOWNLOAD_API must be the HTTPS Toshiro downloader endpoint");
  }
  return url;
}

export function parseToshiroResponse(data) {
  const result = data?.result;
  const videoUrl = result?.video || result?.url || result?.download_url;
  if (data?.success !== true || result?.success === false || typeof videoUrl !== "string") {
    throw new Error(result?.message || data?.message || "Toshiro لم يُرجع رابط فيديو صالحًا.");
  }
  const parsed = new URL(videoUrl);
  if (parsed.protocol !== "https:" || !/(^|\.)tiktokcdn(?:-[a-z0-9]+)?\.com$/i.test(parsed.hostname)) {
    throw new Error("Toshiro أعاد رابط فيديو خارج نطاق TikTok CDN.");
  }
  return {
    url: parsed.toString(),
    title: String(result.title || data.title || "TikTok video").slice(0, 240),
    author: String(result.author || data.author || "").slice(0, 120),
  };
}

export async function downloadTikTok(sourceUrl, { signal } = {}) {
  const source = new URL(String(sourceUrl));
  if (source.protocol !== "https:" || !/(^|\.)tiktok\.com$/i.test(source.hostname)) {
    throw new Error("أرسل رابط TikTok عامًّا بصيغة HTTPS.");
  }

  const endpoint = getTikTokDownloadApi();
  endpoint.searchParams.set("url", source.toString());
  const apiResponse = await fetch(endpoint, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: signal || AbortSignal.timeout(90_000),
  });
  const payload = await apiResponse.json().catch(() => null);
  if (!apiResponse.ok) {
    throw new Error(payload?.message || payload?.error || `Toshiro API: HTTP ${apiResponse.status}`);
  }
  const resolved = parseToshiroResponse(payload);

  // نتتبع التحويلات يدوياً ونفحص كل قفزة بـ assertSafeUrl (fetch يتبعها تلقائياً ويتجاوز الحماية)
  const mediaSignal = signal || AbortSignal.timeout(180_000);
  let mediaUrl = resolved.url;
  let mediaResponse;
  for (let hop = 0; ; hop++) {
    await assertSafeUrl(mediaUrl);
    mediaResponse = await fetch(mediaUrl, {
      redirect: "manual",
      headers: { Accept: "video/mp4,*/*", Referer: "https://www.tiktok.com/", "User-Agent": USER_AGENT },
      signal: mediaSignal,
    });
    if (mediaResponse.status >= 300 && mediaResponse.status < 400) {
      const location = mediaResponse.headers.get("location");
      await mediaResponse.body?.cancel().catch(() => {});
      if (!location || hop >= 5) throw new Error("تحويلات مفرطة أو غير صالحة من TikTok CDN.");
      mediaUrl = new URL(location, mediaUrl).href;
      continue;
    }
    break;
  }
  if (!mediaResponse.ok) {
    await mediaResponse.body?.cancel().catch(() => {});
    throw new Error(`تعذّر جلب الفيديو من TikTok CDN (HTTP ${mediaResponse.status}).`);
  }
  const contentType = mediaResponse.headers.get("content-type") || "";
  if (!mediaResponse.body || contentType.includes("application/json") || contentType.startsWith("text/html")) {
    await mediaResponse.body?.cancel().catch(() => {});
    throw new Error("Toshiro لم يُرجع تدفق MP4 صالحًا.");
  }

  return streamToTempFile(Readable.fromWeb(mediaResponse.body, { highWaterMark: 1024 * 1024 }), {
    prefix: "tiktok_toshiro",
    ext: "mp4",
    title: resolved.title,
    totalBytes: Number(mediaResponse.headers.get("content-length")) || null,
    maxBytes: MAX_VIDEO_BYTES,
  });
}
