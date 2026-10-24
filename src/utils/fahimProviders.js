import http from "./fetchHttp.js";

const BASE_URL = "https://smfahim.xyz";
const USER_AGENT = "Mozilla/5.0 SunkenBot/4.0";

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .trim();
}

function textValue(value) {
  if (typeof value === "string") return decodeHtml(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = textValue(item);
      if (found) return found;
    }
  }
  return "";
}

export function extractTranslation(raw) {
  const candidates = [
    raw?.result,
    raw?.translation,
    raw?.translatedText,
    raw?.data?.translation,
    raw?.data?.translatedText,
    raw?.data?.texts?.map(item => item?.translation),
    raw?.raw?.data?.texts?.map(item => item?.translation),
    raw?.data?.result,
    raw?.data?.data?.translation,
  ];
  for (const candidate of candidates) {
    const value = textValue(candidate);
    if (value) return value;
  }
  return "";
}

function getTextFromKeys(raw, keys) {
  const roots = [raw, raw?.data, raw?.result, raw?.data?.data];
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    for (const key of keys) {
      const value = textValue(root[key]);
      if (value) return value;
    }
  }
  return "";
}

export function parseFactResponse(raw) {
  return getTextFromKeys(raw, ["fact", "text", "content", "result"]);
}

export function parseSurahResponse(raw) {
  const payload = raw?.data?.data || raw?.data || raw;
  const ayahs = payload?.ayahs;
  if (!Array.isArray(ayahs) || !ayahs.length) return null;
  return {
    number: Number(payload.number || payload.numberInSurah || 0),
    name: decodeHtml(payload.name || "السورة"),
    ayahs: ayahs.map((ayah, index) => ({
      number: Number(ayah.numberInSurah || ayah.number || index + 1),
      text: String(ayah.text || "").trim(),
    })).filter(ayah => ayah.text),
  };
}

async function getJson(path, params = {}, timeout = 12_000) {
  const response = await http.get(`${BASE_URL}${path}`, {
    params,
    timeout,
    retries: 0,
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
  });
  const data = response.data;
  if (!data || data.success === false || data.status === false) {
    throw new Error("أعاد مزود Fahim نتيجة غير ناجحة.");
  }
  return data;
}

export async function translateWithFahim(text, targetLang = "ar") {
  const input = String(text || "").trim();
  if (!input) return "";
  const providers = [
    { path: "/tools/translate/v7", params: { text: input, from: "auto", to: targetLang } },
    { path: "/tools/translate/v6", params: { text: input, to: targetLang, mode: "Creative" } },
    { path: "/tools/translate/v4", params: { text: input, from: "auto", to: targetLang } },
    { path: "/tools/translate/v3", params: { text: input, from: "auto", to: targetLang } },
  ];
  const errors = [];
  for (const provider of providers) {
    try {
      const data = await getJson(provider.path, provider.params, 6_500);
      const translated = extractTranslation(data);
      if (translated) return translated;
      errors.push(`${provider.path}: استجابة ترجمة فارغة`);
    } catch (error) {
      errors.push(`${provider.path}: ${error.message}`);
    }
  }
  console.warn(`[FAHIM:translate] تعذرت كل المحاولات (${errors.length})`);
  return null;
}

export async function getFahimFact() {
  const data = await getJson("/education/fact");
  const fact = parseFactResponse(data);
  if (!fact) throw new Error("لم تصل معلومة قابلة للعرض.");
  return fact;
}

export async function getFahimSurah(surahNumber) {
  const data = await getJson("/islamic/quran/v1", {
    surah: String(surahNumber),
    edition: "quran-simple",
  });
  const surah = parseSurahResponse(data);
  if (!surah || (surah.number && surah.number !== Number(surahNumber))) {
    throw new Error("لم تصل آيات صالحة من المصدر الاحتياطي.");
  }
  return surah;
}
