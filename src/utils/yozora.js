import http from "./fetchHttp.js";

export const YOZORA_BASE_URL = "https://yozora.vercel.app";
export const YOZORA_DEFAULT_FORMAT = "bestvideo+bestaudio/best";

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function firstEntry(info) {
  if (!info || typeof info !== "object") return null;
  if (Array.isArray(info.entries)) return info.entries.find(Boolean) || null;
  return info;
}

export function buildYozoraUrl(pathname, params = {}) {
  const url = new URL(pathname, YOZORA_BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function getYozoraInfo(query, format = YOZORA_DEFAULT_FORMAT, timeout = 90_000) {
  const source = asText(query);
  if (!source) throw new Error("رابط أو عبارة البحث فارغة");
  const response = await http.get(buildYozoraUrl("/api/info", {
    query: source,
    format,
  }), {
    timeout,
    responseType: "json",
    validateStatus: () => true,
    headers: { Accept: "application/json", "User-Agent": "SunkenBot/3.0" },
  });
  if (response.status < 200 || response.status >= 300) {
    const detail = typeof response.data === "string"
      ? response.data
      : response.data?.detail || response.data?.message;
    throw new Error(`Yozora رفض الطلب (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!response.data || typeof response.data !== "object") {
    throw new Error("استجابة غير صالحة من Yozora");
  }
  return response.data;
}

export function normalizeYozoraEntry(entry, index = 0) {
  const item = entry && typeof entry === "object" ? entry : {};
  const id = asText(item.id) || asText(item.display_id) || `yozora-${index}`;
  const title = asText(item.title) || "بدون عنوان";
  const webpageUrl = asText(item.webpage_url) || asText(item.original_url) || asText(item.url);
  const durationSeconds = Number(item.duration) || 0;
  const duration = durationSeconds > 0
    ? `${Math.floor(durationSeconds / 60)}:${String(Math.floor(durationSeconds % 60)).padStart(2, "0")}`
    : "--";
  return {
    id,
    title,
    url: webpageUrl,
    duration,
    uploader: asText(item.uploader) || asText(item.channel) || asText(item.uploader_id),
    thumb: asText(item.thumbnail),
  };
}

export function getYozoraEntries(info, limit = 10) {
  const entries = Array.isArray(info?.entries) ? info.entries : [info];
  return entries.filter(Boolean).slice(0, limit).map(normalizeYozoraEntry);
}

export function getYozoraTitle(info, fallback = "وسائط") {
  const item = firstEntry(info);
  return asText(item?.title) || fallback;
}

export function buildYozoraDownloadUrl(source, format = YOZORA_DEFAULT_FORMAT) {
  return buildYozoraUrl("/api/download", { url: source, format });
}

export function getYozoraMediaUrl(info) {
  const item = firstEntry(info) || {};
  return asText(item.url)
    || asText(item.requested_formats?.[0]?.url)
    || asText(item.formats?.find?.(format => format?.url)?.url);
}

export const $plugin = {
  name: "xx-utils-yozora",
  meta: { category: "utils", path: "utils/yozora.js" },
  setup(_ctx) {},
};
