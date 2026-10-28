"use strict";

import * as cache from "./cache.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getHfBase, getInternalToken } from "./hfClient.js";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
const MAX_TEXT_LEN = 45e3;
const CHUNK_LEN = 3500;
const REQUEST_TIMEOUT_MS = 25e3;
const MIN_REQUEST_GAP_MS = 900;
const MAX_RETRIES = 4;
const HF_TRANSLATION_PROVIDER = "go-translate";
const DISK_CACHE_FILE = path.resolve(process.cwd(), "data", "translator-cache.json");
const LANG_ALIASES = { zh: "zh-CN", "zh-cn": "zh-CN", "zh-tw": "zh-TW", tl: "fil", no: "nb", iw: "he" };

const diskCache = new Map();
let diskCacheLoaded = false;
let diskCacheLoadPromise = null;
let saveQueue = Promise.resolve();
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

function normalizeLang(code) {
  const language = String(code || "").trim();
  return LANG_ALIASES[language.toLowerCase()] || language;
}

function cacheKey(language, text) {
  const digest = createHash("sha256").update(text).digest("hex");
  return `${normalizeLang(language)}:${digest}`;
}

async function loadDiskCache() {
  if (diskCacheLoaded) return;
  if (diskCacheLoadPromise) return diskCacheLoadPromise;

  diskCacheLoadPromise = (async () => {
    try {
      const parsed = JSON.parse(await readFile(DISK_CACHE_FILE, "utf8"));
      const now = Date.now();
      for (const [key, entry] of Object.entries(parsed)) {
        if (entry && typeof entry.value === "string" && entry.expiresAt > now) {
          diskCache.set(key, entry);
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        console.warn("[TRANSLATOR] Could not load disk cache:", String(error?.message || error).slice(0, 120));
      }
    } finally {
      diskCacheLoaded = true;
      diskCacheLoadPromise = null;
    }
  })();

  return diskCacheLoadPromise;
}

function persistDiskCache() {
  saveQueue = saveQueue
    .then(async () => {
      await mkdir(path.dirname(DISK_CACHE_FILE), { recursive: true });
      const temporaryFile = `${DISK_CACHE_FILE}.tmp`;
      await writeFile(temporaryFile, JSON.stringify(Object.fromEntries(diskCache)), "utf8");
      await rename(temporaryFile, DISK_CACHE_FILE);
    })
    .catch((error) => {
      console.warn("[TRANSLATOR] Could not save disk cache:", String(error?.message || error).slice(0, 120));
    });
  return saveQueue;
}

function getCached(language, text) {
  const key = cacheKey(language, text);
  const entry = diskCache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  if (entry) diskCache.delete(key);

  const memoryValue = cache.get(`tr_${normalizeLang(language)}:${text}`);
  return typeof memoryValue === "string" ? memoryValue : null;
}

async function setCached(language, text, value) {
  const key = cacheKey(language, text);
  diskCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  cache.set(`tr_${normalizeLang(language)}:${text}`, value, CACHE_TTL_MS);
  await persistDiskCache();
}

function splitText(text, maxLength = CHUNK_LEN) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < maxLength * 0.45) cut = remaining.lastIndexOf(" ", maxLength);
    if (cut < maxLength * 0.45) cut = maxLength;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function queuedRequest(url, options = {}) {
  const run = requestQueue.then(async () => {
    const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    return fetchWithRetry(url, options);
  });
  requestQueue = run.catch(() => {});
  return run;
}

async function fetchWithRetry(url, options = {}) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent": "SunkenBot/5.0",
          ...(options.headers || {}),
        },
      });

      if ([429, 502, 503, 504].includes(response.status)) {
        const error = new Error(`Translation HTTP ${response.status}`);
        error.retryAfter = Number(response.headers.get("retry-after")) * 1e3 || 0;
        throw error;
      }
      if (!response.ok) throw new Error(`Translation HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      const retryable =
        error?.name === "AbortError" ||
        error?.retryAfter ||
        /fetch failed|network|HTTP 429|HTTP 502|HTTP 503|HTTP 504/i.test(String(error?.message || error));
      if (!retryable || attempt === MAX_RETRIES) break;

      const exponentialDelay = Math.min(30e3, 1500 * 2 ** attempt);
      await sleep(Math.max(exponentialDelay, error.retryAfter || 0) + Math.floor(Math.random() * 500));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error("Translation request failed");
}

async function translateViaHfSpace(text, targetLanguage) {
  const baseUrl = getHfBase();
  const token = String(getInternalToken() || "").trim();
  if (!token) throw new Error("INTERNAL_TOKEN غير مضبوط للوصول إلى Hugging Face Space");

  const data = await queuedRequest(`${baseUrl}/translate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Internal-Token": token,
    },
    body: JSON.stringify({
      text,
      to: targetLanguage,
      provider: HF_TRANSLATION_PROVIDER,
    }),
  });

  const translated = typeof data?.text === "string" ? data.text.trim() : "";
  return translated || null;
}

async function translateChunk(text, targetLanguage) {
  return translateViaHfSpace(text, targetLanguage);
}

async function translateText(text, targetLanguage, fallbackToOriginal = true) {
  if (typeof text !== "string" || !text.trim()) return text;
  if (text.length > MAX_TEXT_LEN) return fallbackToOriginal ? text : null;

  const normalizedTarget = normalizeLang(targetLanguage);
  await loadDiskCache();
  const fullCached = getCached(normalizedTarget, text);
  if (fullCached) return fullCached;

  try {
    const chunks = splitText(text);
    const translatedChunks = [];

    for (const chunk of chunks) {
      const chunkCached = getCached(normalizedTarget, chunk);
      if (chunkCached) {
        translatedChunks.push(chunkCached);
        continue;
      }

      const translated = await translateChunk(chunk, normalizedTarget);
      if (!translated) throw new Error("Empty translation response");
      translatedChunks.push(translated);
      await setCached(normalizedTarget, chunk, translated);
    }

    const result = translatedChunks.join("");
    if (result.trim()) {
      await setCached(normalizedTarget, text, result);
      return result;
    }
  } catch (error) {
    console.warn("[TRANSLATOR] Translation endpoint:", String(error?.message || error).slice(0, 120));
  }

  return fallbackToOriginal ? text : null;
}

async function translateTextStrict(text, targetLanguage) {
  return translateText(text, targetLanguage, false);
}

async function translateToArabic(text) {
  if (!text?.trim()) return text;
  const letters = text.match(/\p{L}/gu) || [];
  const arabic = text.match(/[\u0600-\u06FF]/g) || [];
  if (letters.length && arabic.length > letters.length * 0.3) return text;
  return translateText(text, "ar");
}

async function translateToEnglish(text) {
  if (!text?.trim()) return text;
  const letters = text.match(/\p{L}/gu) || [];
  const latin = text.match(/[A-Za-z]/g) || [];
  if (letters.length && latin.length > letters.length * 0.8) return text;
  return translateText(text, "en");
}

export { translateTextStrict, translateToArabic, translateToEnglish };
