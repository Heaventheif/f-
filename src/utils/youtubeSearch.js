import { LRU } from "../infra/lru.js";
import { SingleFlight } from "../infra/limiter.js";
const SEARCH_TIMEOUT_MS = 15_000;
const cache = new LRU({ maxEntries: 200, maxBytes: 8 * 1024 * 1024, ttlMs: 5 * 60_000 });
const flights = new SingleFlight();
const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("yt_search_timeout")), ms).unref?.())]);
let searcherPromise;
async function getSearcher() {
  if (!searcherPromise) {
    searcherPromise = import("yt-search")
      .then((module) => module.default || module)
      .then((searcher) => {
        if (typeof searcher !== "function") throw new TypeError("واجهة yt-search غير صالحة");
        return searcher;
      })
      .catch((error) => {
        searcherPromise = null;
        throw error;
      });
  }
  return searcherPromise;
}
export function normalizeYtSearchResults(data) {
  const results = Array.isArray(data?.all)
    ? data.all
    : Array.isArray(data?.videos)
      ? data.videos
      : [];
  return { status: true, results };
}
export async function searchYoutube(query) {
  const text = String(query || "").trim().slice(0, 200);
  if (!text) return { status: false, message: "query_required" };
  const key = text.toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;
  return flights.run(key, async () => {
    try {
      const searcher = await getSearcher();
      const out = normalizeYtSearchResults(
        await withTimeout(
          searcher({ query: text, hl: /[\u0600-\u06FF]/.test(text) ? "ar" : "en", gl: process.env.YT_REGION || "DZ" }),
          SEARCH_TIMEOUT_MS,
        ),
      );
      if (out.results.length) cache.set(key, out);
      return out;
    } catch (error) {
      return { status: false, message: error?.message || "yt_search_failed" };
    }
  });
}
export default { search: searchYoutube };
