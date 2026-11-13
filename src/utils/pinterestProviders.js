"use strict";
import http from "./fetchHttp.js";
import { runWithFallback } from "../infra/limiter.js";
import { AppError } from "../infra/errors.js";
import { downloadImagesOrdered } from "./mangaDelivery.js";
import { getHfBaseOrNull, getInternalToken } from "./hfClient.js";

const IMAGE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://www.pinterest.com/",
  Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
};
const httpUrl = (u) => typeof u === "string" && /^https?:\/\//i.test(u);

async function searchViaHfBridge(query, limit) {
  const base = getHfBaseOrNull();
  if (!base) throw new AppError("upstream", "HF_SPACE_URL غير مضبوط");
  const { data } = await http.post(
    `${base}/pinterest`,
    { query, limit, quality: "original", fallback_ferdev: true },
    { timeout: 3e4, headers: { "Content-Type": "application/json", "X-Internal-Token": getInternalToken() } },
  );
  if (!data?.success || !data.images?.length) throw new AppError("not_found", data?.error || "لا نتائج");
  return data.images.map((img) => img.url).filter(httpUrl);
}
async function searchViaFerdev(query, limit) {
  const key = process.env.FERDEV_API_KEY || "";
  if (!key) throw new AppError("upstream", "FERDEV_API_KEY غير مضبوط");
  const response = await http.get("https://api.ferdev.my.id/search/pinterest", {
    params: { query, apikey: key }, timeout: 3e4, headers: { "User-Agent": "SunkenBot/2.0" },
  });
  const raw = response.data?.result;
  if (!Array.isArray(raw) || !raw.length) throw new AppError("not_found", "لا نتائج");
  const urls = raw.slice(0, limit).map((item) => item?.url || item?.image || (typeof item === "string" ? item : null)).filter(httpUrl);
  if (!urls.length) throw new AppError("not_found", "لا روابط صور صالحة");
  return urls;
}
const PROVIDERS = [
  { name: "hf-bridge", fn: searchViaHfBridge },
  { name: "ferdev", fn: searchViaFerdev },
];
// Typed failure: every provider's error is kept in `.errors`.
export async function searchImagesWithFallback(query, limit) {
  try {
    return await runWithFallback(PROVIDERS, (p) => p.fn(query, limit));
  } catch (e) {
    const err = new AppError("not_found", "تعذّر البحث عبر جميع المزوّدين", { cause: e });
    err.errors = (e.errors || []).map((x) => `${x.name}: ${x.error?.message}`);
    throw err;
  }
}
// Order-preserving, magic-byte-checked download into `tmpDir` (use withTempDir).
export function downloadImagesWithLimit(urls, tmpDir, limit = 6) {
  return downloadImagesOrdered(urls.filter(Boolean), tmpDir, { limit, headers: IMAGE_HEADERS });
}
