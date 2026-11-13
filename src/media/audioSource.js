// Shared audio source logic for yt / ytmp3 / song: host allowlist, duration + size caps, search normalisation.
import { AppError } from "../infra/errors.js";
import { searchYoutube } from "../utils/youtubeSearch.js";
import { downloadYoutubeAudio } from "../utils/yyApi.js";

export const MAX_DURATION_SEC = 10 * 60;
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
export const AUDIO_HOSTS = [
  "youtube.com", "youtu.be", "music.youtube.com", "soundcloud.com", "on.soundcloud.com", "snd.sc",
];
const VIDEO_ID_RE = /^[\w-]{11}$/;

export function isAllowedAudioUrl(value, hosts = AUDIO_HOSTS) {
  try {
    const u = new URL(String(value));
    if (!/^https?:$/.test(u.protocol)) return false;
    const h = u.hostname.toLowerCase().replace(/\.$/, "");
    return hosts.some((d) => h === d || h.endsWith("." + d));
  } catch { return false; }
}
export function assertAudioUrl(value) {
  if (!isAllowedAudioUrl(value)) throw new AppError("blocked_url", "audio_host_not_allowed");
  return String(value);
}

// "1:02:03" | "3:45" | 225 -> seconds (null when unknown). Milliseconds are NOT guessed here: callers convert.
export function parseDuration(value) {
  if (Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof value !== "string" || !value.trim()) return null;
  const parts = value.trim().split(":").map(Number);
  if (!parts.length || parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  return parts.reduce((t, p) => t * 60 + p, 0);
}
export function ytItemSeconds(item) {
  return parseDuration(item?.seconds) ?? parseDuration(item?.timestamp) ?? parseDuration(item?.duration?.seconds) ??
    parseDuration(item?.duration?.timestamp) ?? (typeof item?.duration === "string" ? parseDuration(item.duration) : null);
}
// seconds -> "m:ss" / "h:mm:ss" ("" when unknown)
export function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}
// Unknown duration passes (the byte cap still applies); known over-limit throws.
export function assertDuration(sec, max = MAX_DURATION_SEC) {
  if (Number.isFinite(sec) && sec > max) throw new AppError("too_large", "duration_cap", { meta: { reason: "duration", sec, max } });
  return sec;
}
export const withinDuration = (sec, max = MAX_DURATION_SEC) => !(Number.isFinite(sec) && sec > max);

export function audioErrorText(error) {
  if (error?.code === "too_large") return error?.meta?.reason === "duration" ? "⏱ المقطع أطول من 10 دقائق." : "📦 الملف كبير جدًا.";
  if (error?.code === "blocked_url") return "🔒 هذا الرابط غير مدعوم (يوتيوب وساوند كلاود فقط).";
  if (error?.code === "timeout") return "⌛ انتهت المهلة، حاول مجددًا.";
  if (error?.code === "not_found") return "لم أجد نتائج.";
  return "❌ تعذّر تنزيل الصوت الآن.";
}

export function normalizeYtResults(result, limit = 1) {
  if (!result?.status || !Array.isArray(result.results)) throw new AppError("upstream", result?.message || "yt_search_failed");
  const max = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 1;
  const seen = new Set();
  const items = result.results
    .filter((i) => i && (i.type == null || i.type === "video") && VIDEO_ID_RE.test(String(i.videoId || "")))
    .filter((i) => !seen.has(i.videoId) && seen.add(i.videoId))
    .slice(0, max)
    .map((item) => {
      const artist = typeof item.author === "string" ? item.author : item.author?.name || item.channel?.name || "";
      return {
        id: item.videoId, videoId: String(item.videoId), title: item.title || item.name || "",
        artist, artists: artist, duration: ytItemSeconds(item),
        thumbnail: item.thumbnail || item.image || item.thumbnails?.[0]?.url || null,
        url: `https://www.youtube.com/watch?v=${item.videoId}`,
      };
    });
  if (!items.length) throw new AppError("not_found", "no_results");
  return items;
}
export async function searchYt(query, limit = 1) {
  const text = String(query || "").trim();
  if (!text) throw new AppError("not_found", "no_results");
  return normalizeYtResults(await searchYoutube(text), limit);
}

// Download audio into `dir` (from withTempDir) with host + size caps. Returns the file path.
export async function fetchAudioFile(sourceUrl, { dir, format = "mp3", signal } = {}) {
  assertAudioUrl(sourceUrl);
  const media = await downloadYoutubeAudio(sourceUrl, format, { dir, signal, maxBytes: MAX_AUDIO_BYTES });
  return media.filePath;
}
export const ytMusicUrl = (videoId) => {
  if (!VIDEO_ID_RE.test(String(videoId || ""))) throw new AppError("bad_args", "bad_video_id");
  return `https://music.youtube.com/watch?v=${videoId}`;
};
