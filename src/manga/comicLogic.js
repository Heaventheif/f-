// Pure helpers for the comic command (arcomixverse.blogspot.com archive).
import { parseChapterToken, normDigits } from "./parse.js";

export const COMIC_HOST = "arcomixverse.blogspot.com";
export const normalize = (s) => String(s ?? "").trim().toLowerCase();
const titleOf = (e) => String(e?.title?.["$t"] ?? "");
const linkOf = (e) => e?.link?.find?.((l) => l?.rel === "alternate")?.href || null;
export { titleOf, linkOf };

// Only https://arcomixverse.blogspot.com/... URLs are trusted for series/chapter pages.
export function isComicPageUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && x.hostname === COMIC_HOST && !x.username && !x.password;
  } catch { return false; }
}
// Image hosts: https only; blogger/google image CDNs + the blog itself.
const IMG_HOSTS = ["blogspot.com", "bp.blogspot.com", "googleusercontent.com", "blogger.googleusercontent.com", "ggpht.com"];
export function isComicImageUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" || x.username || x.password) return false;
    const h = x.hostname.toLowerCase();
    return IMG_HOSTS.some((a) => h === a || h.endsWith("." + a));
  } catch { return false; }
}

const isAnnualWord = (s) => /^(annual|سنوي)$/i.test(String(s).trim());
const looksLikeFullTitle = (s) => /^العدد(\s*السنوي)?\s*#?\d+(?:\.\d+)?$/i.test(normDigits(s).trim());
// -> { name, chapterQuery|null }. `Spider-Man 2099` keeps 2099 in the title; `#2099` is a chapter.
export function parseComicArgs(args) {
  const a = (args || []).map(String).filter(Boolean);
  const bare = (t) => !!parseChapterToken(t, { yearLike: true });
  if (a.length >= 2) {
    const last = a[a.length - 1], prev = a[a.length - 2];
    if (a.length >= 3 && isAnnualWord(prev) && bare(last)) return { name: a.slice(0, -2).join(" "), chapterQuery: `annual ${last}` };
    if (a.length >= 3 && isAnnualWord(last) && bare(prev)) return { name: a.slice(0, -2).join(" "), chapterQuery: `annual ${prev}` };
    if (bare(last) || looksLikeFullTitle(last)) return { name: a.slice(0, -1).join(" "), chapterQuery: last };
  }
  return { name: a.join(" "), chapterQuery: null };
}

export function findMangaInList(list, query) {
  const q = normalize(query);
  if (!q) return null;
  const L = list || [];
  let m = L.find((e) => normalize(titleOf(e)) === q) || L.find((e) => normalize(titleOf(e)).includes(q));
  if (m) return m;
  const words = q.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length >= 2) return L.find((e) => words.every((w) => normalize(titleOf(e)).includes(w))) || null;
  return null;
}
export function suggestSimilar(list, query, max = 8) {
  const words = normalize(query).split(/\s+/).filter((w) => w.length >= 3);
  return (list || [])
    .map((e) => ({ e, s: words.reduce((n, w) => n + (normalize(titleOf(e)).includes(w) ? w.length : 0), 0) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.e);
}

const isAnnualTitle = (t) => /سنوي|annual/i.test(t);
// matchChapter -> { match, ambiguous, candidates }. Numbers are compared with Number(), so "7.50" == "7.5".
export function matchChapter(chapters, query) {
  const q = String(query ?? "").trim();
  const none = { match: null, ambiguous: false, candidates: [] };
  if (!q) return none;
  const exact = (chapters || []).find((c) => titleOf(c).trim() === q);
  if (exact) return { match: exact, ambiguous: false, candidates: [] };
  const qn = normDigits(q);
  const m = qn.match(/(\d+(?:\.\d+)?)/);
  if (!m) return none;
  const target = Number(m[1]);
  const wantsAnnual = isAnnualTitle(qn);
  const candidates = (chapters || []).filter((c) => {
    const t = normDigits(titleOf(c));
    if (isAnnualTitle(t) !== wantsAnnual) return false;
    const tm = t.match(/#?(\d+(?:\.\d+)?)\s*$/) || t.match(/#?(\d+(?:\.\d+)?)/);
    return !!tm && Number(tm[1]) === target;
  });
  if (candidates.length === 1) return { match: candidates[0], ambiguous: false, candidates: [] };
  if (candidates.length > 1) return { match: null, ambiguous: true, candidates };
  return none;
}
