import http from "./fetchHttp.js";
import { streamToTempFile } from "./mediaFile.js";

const BASE = (process.env.XALMAN_API_BASE_URL || "https://xalman-apis.vercel.app").replace(/\/+$/, "");

function directUrl(payload) {
  return payload?.url || payload?.data?.url || payload?.result?.url || payload?.download?.url || null;
}

function titleOf(payload, fallback = "YouTube media") {
  return payload?.title || payload?.data?.title || payload?.result?.title || payload?.filename || fallback;
}

async function streamXalmanUrl(url, title, ext) {
  const response = await http.get(url, {
    responseType: "stream",
    timeout: 120000,
    headers: { Accept: "video/mp4,audio/mpeg,*/*", "User-Agent": "SunkenBot/4.0" },
  });
  const media = await streamToTempFile(response.data, { prefix: "xalman_yt", ext, title });
  return { ...media, duration: 0, uploader: "" };
}

export async function downloadFromXalman(url, wantMp4 = false) {
  const endpoint = wantMp4 ? "/api/ytdl" : "/api/ytmp3";
  const response = await http.get(`${BASE}${endpoint}`, {
    params: { url: String(url) },
    timeout: 120000,
  });
  const payload = response.data;
  const mediaUrl = directUrl(payload);
  if (!mediaUrl) throw new Error(`Xalman لم يُرجع رابط تنزيل من ${endpoint}`);
  return streamXalmanUrl(mediaUrl, titleOf(payload), wantMp4 ? "mp4" : "mp3");
}

export const xalmanConfig = { base: BASE };
