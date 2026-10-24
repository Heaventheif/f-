"use strict";
import http from "./fetchHttp.js";
import { get as cacheGet, set as cacheSet } from "./cache.js";

export const BETADASH_BASE = (process.env.BETADASH_API_BASE || "https://betadash-api-swordslush-production.up.railway.app").replace(/\/+$/, "");
const USER_AGENT = "SunkenBot/4.0 BetadashClient";
const MAX_ID = 20;
const MAX_TEXT = 180;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const WINDOW_MS = 10_000;
const MAX_REQUESTS = Math.max(1, Number(process.env.BETADASH_RATE_LIMIT || 8));
const requestTimes = [];
const inflight = new Map();

function trimText(value, max = MAX_TEXT) {
  return String(value ?? "").trim().slice(0, max);
}

export function validateUserId(value) {
  const id = String(value ?? "").trim();
  return /^\d{5,20}$/.test(id) ? id : null;
}

export function validateText(value, max = MAX_TEXT) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > max) return null;
  return raw;
}

export function assertImageResponse(data, headers = {}) {
  if (!Buffer.isBuffer(data) || data.length < 100 || data.length > MAX_BODY_BYTES) {
    throw new Error("invalid image payload");
  }
  const type = String(headers["content-type"] || "").toLowerCase();
  if (type && !type.startsWith("image/")) throw new Error("endpoint returned a non-image response");
  return { data, contentType: type || "image/png" };
}

function canonicalParams(params = {}) {
  return Object.keys(params).sort().map(key => `${key}=${encodeURIComponent(params[key])}`).join("&");
}

function rateLimitWait() {
  const now = Date.now();
  while (requestTimes[0] && requestTimes[0] <= now - WINDOW_MS) requestTimes.shift();
  if (requestTimes.length < MAX_REQUESTS) {
    requestTimes.push(now);
    return 0;
  }
  return Math.max(25, requestTimes[0] + WINDOW_MS - now);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function retryAfterMs(error) {
  const value = error?.response?.headers?.["retry-after"];
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.min(15_000, Math.max(250, seconds * 1000)) : 0;
}

function isRetryable(error) {
  const status = error?.response?.status;
  return !status || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function requestImage(endpoint, params, { retries = 2, timeout = 30_000 } = {}) {
  const path = `/${String(endpoint).replace(/^\/+/, "")}`;
  const key = `betadash:image:${path}?${canonicalParams(params)}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);
  const promise = (async () => {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const wait = rateLimitWait();
      if (wait) await sleep(wait);
      try {
        const response = await http.get(`${BETADASH_BASE}${path}`, {
          params,
          responseType: "arraybuffer",
          timeout,
          retries: 0,
          headers: {
            Accept: "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5",
            "User-Agent": USER_AGENT,
            ...(process.env.BETADASH_API_KEY ? { Authorization: `Bearer ${process.env.BETADASH_API_KEY}` } : {}),
          },
        });
        const value = assertImageResponse(response.data, response.headers);
        cacheSet(key, value, 10 * 60 * 1000);
        return value;
      } catch (error) {
        lastError = error;
        if (attempt >= retries || !isRetryable(error)) break;
        const delay = retryAfterMs(error) || Math.min(5_000, 300 * (2 ** attempt) + Math.floor(Math.random() * 150));
        console.warn(`[BETADASH] retry endpoint=${path} attempt=${attempt + 1} wait=${delay}ms status=${error?.response?.status || error.code || "network"}`);
        await sleep(delay);
      }
    }
    throw lastError || new Error("Betadash request failed");
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export async function fetchImageWithFallback(candidates, options = {}) {
  const errors = [];
  for (const candidate of candidates) {
    try {
      return { ...await requestImage(candidate.endpoint, candidate.params, options), candidate };
    } catch (error) {
      errors.push(`${candidate.endpoint}:${error?.response?.status || error.message}`);
      console.warn(`[BETADASH] endpoint failed ${candidate.endpoint}: ${error.message}`);
    }
  }
  const error = new Error("all Betadash image endpoints failed");
  error.details = errors;
  throw error;
}

export async function fetchImagesBatch(requests, options = {}) {
  const unique = [...new Map(requests.map(item => [`${item.endpoint}?${canonicalParams(item.params)}`, item])).values()];
  const results = await Promise.all(unique.map(item => requestImage(item.endpoint, item.params, options).then(value => ({ ...value, item }))));
  return results;
}

export function formatProviderError(error, fallback = "تعذر توليد الصورة الآن؛ حاول مرة أخرى بعد قليل.") {
  const status = error?.response?.status;
  if (status === 429) return "الخدمة مشغولة مؤقتاً؛ انتظر قليلاً ثم أعد المحاولة.";
  if (status === 400 || status === 404) return "المدخلات غير صالحة أو التصميم غير متاح حالياً.";
  return fallback;
}

export const limits = { MAX_ID, MAX_TEXT, MAX_BODY_BYTES, MAX_REQUESTS, WINDOW_MS };
