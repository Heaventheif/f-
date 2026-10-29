"use strict";

import googletrans from "googletrans";
import * as cache from "./cache.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
const MAX_TEXT_LEN = 15_000;
const CHUNK_LEN = 15_000;
const MIN_REQUEST_GAP_MS = 2_000;
const MAX_RETRIES = 1;
const RETRY_BACKOFF_MS = 2_000;
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1e3;
const BLOCK_COOLDOWN_MS = 60 * 60 * 1e3;
const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1e3;
const DISK_CACHE_FILE = path.resolve(process.cwd(), "data", "translator-cache.json");
const LANG_ALIASES = { zh: "zh-CN", "zh-cn": "zh-CN", "zh-tw": "zh-TW", tl: "fil", no: "nb", iw: "he" };

const diskCache = new Map();
let diskCacheLoaded = false;
let diskCacheLoadPromise = null;
let saveQueue = Promise.resolve();
let requestQueue = Promise.resolve();
let lastRequestAt = 0;
let providerCooldownUntil = 0;
let googletransClient = googletrans;

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

function responseStatus(error) {
  return Number(error?.response?.status || error?.status || 0);
}

function retryAfterMs(error) {
  const headers = error?.response?.headers;
  const value = headers?.get?.("retry-after") ?? headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (value == null) return 0;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1e3, MAX_COOLDOWN_MS);
  const dateMs = Date.parse(String(value)) - Date.now();
  return Number.isFinite(dateMs) && dateMs > 0 ? Math.min(dateMs, MAX_COOLDOWN_MS) : 0;
}

function openProviderCooldown(status, error) {
  const minimum = status === 403 ? BLOCK_COOLDOWN_MS : RATE_LIMIT_COOLDOWN_MS;
  const duration = Math.min(Math.max(minimum, retryAfterMs(error)), MAX_COOLDOWN_MS);
  providerCooldownUntil = Math.max(providerCooldownUntil, Date.now() + duration);
}

function isRetryable(error) {
  if (error?.code === "GOOGLETRANS_COOLDOWN") return false;
  const status = responseStatus(error);
  if (status === 403 || status === 429) return false;
  if (status) return status === 408 || status >= 500;
  return true;
}

async function queuedGoogletrans(text, targetLanguage) {
  const run = requestQueue.then(async () => {
    if (Date.now() < providerCooldownUntil) {
      const error = new Error("googletrans cooling down after an upstream limit");
      error.code = "GOOGLETRANS_COOLDOWN";
      throw error;
    }

    const wait = MIN_REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);

    if (Date.now() < providerCooldownUntil) {
      const error = new Error("googletrans cooling down after an upstream limit");
      error.code = "GOOGLETRANS_COOLDOWN";
      throw error;
    }

    lastRequestAt = Date.now();
    try {
      const result = await googletransClient(text, {
        to: normalizeLang(targetLanguage),
        raw: false,
      });
      const translated = typeof result?.text === "string" ? result.text.trim() : "";
      if (!translated) {
        const error = new Error("googletrans returned an empty translation");
        error.code = "GOOGLETRANS_EMPTY_RESULT";
        throw error;
      }
      return translated;
    } catch (error) {
      const status = responseStatus(error);
      if (status === 403 || status === 429) openProviderCooldown(status, error);
      throw error;
    }
  });

  requestQueue = run.catch(() => {});
  return run;
}

async function translateChunk(text, targetLanguage) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await queuedGoogletrans(text, targetLanguage);
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === MAX_RETRIES) break;
      await sleep(RETRY_BACKOFF_MS * (attempt + 1) + Math.floor(Math.random() * 500));
    }
  }
  throw lastError || new Error("googletrans translation failed");
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
      translatedChunks.push(translated);
      await setCached(normalizedTarget, chunk, translated);
    }

    const result = translatedChunks.join("");
    if (result.trim()) {
      await setCached(normalizedTarget, text, result);
      return result;
    }
  } catch (error) {
    const status = responseStatus(error);
    if (status === 429) {
      console.warn("[TRANSLATOR] googletrans rate limit; requests paused temporarily.");
    } else if (status === 403) {
      console.warn("[TRANSLATOR] googletrans access denied; requests paused temporarily.");
    } else if (error?.code === "GOOGLETRANS_COOLDOWN") {
      console.warn("[TRANSLATOR] googletrans cooldown is active.");
    } else {
      console.warn(`[TRANSLATOR] googletrans request failed (status=${status || "unknown"}).`);
    }
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
