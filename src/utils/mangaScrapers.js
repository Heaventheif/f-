import { load } from "cheerio";

export const STARZ_ORIGIN = "https://starzmanga.com";
export const STARZ_ONE_PIECE_URL = `${STARZ_ORIGIN}/manga/one-piece/`;
export const MANGALIK_ORIGIN = "https://mangalik.net";
export const MANGALIK_ONE_PIECE_SLUG = "pieceone";

export function normalizeMangaTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/×/g, "x")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function isOnePieceTitle(value) {
  const title = normalizeMangaTitle(value);
  return title.includes("onepiece") || title.includes("ونبيس") || title.includes("وانبيس");
}

export function normalizeChapterSlug(value) {
  const raw = String(value || "").trim().replace(/,/g, ".");
  if (!/^\d+(?:[._-]\d+)?$/.test(raw)) return null;
  return raw.replace(/[._](?=\d+$)/, "-");
}

export function buildStarzOnePieceChapterUrl(chapter) {
  const slug = normalizeChapterSlug(chapter);
  return slug ? `${STARZ_ONE_PIECE_URL}${encodeURIComponent(slug)}/` : null;
}

export function buildMangalikOnePieceChapterUrl(chapter) {
  const slug = normalizeChapterSlug(chapter);
  return slug ? `${MANGALIK_ORIGIN}/manga/${MANGALIK_ONE_PIECE_SLUG}/${encodeURIComponent(slug)}/` : null;
}

export function getMangaSourceOrder(title) {
  return isOnePieceTitle(title) ? ["StarzManga", "Mangalik"] : ["Mangalik"];
}

function isAllowedHost(hostname, source) {
  const host = String(hostname || "").toLowerCase();
  if (source === "StarzManga") {
    return host === "starzmanga.com" || host.endsWith(".starzmanga.com") ||
      host === "manga-starz.net" || host.endsWith(".manga-starz.net");
  }
  if (source === "Mangalik") {
    return host === "mangalik.net" || host.endsWith(".mangalik.net");
  }
  return false;
}

export function normalizeReaderImageUrl(value, source, baseUrl) {
  try {
    const url = new URL(value, baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || !isAllowedHost(url.hostname, source)) return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function buildMangalikSearchUrl(title) {
  const url = new URL("/", MANGALIK_ORIGIN);
  url.searchParams.set("s", String(title || "").trim());
  url.searchParams.set("post_type", "wp-manga");
  return url.href;
}

export function buildMangalikSearchTerms(title) {
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  const variants = [raw];
  const crossVariant = raw.replace(/\s+[x×]\s+/gi, " × ");
  const compactCrossVariant = crossVariant.replace(/\s*×\s*/g, "×");
  const asciiVariant = raw.replace(/×/g, "x");
  if (crossVariant) variants.push(crossVariant);
  if (compactCrossVariant) variants.push(compactCrossVariant);
  if (asciiVariant) variants.push(asciiVariant);
  return [...new Set(variants)].filter(Boolean).slice(0, 4);
}

function normalizeMangalikUrl(value, base = MANGALIK_ORIGIN) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" || !isAllowedHost(url.hostname, "Mangalik")) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function similarity(a, b) {
  const left = normalizeMangaTitle(a);
  const right = normalizeMangaTitle(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.5;
  const aPairs = [];
  const bPairs = [];
  for (let i = 0; i < left.length - 1; i++) aPairs.push(left.slice(i, i + 2));
  for (let i = 0; i < right.length - 1; i++) bPairs.push(right.slice(i, i + 2));
  if (!aPairs.length || !bPairs.length) return 0;
  const counts = new Map();
  for (const pair of bPairs) counts.set(pair, (counts.get(pair) || 0) + 1);
  let matches = 0;
  for (const pair of aPairs) {
    const count = counts.get(pair) || 0;
    if (count) {
      matches++;
      counts.set(pair, count - 1);
    }
  }
  return (2 * matches) / (aPairs.length + bPairs.length);
}

export function parseMangalikSearchResults(html) {
  const $ = load(String(html || ""));
  const results = new Map();
  $("a[href*='/manga/']").each((_, element) => {
    const anchor = $(element);
    const url = normalizeMangalikUrl(anchor.attr("href"));
    if (!url) return;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || segments[0] !== "manga") return;
    const container = anchor.closest(".c-tabs-item");
    const title = container.find(".post-title a").first().text().trim() ||
      anchor.attr("title") || anchor.find("img").attr("alt") || anchor.text().trim() ||
      decodeURIComponent(segments[1]).replace(/[-_]+/g, " ");
    const canonicalUrl = `${MANGALIK_ORIGIN}/manga/${segments[1]}/`;
    if (!results.has(canonicalUrl)) results.set(canonicalUrl, { title, url: canonicalUrl });
  });
  return [...results.values()];
}

export function pickBestMangalik(title, candidates, minimumScore = 0.22) {
  let best = null;
  let bestScore = 0;
  for (const candidate of candidates || []) {
    let slug = "";
    try { slug = new URL(candidate.url).pathname.split("/").filter(Boolean).at(-1) || ""; } catch {}
    const score = Math.max(similarity(title, candidate.title), similarity(title, slug));
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= minimumScore ? { manga: best, score: bestScore } : { manga: null, score: bestScore };
}

export function buildMangalikChapterUrl(mangaUrl, chapter) {
  const safeUrl = normalizeMangalikUrl(mangaUrl);
  const slug = normalizeChapterSlug(chapter);
  if (!safeUrl || !slug) return null;
  const segments = safeUrl.pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] !== "manga") return null;
  return `${MANGALIK_ORIGIN}/manga/${segments[1]}/${encodeURIComponent(slug)}/`;
}

export function normalizeChapterNumber(value) {
  return String(value || "").trim().replace(/,/g, ".").replace(/[ _-](?=\d+$)/, ".");
}

export function findMangalikChapterRedirect(html, mangaUrl, chapter) {
  const target = normalizeChapterNumber(chapter);
  const $ = load(String(html || ""));
  let result = null;
  $("select.single-chapter-select option[data-redirect]").each((_, element) => {
    if (result) return;
    const option = $(element);
    const redirect = normalizeMangalikUrl(option.attr("data-redirect"), mangaUrl);
    if (!redirect) return;
    const lastSegment = decodeURIComponent(redirect.pathname.split("/").filter(Boolean).at(-1) || "");
    if ([option.text().trim(), option.attr("value"), lastSegment].some(value => normalizeChapterNumber(value) === target)) {
      result = redirect.href;
    }
  });
  return result;
}

export function extractReaderImages(html, chapterUrl, source) {
  const $ = load(String(html || ""));
  const images = [];
  const seen = new Set();
  $(".reading-content img.wp-manga-chapter-img, .reading-content .page-break img").each((_, element) => {
    const image = $(element);
    const raw = image.attr("data-src") || image.attr("data-lazy-src") || image.attr("data-original") || image.attr("src");
    const url = normalizeReaderImageUrl(raw, source, chapterUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    images.push(url);
  });
  return images;
}

export function getFirecrawlHtml(response) {
  const html = response?.data?.html ?? response?.html;
  return typeof html === "string" ? html : "";
}
