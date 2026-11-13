// MangaDex client: 4 req/s limiter, 429 + Retry-After handling, no pornographic content.
import { safeFetch } from "../net/safeFetch.js";
import { AppError } from "../infra/errors.js";
import { LRU } from "../infra/lru.js";
import { SingleFlight } from "../infra/limiter.js";

export const API_BASE = "https://api.mangadex.org";
export const SAFE_RATINGS = ["safe", "suggestive", "erotica"];
export const MIN_MATCH_SCORE = 0.6;
export const PAGE_HOSTS = ["mangadex.org", "mangadex.network"];
const UA = { "User-Agent": "SunkenBot/6.0 (manga command)" };
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

export async function defaultRequest(url) {
  const res = await safeFetch(url, { allowErrorStatus: true, allowHosts: ["mangadex.org"], timeoutMs: 15000, headers: UA });
  try {
    return { status: res.status, retryAfter: res.headers.get("retry-after"), body: await res.text() };
  } finally {
    res.__done?.();
  }
}

export function parseRetryAfter(v, now = Date.now()) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n * 1000);
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

export class MangaDexClient {
  constructor({ request = defaultRequest, sleep = sleepReal, now = Date.now, rps = 4, maxRetries = 3, cacheTtlMs = 5 * 60_000 } = {}) {
    Object.assign(this, { request, sleep, now, maxRetries, gap: Math.ceil(1000 / rps) });
    this.nextSlot = 0;
    this.cache = new LRU({ maxEntries: 300, maxBytes: 16 * 1024 * 1024, ttlMs: cacheTtlMs });
    this.flight = new SingleFlight();
  }
  async #slot() {
    // reserve synchronously so concurrent callers queue up in order
    const t = this.now();
    const at = Math.max(t, this.nextSlot);
    this.nextSlot = at + this.gap;
    if (at > t) await this.sleep(at - t);
  }
  async get(path, params = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) v.forEach((x) => qs.append(k.endsWith("[]") ? k : `${k}[]`, x));
      else if (v != null) qs.append(k, v);
    }
    const url = `${API_BASE}${path}${qs.size ? `?${qs}` : ""}`;
    const hit = this.cache.get(url);
    if (hit) return hit;
    return this.flight.run(url, async () => {
      for (let attempt = 0; ; attempt++) {
        await this.#slot();
        let r;
        try {
          r = await this.request(url);
        } catch (e) {
          if (e instanceof AppError) throw e;
          throw new AppError("upstream", "mangadex_unreachable", { cause: e, retryable: true });
        }
        if (r.status === 429) {
          if (attempt >= this.maxRetries) throw new AppError("rate_limited", "mangadex_429", { status: 429 });
          const wait = Math.min(parseRetryAfter(r.retryAfter, this.now()) ?? 1000 * 2 ** attempt, 30_000);
          this.nextSlot = Math.max(this.nextSlot, this.now() + wait);
          continue;
        }
        if (r.status >= 500 && attempt < this.maxRetries) {
          await this.sleep(500 * 2 ** attempt);
          continue;
        }
        if (r.status === 404) throw new AppError("not_found", "mangadex_404", { status: 404 });
        if (r.status < 200 || r.status >= 300) throw new AppError("upstream", `mangadex_${r.status}`, { status: r.status });
        let data;
        try {
          data = JSON.parse(r.body);
        } catch (e) {
          throw new AppError("upstream", "mangadex_bad_json", { cause: e });
        }
        this.cache.set(url, data);
        return data;
      }
    });
  }
  async search(query) {
    const d = await this.get("/manga", { title: query, limit: 20, "order[relevance]": "desc", "contentRating[]": SAFE_RATINGS });
    return (d.data || []).filter((m) => m?.attributes?.contentRating !== "pornographic");
  }
  async aggregate(mangaId, lang) {
    const d = await this.get(`/manga/${mangaId}/aggregate`, { "translatedLanguage[]": [lang] });
    return d.volumes || {};
  }
  // Raw chapter entries for one chapter-number filter (language optional).
  async chapters(mangaId, chapterFilter, lang) {
    const params = { manga: mangaId, chapter: chapterFilter, limit: 100, "order[readableAt]": "desc", "contentRating[]": SAFE_RATINGS };
    if (lang) params["translatedLanguage[]"] = [lang];
    const d = await this.get("/chapter", params);
    return Array.isArray(d.data) ? d.data : [];
  }
  // Data-saver page URLs (https + allowlisted host only).
  async pages(chapterId, { dataSaver = true } = {}) {
    const d = await this.get(`/at-home/server/${chapterId}`);
    return buildPageUrls(d, dataSaver);
  }
}

export function buildPageUrls(d, dataSaver = true) {
  const ch = d?.chapter;
  if (!d?.baseUrl || !ch?.hash) return [];
  let host;
  try {
    const u = new URL(d.baseUrl);
    if (u.protocol !== "https:") return [];
    host = u.hostname.toLowerCase();
  } catch {
    return [];
  }
  if (!PAGE_HOSTS.some((a) => host === a || host.endsWith("." + a))) return [];
  const files = dataSaver && Array.isArray(ch.dataSaver) && ch.dataSaver.length ? ch.dataSaver : ch.data;
  const dir = files === ch.dataSaver ? "data-saver" : "data";
  if (!Array.isArray(files)) return [];
  return files.map((f) => `${String(d.baseUrl).replace(/\/+$/, "")}/${dir}/${ch.hash}/${encodeURIComponent(f)}`);
}

// ---- matching -------------------------------------------------------------
export function cleanQuery(raw) {
  return String(raw || "")
    .replace(/["'`ʼ’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function bigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}
export function similarity(a, b) {
  const na = String(a || "").toLowerCase().trim();
  const nb = String(b || "").toLowerCase().trim();
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = bigrams(na), B = bigrams(nb);
  if (!A.length || !B.length) return 0;
  const m = new Map();
  for (const x of B) m.set(x, (m.get(x) || 0) + 1);
  let hit = 0;
  for (const x of A) {
    const c = m.get(x) || 0;
    if (c > 0) { hit++; m.set(x, c - 1); }
  }
  return (2 * hit) / (A.length + B.length);
}
export function collectTitles(manga) {
  const a = manga?.attributes || {};
  const out = [];
  if (a.title) out.push(...Object.values(a.title));
  for (const alt of a.altTitles || []) out.push(...Object.values(alt));
  return out.filter(Boolean);
}
export function bestTitle(manga) {
  const t = manga?.attributes?.title || {};
  return t.en || t.ja || Object.values(t)[0] || "بدون عنوان";
}
// Prefers entries that have chapters in the requested language (bonus), never pornographic.
export function pickBestManga(query, candidates, lang = null) {
  let best = null, bestEff = 0, bestScore = 0;
  for (const m of candidates || []) {
    if (m?.attributes?.contentRating === "pornographic") continue;
    let score = 0;
    for (const t of collectTitles(m)) score = Math.max(score, similarity(query, cleanQuery(t)));
    if (score < MIN_MATCH_SCORE) continue;
    const hasLang = !lang || (m.attributes?.availableTranslatedLanguages || []).includes(lang);
    const eff = score + (hasLang ? 0.2 : 0);
    if (eff > bestEff) { bestEff = eff; best = m; bestScore = score; }
  }
  return { manga: best, score: bestScore };
}

// ---- chapters -------------------------------------------------------------
export function chapterCandidates(ch) {
  const raw = String(ch).trim();
  const s = new Set([raw]);
  if (!raw.includes(".")) s.add(`${raw}.0`);
  else if (raw.endsWith(".0")) s.add(raw.slice(0, -2));
  return [...s];
}
export function pickBestChapter(raw, target) {
  const valid = (raw || []).filter((it) => {
    const a = it?.attributes;
    if (!a || a.externalUrl) return false;
    if (typeof a.pages === "number" && a.pages <= 0) return false;
    const n = Number(a.chapter);
    return a.chapter != null && Number.isFinite(n) && n === target;
  });
  valid.sort((x, y) => Date.parse(y.attributes.readableAt || y.attributes.publishAt || 0) - Date.parse(x.attributes.readableAt || x.attributes.publishAt || 0));
  return valid[0] ? { id: valid[0].id, lang: valid[0].attributes.translatedLanguage } : null;
}
export async function resolveChapter(client, mangaId, chapter, lang) {
  const target = Number(chapter);
  const settled = await Promise.allSettled(chapterCandidates(chapter).map((c) => client.chapters(mangaId, c, lang)));
  const ok = settled.filter((s) => s.status === "fulfilled").flatMap((s) => s.value);
  if (!ok.length) {
    const rej = settled.find((s) => s.status === "rejected");
    if (rej) throw rej.reason;
  }
  return pickBestChapter(ok, target);
}

// ---- aggregate runs / gaps ---------------------------------------------------
export function extractChapterNumbers(volumes) {
  const out = [];
  for (const v of Object.values(volumes || {}))
    for (const c of Object.values(v?.chapters || {})) {
      const n = Number(c?.chapter);
      if (Number.isFinite(n)) out.push(n);
    }
  return out;
}
export function findRuns(numbers) {
  const ints = [...new Set(numbers.filter(Number.isInteger))].sort((a, b) => a - b);
  const runs = [], gaps = [];
  if (!ints.length) return { runs, gaps };
  let start = ints[0], prev = ints[0];
  for (let i = 1; i < ints.length; i++) {
    const cur = ints[i];
    if (cur === prev + 1) { prev = cur; continue; }
    runs.push({ from: start, to: prev });
    gaps.push({ from: prev + 1, to: cur - 1 });
    start = prev = cur;
  }
  runs.push({ from: start, to: prev });
  return { runs, gaps };
}
