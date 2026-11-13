// Novel source adapters + pure helpers (HTML parsing, filters, translation batching).
import * as cheerio from "cheerio";
import { fetchText, fetchJson } from "../net/safeFetch.js";
import { AppError } from "../infra/errors.js";
import { LRU } from "../infra/lru.js";
import { hfTarget } from "./hf.js";

export const MAX_CHAPTER = 5000;

// ---- names / slugs -----------------------------------------------------------------
export function slugify(name) {
  return String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
export const hasNonLatin = (s) => /[^\u0000-ɏ\s\d\p{P}]/u.test(String(s || ""));

// Validates the novel command's chapter: integer 1..5000.
export function validChapter(n) {
  return Number.isInteger(n) && n >= 1 && n <= MAX_CHAPTER;
}

// Strip site suffixes like " - Chapter 5 | NovelFull" without cutting hyphenated titles.
export function cleanTitle(raw) {
  const t = String(raw || "").replace(/\s+/g, " ").trim();
  const cut = t.search(/\s[-–|•]\s(?:chapter|ch\.?|read|novel|online|free|[a-z0-9.]+\.(?:com|net|org))/i);
  return (cut > 0 ? t.slice(0, cut) : t).trim();
}

// ---- challenge / filtering ---------------------------------------------------------
const CHALLENGE_MARKERS = [
  /<title>\s*just a moment/i, /cf-browser-verification/i, /cf-chl-/i, /challenge-platform/i,
  /checking your browser before accessing/i, /<title>\s*attention required!?\s*\|\s*cloudflare/i, /cf-turnstile/i,
];
export const isChallengePage = (html) => {
  const head = String(html || "").slice(0, 20000);
  return CHALLENGE_MARKERS.some((re) => re.test(head));
};

const AD_WORDS = ["novelfull.com", "boxnovel", "novelmt.com", "mtlnovel.me", "advertisement", "report chapter", "table of contents", "access denied", "enable javascript", "read more at"];
const NAV_LINE = /^\s*(?:next|prev(?:ious)?)\s+chapter\s*[»>«<→←]*\s*$/i;
const STOLEN = [
  /stol(en|e)\s+(content|chapter|novel)/i, /(this|the)\s+(chapter|content|novel)\s+(is|was)\s+stolen/i,
  /if\s+you('| a)re\s+reading\s+this\s+on/i, /please\s+read\s+(this|it)\s+on\s+(the\s+)?original/i,
  /unauthorized\s+(use|reproduction|copy)/i, /support\s+the\s+(author|translator)\s+by\s+reading/i,
];
export function isFiltered(t) {
  const s = String(t || "");
  const lower = s.toLowerCase();
  if (NAV_LINE.test(s)) return true;
  if (AD_WORDS.some((w) => lower.includes(w))) return true;
  return STOLEN.some((re) => re.test(s));
}
export function cleanText(t) {
  return String(t || "").replace(/ /g, " ").replace(/[•◆▪]{2,}/g, " ").replace(/\.{4,}/g, "...").replace(/\s{2,}/g, " ").trim();
}
// A paragraph counts if it has at least one letter/digit (short dialogue like "No." survives).
const keep = (t) => /[\p{L}\p{N}]/u.test(t) && !isFiltered(t);

export function extractContent($, selectors) {
  let container = null;
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length) { container = el; break; }
  }
  if (!container) return null;
  container.find("script,style,ins,.ads,.ad,noscript").remove();
  let paras = [];
  container.find("p").each((_, el) => {
    const t = cleanText($(el).text());
    if (keep(t)) paras.push(t);
  });
  if (paras.length < 3) {
    const alt = container.text().split(/\n+/).map(cleanText).filter(keep);
    if (alt.length > paras.length) paras = alt;
  }
  return paras.length ? paras : null;
}

// ---- NovelFull index parsing -----------------------------------------------------------
export function chapterHrefRegex(n) {
  return new RegExp(`/chapter-${Number(n)}(?=[-._/?#]|$)[^"'\\s]*\\.html`, "i");
}
export function findChapterLink(html, n, base = "https://novelfull.com") {
  const re = chapterHrefRegex(n);
  const $ = cheerio.load(html);
  let found = null;
  const nums = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/\/chapter-(\d+)/i);
    if (m) nums.push(Number(m[1]));
    if (!found && re.test(href)) found = new URL(href, base).href;
  });
  return { url: found, min: nums.length ? Math.min(...nums) : null, max: nums.length ? Math.max(...nums) : null };
}
export function lastIndexPage(html) {
  const $ = cheerio.load(html);
  let max = 1;
  $("a[href*='page=']").each((_, el) => {
    const m = ($(el).attr("href") || "").match(/[?&]page=(\d+)/);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return max;
}
// Pages to probe, most likely first (50 chapters per page), bounded.
export function pageOrder(n, last, perPage = 50, cap = 40) {
  const guess = Math.min(last, Math.max(1, Math.ceil(n / perPage)));
  const out = [guess];
  for (let d = 1; out.length < cap && (guess - d >= 1 || guess + d <= last); d++) {
    if (guess + d <= last) out.push(guess + d);
    if (guess - d >= 1) out.push(guess - d);
  }
  return out.slice(0, cap);
}

// ---- translation ------------------------------------------------------------------------
const SEP = " ||| ";
export function splitLongParagraph(p, maxLen) {
  if (p.length <= maxLen) return [p];
  const sentences = p.match(/[^.!?؟،]+[.!?؟،]*/g) || [p];
  const out = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > maxLen && cur) { out.push(cur); cur = s; } else cur += s;
  }
  if (cur) out.push(cur);
  return out.flatMap((x) => (x.length > maxLen ? x.match(new RegExp(`[\\s\\S]{1,${maxLen}}`, "g")) : [x]));
}
export function chunkParagraphs(paragraphs, maxChunk = 4e4) {
  const safe = paragraphs.flatMap((p) => splitLongParagraph(p, maxChunk));
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const p of safe) {
    const add = p.length + SEP.length;
    if (cur.length && len + add > maxChunk) { chunks.push(cur); cur = []; len = 0; }
    cur.push(p); len += add;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
// translate(text) -> string. Verifies the separator count of every chunk; a chunk that comes back
// misaligned is retried once, then paragraph-by-paragraph; leftovers stay original and are counted.
export async function translateBatch(paragraphs, { translate, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), delayMs = 300 } = {}) {
  if (!paragraphs?.length) return { paragraphs: [], failed: 0 };
  const arabic = paragraphs.join("").match(/[؀-ۿ]/g);
  if (arabic && arabic.length > 50) return { paragraphs, failed: 0 };
  const out = [];
  let failed = 0;
  const chunks = chunkParagraphs(paragraphs);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    let parts = null;
    for (let attempt = 0; attempt < 2 && !parts; attempt++) {
      try {
        const res = await translate(chunk.join(SEP));
        const split = String(res || "").split("|||").map((s) => s.trim());
        if (split.length === chunk.length && split.every(Boolean)) parts = split;
      } catch { /* retry */ }
    }
    if (!parts) {
      parts = [];
      for (const p of chunk) {
        try { parts.push((await translate(p)) || p); } catch { parts.push(p); failed++; }
      }
    }
    out.push(...parts);
    if (i < chunks.length - 1) await sleep(delayMs);
  }
  return { paragraphs: out, failed };
}
const arabicRatio = (text) => {
  const total = text.replace(/\s/g, "").length;
  return total ? (text.match(/[؀-ۿ]/g) || []).length / total : 1;
};
export const isEnglishHeavy = (t) => arabicRatio(t) < 0.4;
export async function verifyTranslation(paragraphs, { translate, maxRetries = 20 } = {}) {
  let incomplete = false;
  let retries = 0;
  const verified = [];
  for (const para of paragraphs) {
    if (!isEnglishHeavy(para) || !/[A-Za-z]{3}/.test(para)) { verified.push(para); continue; }
    if (retries >= maxRetries) { incomplete = true; verified.push(para); continue; }
    retries++;
    try {
      const r = await translate(para);
      if (!r || isEnglishHeavy(r)) incomplete = true;
      verified.push(r || para);
    } catch { incomplete = true; verified.push(para); }
  }
  return { paragraphs: verified, incomplete };
}

// ---- fetching ---------------------------------------------------------------------------
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
export const NOVEL_HOSTS = ["allnovelfull.net", "novelfull.com", "novelfire.net", "inovelhub.com", "novelcrest.com", "wuxiabox.com"];

// Public CORS proxies are opt-in: NOVEL_PROXIES="https://p.example/raw?url={url},..."
export function proxyTemplates(env = process.env) {
  return String(env.NOVEL_PROXIES || "").split(",").map((s) => s.trim()).filter((s) => /^https:\/\/.+\{url\}/.test(s));
}
export function makeFetchHtml({ env = process.env, fetch = fetchText } = {}) {
  return async function fetchHtml(url, { signal } = {}) {
    const attempts = [{ url, hosts: NOVEL_HOSTS }, ...proxyTemplates(env).map((t) => ({ url: t.replace("{url}", encodeURIComponent(url)), hosts: null }))];
    let last = null;
    for (const a of attempts) {
      if (signal?.aborted) throw new AppError("timeout", "aborted");
      try {
        const html = await fetch(a.url, { timeoutMs: 15000, signal, allowHosts: a.hosts || undefined, headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" } });
        if (html.length < 500 || isChallengePage(html)) { last = new AppError("upstream", "challenge_or_empty"); continue; }
        return html;
      } catch (e) {
        if (e?.code === "timeout" && signal?.aborted) throw e;
        last = e;
      }
    }
    throw last instanceof AppError ? last : new AppError("upstream", "fetch_failed", { cause: last });
  };
}

export const SITES = [
  { name: "AllNovelFull", url: (s, n) => `https://allnovelfull.net/${s}/chapter-${n}.html`, selectors: ["#chapter-content", ".chapter-content", ".text-content"], titleSel: [".truyen-title", "h3.title", "title"] },
  { name: "NovelFull", index: (s) => `https://novelfull.com/${s}.html`, selectors: ["#chapter-content", ".chapter-content", ".text-left"], titleSel: [".truyen-title", "h3.title", "title"] },
  { name: "NovelFire", url: (s, n) => `https://novelfire.net/book/${s}/chapter-${n}`, selectors: [".chapter-content", "#chapter-content", "div.content", ".reading-content", "article"], titleSel: [".novel-title", "h1", "title"] },
  { name: "INovelHub", url: (s, n) => `https://inovelhub.com/novel/${s}/chapter-${n}`, selectors: ["#chapter-content", ".chapter-content", ".entry-content", "article .content"], titleSel: [".novel-title", "h1", "title"] },
  { name: "NovelCrest", url: (s, n) => `https://www.novelcrest.com/book/${s}/${n}.html`, alt: (s, n) => `https://www.novelcrest.com/book/${s}-2/${n}.html`, selectors: ["#chr-content", ".chr-c"], titleSel: [".chr-title", "h1", "title"] },
];
export const WUXIABOX = { name: "WuxiaBox", url: (s, n) => `https://www.wuxiabox.com/novel/${s}_${n}.html`, selectors: ["article#chapter-article", "div.chapter-content", ".page-in"], titleSel: [".truyen-title", "h1", "title"] };

function pickTitle($, site, fallback) {
  for (const sel of site.titleSel) {
    const t = cleanTitle($(sel).first().text());
    if (t.length > 2) return t;
  }
  return fallback;
}
function build($, site, name, n, url) {
  const paragraphs = extractContent($, site.selectors);
  if (!paragraphs || paragraphs.length < 2) throw new AppError("not_found", "empty_content");
  return { title: pickTitle($, site, name), chapterTitle: `الفصل ${n}`, paragraphs, url, siteName: site.name };
}

// WuxiaBox cache bounded by bytes (stores html strings only).
export const wuxiaCache = new LRU({ maxEntries: 40, maxBytes: 8 * 1024 * 1024, ttlMs: 15 * 60_000 });

export async function resolveWuxiaBox(slug, n, { fetchHtml, signal, deadline = Date.now() + 25000, range = 15 }) {
  const key = `${slug}:${n}`;
  const hit = wuxiaCache.get(key);
  if (hit) return hit;
  const idxs = [n];
  for (let i = 1; i <= range; i++) idxs.push(n + i, n - i);
  for (const idx of idxs) {
    if (idx < 1) continue;
    if (signal?.aborted || Date.now() > deadline) throw new AppError("timeout", "wuxiabox_deadline");
    const url = WUXIABOX.url(slug, idx);
    let html;
    try { html = await fetchHtml(url, { signal }); } catch (e) { if (e?.code === "timeout") throw e; continue; }
    const $ = cheerio.load(html);
    const head = [$("title").text(), $("h2").first().text(), $("h3").first().text(), $(".chapter-title").first().text()].join(" ");
    const m = head.match(/chapter\s*(\d+)/i);
    if (m ? Number(m[1]) === n : idx === n) {
      const r = { url, html };
      wuxiaCache.set(key, r);
      return r;
    }
  }
  return null;
}

// fetchChapter(site, name, n, { fetchHtml, signal }) -> { title, chapterTitle, paragraphs, url, siteName }
export async function fetchChapter(site, name, n, { fetchHtml = makeFetchHtml(), signal, deadline } = {}) {
  const slug = slugify(name);
  if (!slug) throw new AppError("bad_args", "non_latin_name");
  if (site.name === "WuxiaBox") {
    const r = await resolveWuxiaBox(slug, n, { fetchHtml, signal, deadline });
    if (!r) throw new AppError("not_found", "wuxiabox_chapter");
    return build(cheerio.load(r.html), site, name, n, r.url);
  }
  if (site.index) {
    const indexUrl = site.index(slug);
    const first = await fetchHtml(indexUrl, { signal });
    let link = findChapterLink(first, n).url;
    if (!link) {
      const last = lastIndexPage(first);
      for (const page of pageOrder(n, last)) {
        if (signal?.aborted) throw new AppError("timeout", "aborted");
        try {
          const r = findChapterLink(await fetchHtml(`${indexUrl}?page=${page}`, { signal }), n);
          if (r.url) { link = r.url; break; }
        } catch (e) { if (e?.code === "timeout") throw e; }
      }
    }
    if (!link) throw new AppError("not_found", "chapter_link");
    return build(cheerio.load(await fetchHtml(link, { signal })), site, name, n, link);
  }
  let url = site.url(slug, n);
  try {
    const $ = cheerio.load(await fetchHtml(url, { signal }));
    return build($, site, name, n, url);
  } catch (e) {
    if (!site.alt) throw e;
    url = site.alt(slug, n);
    return build(cheerio.load(await fetchHtml(url, { signal })), site, name, n, url);
  }
}

// ---- HF bridge (token only to https + allowlisted host) ---------------------------------
export class NeedsSelectionError extends Error {
  constructor(candidates, site) {
    super("needs_selection");
    this.candidates = candidates;
    this.site = site;
  }
}
export async function fetchFromBridge(name, n, { target = hfTarget(), getJson = fetchJson, signal } = {}) {
  if (!target) throw new AppError("not_configured", "hf_not_configured");
  let data;
  try {
    data = await getJson(`${target.base}/novel`, { method: "POST", body: { novel: name, chapter: n }, headers: target.headers, allowHosts: [target.host], timeoutMs: 60000, signal });
  } catch (e) {
    if (e?.status === 404) throw new AppError("not_found", "bridge_404");
    throw e;
  }
  if (data?.need_selection) throw new NeedsSelectionError((data.candidates || []).slice(0, 10), data.site || "");
  if (!data?.paragraphs?.length) throw new AppError("not_found", "empty_content");
  return { title: data.title || name, chapterTitle: `الفصل ${n}`, paragraphs: data.paragraphs, siteName: data.site || "HF" };
}

export const cacheKey = (site, name, n) => `${site}:${slugify(name) || String(name).trim().toLowerCase()}:${n}`;
