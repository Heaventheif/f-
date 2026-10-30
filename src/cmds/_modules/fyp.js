"use strict";

import fs from "../../utils/fsCompat.js";
import { getTiktokApiUrl, downloadYYMedia } from "../../utils/yyApi.js";
import {
  hydrateRecentlySent,
  hasRecentlySent,
  rememberSent,
} from "../../utils/recentlySent.js";

/* ---------------- الإعدادات ---------------- */

const HELP =
  "📺 تيك توك\n\n" +
  "fyp <كلمة بحث أو رابط>   — تحميل أول نتيجة\n" +
  "fyp fyp                  — فيديو عشوائي (FYP)\n\n" +
  "(أو تيك_توك بدل fyp)";

const RANDOM_TERMS = [
  "fyp", "viral", "trending", "funny", "foryou",
  "comedy", "dance", "food", "nature", "music",
];

/* ---------------- ميزانيات الوقت (لتفادي تعليق البوت) ---------------- */

const FETCH_TIMEOUT_MS = 15_000;
const RETRY_TOTAL_BUDGET_MS = 20_000;
const SEARCH_BUDGET_MS = 25_000;
const RANDOM_BUDGET_MS = 45_000;
const RETRY_DELAYS_MS = [2500, 5000];

/* ---------------- أنماط الأخطاء ---------------- */

const BLOCK_RETRY_REGEX = /tiktok.*block|asked for a login|TIKTOK_PROXY|rate.?limit|too many|429/i;
const PURE_BLOCK_REGEX = /tiktok.*block|asked for a login|TIKTOK_PROXY/i;

/* ---------------- أدوات ---------------- */

const sleep = (ms) =>
  new Promise((r) => setTimeout(r, Math.max(0, ms + (Math.random() * 1000 - 500))));

/* ---------------- استعلام واحد مع إعادة محاولة ---------------- */

async function fetchWithRetry(query) {
  const startTime = Date.now();
  let lastError;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0 && Date.now() - startTime > RETRY_TOTAL_BUDGET_MS) {
      throw lastError || new Error("search budget exceeded");
    }

    try {
      const endpoint = new URL(`${getTiktokApiUrl()}/api/search`);
      endpoint.searchParams.set("q", query);
      endpoint.searchParams.set("limit", "1");
      endpoint.searchParams.set("format", "urls");

      const headers = {};
      if (process.env.TIKTOK_API_KEY?.trim()) {
        headers["x-api-key"] = process.env.TIKTOK_API_KEY.trim();
      }

      const response = await fetch(endpoint, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      const body = await response.text().catch(() => "");

      if (!response.ok) {
        let errorMessage = body.slice(0, 300);
        try {
          errorMessage = JSON.parse(body)?.error || errorMessage;
        } catch {}
        throw new Error(errorMessage || `TikTok Search API: HTTP ${response.status}`);
      }

      const firstUrl = body
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => /^https?:\/\//i.test(l));

      return firstUrl ? { url: firstUrl } : null;
    } catch (err) {
      lastError = err;
      const isRetryable = BLOCK_RETRY_REGEX.test(err?.message || "");

      if (isRetryable && attempt < 2) {
        const wait = RETRY_DELAYS_MS[attempt];
        console.warn(
          `[fyp] محاولة ${attempt + 1}/3 فشلت لـ "${query}" (${String(err?.message || "").slice(0, 60)}) — انتظار ${wait / 1000}s`
        );
        await sleep(wait);
        continue;
      }
      throw err;
    }
  }

  throw lastError;
}

/* ---------------- استعلام بصيغ متعددة ---------------- */

async function searchVideo(query) {
  const startTime = Date.now();
  const firstWord = query.trim().split(/\s+/)[0];
  const variations = [...new Set([query, `${query} tiktok`, firstWord])];

  let lastError;
  let lastWasNull = false;

  for (let i = 0; i < variations.length; i++) {
    if (Date.now() - startTime > SEARCH_BUDGET_MS) {
      throw lastError || new Error("search budget exceeded");
    }

    try {
      const result = await fetchWithRetry(variations[i]);
      if (result) return result;
      lastWasNull = true;
    } catch (err) {
      lastError = err;

      if (PURE_BLOCK_REGEX.test(err?.message || "")) {
        throw err;
      }

      console.warn(
        `[fyp] صيغة "${variations[i]}" فشلت: ${String(err?.message || "").slice(0, 80)}`
      );
    }
  }

  if (lastError && !lastWasNull) throw lastError;
  return null;
}

/* ---------------- فيديو عشوائي ---------------- */

async function randomVideo() {
  hydrateRecentlySent();
  const startTime = Date.now();
  const terms = [...RANDOM_TERMS].sort(() => Math.random() - 0.5);

  let last = null;
  let lastError = null;

  for (const term of terms) {
    if (Date.now() - startTime > RANDOM_BUDGET_MS) {
      console.warn("[fyp:random] تجاوز الميزانية الزمنية — التوقف");
      break;
    }

    try {
      const video = await searchVideo(term);
      if (!video) continue;
      last = video;
      if (!hasRecentlySent(`tiktok:${video.url}`)) return video;
    } catch (err) {
      lastError = err;
      console.warn(`[fyp:random] "${term}": ${String(err?.message || "").slice(0, 80)}`);

      if (PURE_BLOCK_REGEX.test(err?.message || "")) {
        throw err;
      }
      continue;
    }
  }

  if (!last && lastError) throw lastError;
  return last;
}

/* ---------------- التنزيل والإرسال ---------------- */

async function downloadAndSend(api, threadID, messageID, url) {
  let filePath;
  try {
    const media = await downloadYYMedia(url, { type: "video" });
    filePath = media.filePath;
    await global.mediaSendFile(api, filePath, threadID, messageID);
    rememberSent(`tiktok:${url}`);
  } finally {
    if (filePath) await fs.remove(filePath).catch(() => {});
  }
}

/* ---------------- الأمر ---------------- */

export default {
  config: {
    name: "fyp",
    aliases: ["تيك_توك"],
    version: "7.2.0",
    role: 0,
    countDown: 5,
    category: "وسائط وتحميل",
    description: "بحث فيديوهات TikTok عبر tS وتنزيلها عبر yy.",
    usage: [
      "{pn}fyp <كلمة بحث أو رابط> — تحميل أول نتيجة",
      "{pn}fyp fyp — فيديو عشوائي",
    ],
  },

  onStart: async ({ api, message, args, event }) => {
    const { threadID, messageID } = event;

    // عرض المساعدة عند غياب الوسائط — ليس حالة فشل
    if (!args[0]) return message.reply(HELP);

    const raw = args.join(" ").trim();
    const isUrl = /^https?:\/\//i.test(raw);

    try {
      if (!isUrl) getTiktokApiUrl();

      let videoUrl = raw;

      if (!isUrl) {
        const video =
          raw.toLowerCase() === "fyp"
            ? await randomVideo()
            : await searchVideo(raw);

        if (!video) {
          console.warn(
            `[fyp] لا نتائج بحث | thread=${threadID} sender=${event.senderID} query="${raw}"`
          );
          return; // صامت
        }
        videoUrl = video.url;
      }

      await downloadAndSend(api, threadID, messageID, videoUrl);
    } catch (error) {
      // كل الفشل يُسجَّل في سجل Render فقط — لا رسالة للمستخدم
      console.error(
        `[fyp] فشل | thread=${threadID} sender=${event.senderID} query="${raw}" | ${error?.message || error}`
      );
    }
  },
};