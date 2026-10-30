"use strict";

import fs from "../../utils/fsCompat.js";
import { Readable } from "node:stream";
import { downloadYYMedia } from "../../utils/yyApi.js";
import { streamToTempFile } from "../../utils/mediaFile.js";
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
  "animals", "sports", "cars", "travel", "art",
  "diy", "gaming", "science", "history", "fashion",
];

const FETCH_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const SEARCH_BUDGET_MS = 25_000;
const RANDOM_BUDGET_MS = 45_000;
const RESULTS_PER_REQUEST = 20;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sleep = (ms) =>
  new Promise((r) => setTimeout(r, Math.max(0, ms + (Math.random() * 800 - 400))));

/* ---------------- اختيار غير المرسل ---------------- */

function pickUnseen(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const seenKeys = new Set();
  const unique = [];
  for (const c of candidates) {
    if (!c || !c.url) continue;
    const key = c.tiktokUrl || c.url;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    unique.push(c);
  }

  const unseen = unique.filter((c) => {
    const key = `tiktok:${c.tiktokUrl || c.url}`;
    return !hasRecentlySent(key);
  });

  if (unseen.length === 0) return null;
  return unseen[Math.floor(Math.random() * unseen.length)];
}

/* ---------------- tikwm (المزوّد الوحيد) ---------------- */

async function searchViaTikwm(query) {
  const url = new URL("https://www.tikwm.com/api/feed/search");
  url.searchParams.set("keywords", query);
  url.searchParams.set("count", String(RESULTS_PER_REQUEST));
  url.searchParams.set("cursor", "0");
  url.searchParams.set("HD", "1");

  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://www.tikwm.com/",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`tikwm HTTP ${res.status}`);

  const data = await res.json().catch(() => null);
  if (!data || data.code !== 0) {
    throw new Error(`tikwm: ${data?.msg || "bad response"}`);
  }

  const videos = data.data?.videos;
  if (!Array.isArray(videos) || videos.length === 0) {
    throw new Error("tikwm: no results");
  }

  const results = [];
  for (const v of videos) {
    if (!v) continue;
    const playUrl = v.hdplay || v.play || v.wmplay;
    if (!playUrl) continue;

    const tiktokUrl =
      v.share_url ||
      v.url ||
      (v.author?.unique_id && v.id
        ? `https://www.tiktok.com/@${v.author.unique_id}/video/${v.id}`
        : playUrl);

    results.push({ url: playUrl, tiktokUrl, _direct: true });
  }

  if (results.length === 0) throw new Error("tikwm: no playable videos");
  return results;
}

async function searchViaTikwmWithRetry(query) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await searchViaTikwm(query);
    } catch (err) {
      lastError = err;
      if (attempt < 1) await sleep(1500);
    }
  }
  throw lastError;
}

/* ---------------- البحث الموحّد ---------------- */

async function searchVideo(query) {
  const startTime = Date.now();
  const firstWord = query.trim().split(/\s+/)[0];
  const variations = [...new Set([query, `${query} tiktok`, firstWord])];

  const allCandidates = [];
  let lastError = null;

  for (const q of variations) {
    if (Date.now() - startTime > SEARCH_BUDGET_MS) {
      console.warn(`[fyp] تجاوز ميزانية البحث لـ "${query}"`);
      break;
    }

    try {
      const results = await searchViaTikwmWithRetry(q);
      allCandidates.push(...results);
    } catch (err) {
      lastError = err;
      console.warn(`[fyp:tikwm] "${q}": ${String(err?.message || "").slice(0, 100)}`);
    }
  }

  if (allCandidates.length === 0) {
    if (lastError) throw lastError;
    return null;
  }

  return pickUnseen(allCandidates);
}

/* ---------------- فيديو عشوائي ---------------- */

async function randomVideo() {
  hydrateRecentlySent();
  const startTime = Date.now();
  const terms = [...RANDOM_TERMS].sort(() => Math.random() - 0.5);

  let lastError = null;

  for (const term of terms) {
    if (Date.now() - startTime > RANDOM_BUDGET_MS) {
      console.warn("[fyp:random] تجاوز الميزانية — التوقف");
      break;
    }

    try {
      const video = await searchVideo(term);
      if (video) return video;
    } catch (err) {
      lastError = err;
      console.warn(`[fyp:random] "${term}": ${String(err?.message || "").slice(0, 100)}`);
    }
  }

  if (lastError) throw lastError;
  return null;
}

/* ---------------- تنزيل مباشر لروابط tikwm ---------------- */

async function downloadDirect(playUrl) {
  const res = await fetch(playUrl, {
    headers: {
      "User-Agent": BROWSER_UA,
      "Referer": "https://www.tikwm.com/",
      "Accept": "video/mp4,video/*,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (!res.ok) throw new Error(`direct HTTP ${res.status}`);
  if (!res.body) throw new Error("direct: empty body");

  return streamToTempFile(
    Readable.fromWeb(res.body, { highWaterMark: 1024 * 1024 }),
    {
      prefix: "fyp_direct",
      ext: "mp4",
      totalBytes: Number(res.headers.get("content-length")) || null,
    }
  );
}

/* ---------------- التنزيل والإرسال ---------------- */

async function downloadAndSend(api, threadID, messageID, video) {
  let filePath;
  try {
    let media;

    if (video._direct) {
      // روابط tikwm (CDN مباشر) — جرّب التنزيل المباشر أولًا
      try {
        media = await downloadDirect(video.url);
      } catch (err) {
        console.warn(`[fyp] direct failed: ${String(err?.message || "").slice(0, 100)} — fallback to yy`);
        media = await downloadYYMedia(video.url, { type: "video" });
      }
    } else {
      // رابط المستخدم (صفحة tiktok) — مرّره عبر yy
      media = await downloadYYMedia(video.url, { type: "video" });
    }

    filePath = media.filePath;
    await global.mediaSendFile(api, filePath, threadID, messageID);
    rememberSent(`tiktok:${video.tiktokUrl || video.url}`);
  } finally {
    if (filePath) await fs.remove(filePath).catch(() => {});
  }
}

/* ---------------- الأمر ---------------- */

export default {
  config: {
    name: "fyp",
    aliases: ["تيك_توك"],
    version: "9.0.0",
    role: 0,
    countDown: 5,
    category: "وسائط وتحميل",
    description: "بحث فيديوهات TikTok عبر tikwm وتنزيلها، بدون تكرار.",
    usage: [
      "{pn}fyp <كلمة بحث أو رابط> — تحميل أول نتيجة",
      "{pn}fyp fyp — فيديو عشوائي",
    ],
  },

  onStart: async ({ api, message, args, event }) => {
    const { threadID, messageID } = event;

    // طلب مساعدة صريح — الحالة الوحيدة المسموح فيها برد غير الفيديو
    if (!args[0]) return message.reply(HELP);

    const raw = args.join(" ").trim();
    const isUrl = /^https?:\/\//i.test(raw);

    try {
      let video = null;

      if (isUrl) {
        // رابط مباشر — نمرره عبر yy لأننا لا نضمن أنه CDN مباشر
        video = { url: raw, tiktokUrl: raw, _direct: false };
      } else {
        video =
          raw.toLowerCase() === "fyp"
            ? await randomVideo()
            : await searchVideo(raw);

        if (!video) {
          // كل النتائج مرسلة سابقًا — صمت تام، سجل فقط
          console.warn(
            `[fyp] لا نتائج جديدة | thread=${threadID} sender=${event.senderID} query="${raw}"`
          );
          return;
        }
      }

      await downloadAndSend(api, threadID, messageID, video);
    } catch (error) {
      // أي فشل (شبكة، تنزيل، إرسال) — سجل فقط، لا رسالة للمستخدم
      console.error(
        `[fyp] فشل | thread=${threadID} sender=${event.senderID} query="${raw}" | ${error?.message || error}`
      );
    }
  },
};