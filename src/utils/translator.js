"use strict";
import * as cache from "./cache.js";
import TranslationClient from "@toil/translate";

const CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_TEXT_LEN = 45_000; // أقل من حد MSEdge (50k حرف/طلب) بهامش أمان
const TIMEOUT_SHORT_MS = 15_000;
const TIMEOUT_LONG_MS = 40_000; // للنصوص الكبيرة (chunks الرواية)
const LONG_TEXT_LEN = 5_000;
const DETECT_SAMPLE_LEN = 500;

// ملاحظة: المكتبة لا تُصدّر enum الخدمات وقت التشغيل (types فقط)، فنمرّر القيمة النصية.
// لاستبدال الخدمة: "yandexbrowser" (حد 10k) أو "yandextranslate" (حد 10k).
// fetchOpts.timeout ضروري: الافتراضي في المكتبة 3 ثوانٍ فقط وقد يُسقط الطلبات الكبيرة.
const client = new TranslationClient({
  service: "msedge",
  fetchOpts: { timeout: TIMEOUT_LONG_MS },
});

// رموز اللغات في tr.js ← رموز Microsoft Translator
const LANG_ALIASES = {
  zh: "zh-Hans", "zh-cn": "zh-Hans", "zh-tw": "zh-Hant",
  tl: "fil", no: "nb", iw: "he",
};

function normalizeLang(code) {
  const c = String(code || "").trim();
  return LANG_ALIASES[c.toLowerCase()] || c;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: انتهت المهلة بعد ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function isMostlyArabic(text) {
  const letters = text.match(/\p{L}/gu);
  if (!letters) return false;
  const arabic = text.match(/[\u0600-\u06FF]/g);
  return !!arabic && arabic.length > letters.length * 0.3;
}

/**
 * المكتبة تفترض لغة المصدر "en" إن مرّرنا رمز الهدف فقط ("ar" = en→ar)،
 * فنحدد المصدر صراحةً: العربية بالفحص المحلي، وغير ذلك عبر client.detect على عيّنة صغيرة.
 */
async function resolveSourceLang(text) {
  if (isMostlyArabic(text)) return "ar";
  try {
    const sample = text.slice(0, DETECT_SAMPLE_LEN);
    const res = await withTimeout(client.detect(sample), TIMEOUT_SHORT_MS, "detect");
    if (res?.lang) return String(res.lang);
  } catch (_) {}
  return "en";
}

async function callTranslate(text, targetLang) {
  const to = normalizeLang(targetLang);
  const from = await resolveSourceLang(text);
  // النص بلغة الهدف أصلًا — لا حاجة لطلب ترجمة
  if (from.toLowerCase() === to.toLowerCase()) return text;
  // المكتبة تفصل الزوج بـ "-"، فرمز مصدر فيه شرطة (zh-Hans) يُفسد التحليل → نكتفي بالجزء الأول
  const pair = `${from.split("-")[0]}-${to}`;
  const timeout = text.length > LONG_TEXT_LEN ? TIMEOUT_LONG_MS : TIMEOUT_SHORT_MS;
  const result = await withTimeout(client.translate(text, pair), timeout, "toil/translate");
  // الرد: { lang, translations: string[] }
  const out = result?.translations?.[0];
  return typeof out === "string" && out.trim() ? out.trim() : null;
}

async function translateText(text, targetLang, fallbackToOriginal = true) {
  if (!text?.trim()) return text;
  if (text.length > MAX_TEXT_LEN) return fallbackToOriginal ? text : null;

  const key = `tr_${targetLang}:${text}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const result = await callTranslate(text, targetLang);
    if (result) {
      cache.set(key, result, CACHE_TTL_MS);
      return result;
    }
  } catch (e) {
    console.warn("[TRANSLATOR] toil/translate:", e.message?.substring(0, 100));
  }
  return fallbackToOriginal ? text : null;
}

async function translateTextStrict(text, targetLang) {
  return translateText(text, targetLang, false);
}

async function translateToArabic(text) {
  if (!text?.trim()) return text;
  if (/[\u0600-\u06FF]/.test(text) && text.match(/[\u0600-\u06FF]/g).length > text.length * 0.3) {
    return text;
  }
  return translateText(text, "ar");
}

async function translateToEnglish(text) {
  if (!text?.trim()) return text;
  const nonAsciiLetters = text.match(/[^\x00-\x7F]/g);
  if (!nonAsciiLetters || nonAsciiLetters.length < text.length * 0.15) {
    return text;
  }
  return translateText(text, "en");
}

export { translateTextStrict, translateToArabic, translateToEnglish };
