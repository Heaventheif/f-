// ONE shared argument parser for manga / mangalik / comic / novel.
export const LANG_ALIASES = {
  ar: "ar", arabic: "ar", عربي: "ar", عربية: "ar",
  en: "en", eng: "en", english: "en", انجليزي: "en", إنجليزي: "en",
  ja: "ja", jp: "ja", japanese: "ja", ياباني: "ja",
};
export const LANG_LABELS = { ar: "العربية", en: "الإنجليزية", ja: "اليابانية" };

const AR_DIGITS = /[٠-٩]/g;
export const normDigits = (s) =>
  String(s ?? "").replace(AR_DIGITS, (d) => String(d.charCodeAt(0) - 1632));

// "#5", "5", "5.5", "5,5", "ch5", "chapter 5" handled by caller joining; leading zeros stripped.
const CHAPTER_RE = /^(?:#|ch\.?|chapter)?(\d{1,5}(?:[.,]\d{1,2})?)$/i;

export function parseChapterToken(token, { maxChapter = 5000, yearLike = false } = {}) {
  const raw = normDigits(token).trim();
  const m = raw.match(CHAPTER_RE);
  if (!m) return null;
  const explicit = raw.startsWith("#");
  const str = m[1].replace(",", ".");
  const num = Number(str);
  if (!Number.isFinite(num) || num < 0 || num > maxChapter) return null;
  // "Spider-Man 2099": a bare year-like number is part of the title unless written "#2099".
  if (yearLike && !explicit && /^\d{4}$/.test(str) && num >= 1900 && num <= 2199) return null;
  const [i, f] = str.split(".");
  const norm = f !== undefined && Number(f) !== 0 ? `${Number(i)}.${f.replace(/0+$/, "")}` : String(Number(i));
  return { chapter: norm, number: Number(norm) };
}

// parseChapter(args) -> { name, chapter|null, number|null, lang|null }
// Accepts `naruto`, `naruto 5`, `naruto en`, `naruto 5 en`, `naruto en 5`.
export function parseChapter(args, opts = {}) {
  const tokens = (Array.isArray(args) ? args : String(args || "").split(/\s+/))
    .map((t) => String(t).trim())
    .filter(Boolean);
  let lang = null;
  const langOf = (t) => LANG_ALIASES[t.toLowerCase()] || null;
  if (tokens.length >= 2) {
    const l = langOf(tokens[tokens.length - 1]);
    if (l) {
      lang = l;
      tokens.pop();
    }
  }
  let chapter = null;
  let number = null;
  if (tokens.length >= 2) {
    const c = parseChapterToken(tokens[tokens.length - 1], opts);
    if (c) {
      ({ chapter, number } = c);
      tokens.pop();
      // `naruto en 5`
      if (!lang && tokens.length >= 2) {
        const l = langOf(tokens[tokens.length - 1]);
        if (l) {
          lang = l;
          tokens.pop();
        }
      }
    }
  }
  return { name: tokens.join(" ").trim(), chapter, number, lang };
}
