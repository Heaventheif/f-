"use strict";
import * as cache from "./cache.js";
import { translateWithFahim } from "./fahimProviders.js";
let _googleXTranslate = null;
let _bingTranslate = null;
(async () => {
  try { _googleXTranslate = (await import("google-translate-api-x")).translate; } catch (_) {}
  try { _bingTranslate = (await import("bing-translate-api")).translate; } catch (_) {}
})();
async function getGoogleXTranslate() {
  if (_googleXTranslate) return _googleXTranslate;
  return (_googleXTranslate = (await import("google-translate-api-x")).translate);
}
async function getBingTranslate() {
  if (_bingTranslate) return _bingTranslate;
  return (_bingTranslate = (await import("bing-translate-api")).translate);
}
const TIMEOUT_MS = 10000;      
const CACHE_TTL_MS = 60 * 60 * 1000; 
const MAX_TEXT_LEN = 5000;     
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: انتهت المهلة بعد ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function isRateLimited(e) {
  if (e?.statusCode === 429 || e?.status === 429 || e?.code === 429) return true;
  if (e?.name === "TooManyRequestsError") return true;
  const msg = String(e?.message || e || "").toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("rate limit") ||
    msg.includes("quota")
  );
}
function isProviderErrorText(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return (
    t.includes("query length limit exceeded") ||
    t.includes("max allowed query") ||
    text.includes("تجاوز حد طول الاستعلام") ||
    text.includes("الحد الأقصى المسموح به للاستعلام")
  );
}
const providers = [
  {
    name: "Google-X",
    blockedUntil: 0,
    cooldownMs: 10 * 60 * 1000,
    maxLen: MAX_TEXT_LEN,
    run: async (text, targetLang) => {
      const googleXTranslate = await getGoogleXTranslate();
      const res = await withTimeout(googleXTranslate(text, { to: targetLang }), TIMEOUT_MS, "Google-X");
      return res?.text ? String(res.text).trim() : null;
    }
  },
  {
    name: "Bing",
    blockedUntil: 0,
    cooldownMs: 15 * 60 * 1000,
    maxLen: MAX_TEXT_LEN,
    run: async (text, targetLang) => {
      const bingTranslate = await getBingTranslate();
      const res = await withTimeout(bingTranslate(text, null, targetLang), TIMEOUT_MS, "Bing");
      return res?.translation ? String(res.translation).trim() : null;
    }
  },
  {
    name: "Fahim",
    blockedUntil: 0,
    cooldownMs: 10 * 60 * 1000,
    maxLen: MAX_TEXT_LEN,
    run: async (text, targetLang) => translateWithFahim(text, targetLang)
  }
];
async function translateText(text, targetLang, fallbackToOriginal = true) {
  if (!text?.trim()) return text;
  const key = `tr_${targetLang}:${text}`;
  const cached = cache.get(key);
  if (cached) return cached;
  for (const provider of providers) {
    if (Date.now() < provider.blockedUntil) continue;
    if (provider.maxLen && text.length > provider.maxLen) continue;
    try {
      const result = await provider.run(text, targetLang);
      if (result && !isProviderErrorText(result)) {
        cache.set(key, result, CACHE_TTL_MS);
        return result;
      }
    } catch (e) {
      if (isRateLimited(e)) {
        provider.blockedUntil = Date.now() + provider.cooldownMs;
        console.warn(
          `[TRANSLATOR] حظر مؤقت لـ ${provider.name} (${provider.cooldownMs / 60000} دقيقة) — تحويل للمحرك التالي`
        );
      } else {
        console.warn(`[TRANSLATOR] خطأ في ${provider.name}:`, e.message?.substring(0, 80));
      }
    }
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

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-utils-translator',
  meta: { category: 'utils', path: 'src/utils/translator.js' },
  setup(_ctx) {
    // provides: translateToArabic, translateToEnglish
  },
};
