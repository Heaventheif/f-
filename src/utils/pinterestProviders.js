"use strict";
import fs from "fs-extra";
import path from "path";
import http from "./fetchHttp.js";
import { getHfBaseOrNull, getInternalToken } from "./hfClient.js";
const IMAGE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Referer": "https://www.pinterest.com/",
  "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
};
async function searchViaHfBridge(query, limit) {
  const HF_SPACE_URL = getHfBaseOrNull();
  if (!HF_SPACE_URL) throw new Error("HF_SPACE_URL غير مضبوط");
  const { data } = await http.post(
    `${HF_SPACE_URL}/pinterest`,
    { query, limit, quality: "original", fallback_ferdev: true },
    { timeout: 30000, headers: { "Content-Type": "application/json", "X-Internal-Token": getInternalToken() } }
  );
  if (!data.success || !data.images?.length) throw new Error(data.error || "لا نتائج");
  return data.images.map(img => img.url).filter(Boolean);
}
async function searchViaFerdev(query, limit) {
  const FERDEV_API_KEY = process.env.FERDEV_API_KEY || "";
  if (!FERDEV_API_KEY) throw new Error("FERDEV_API_KEY غير مضبوط");
  const response = await http.get("https://api.ferdev.my.id/search/pinterest", {
    params: { query, apikey: FERDEV_API_KEY },
    timeout: 30000,
    headers: { "User-Agent": "SunkenBot/2.0" },
  });
  const rawResults = response.data?.result;
  if (!rawResults?.length) throw new Error("لا نتائج");
  const urls = rawResults
    .slice(0, limit)
    .map(item => item.url || item.image || (typeof item === "string" ? item : null))
    .filter(Boolean);
  if (!urls.length) throw new Error("لا روابط صور صالحة");
  return urls;
}
export async function searchImagesWithFallback(query, limit) {
  const errors = [];
  for (const [name, fn] of [["hf-bridge", searchViaHfBridge], ["ferdev", searchViaFerdev]]) {
    try {
      return await fn(query, limit);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(errors.join(" | ") || "تعذّر البحث عبر جميع المزوّدين");
}
export async function downloadImagesWithLimit(urls, tmpDir, limit = 6) {
  const downloaded = [];
  let idx = 0;
  async function worker() {
    while (idx < urls.length) {
      const i = idx++;
      const imgUrl = urls[i];
      if (!imgUrl) continue;
      try {
        const res = await http.get(imgUrl, { responseType: "arraybuffer", timeout: 20000, headers: IMAGE_HEADERS });
        const imgBuffer = Buffer.from(res.data);
        if (!imgBuffer || imgBuffer.length < 1000) continue;
        const ext = imgUrl.includes(".png") ? "png" : imgUrl.includes(".webp") ? "webp" : "jpg";
        const tmpFile = path.join(tmpDir, `pin_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
        await fs.writeFile(tmpFile, imgBuffer);
        downloaded.push(tmpFile);
      } catch (imgErr) {
        console.warn("[pin] فشل تحميل صورة:", imgErr.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, urls.length) }, worker));
  return downloaded;
}
