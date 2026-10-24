"use strict";
import fs from "fs-extra";
import { getTiktokApiUrl, downloadYYMedia } from "../../utils/yyApi.js";

const HELP =
  "📺 تيك توك\n\n" +
  "fyp <كلمة بحث أو رابط>   — تحميل أول نتيجة\n" +
  "fyp fyp                  — فيديو عشوائي (FYP)\n\n" +
  "(أو تيك_توك بدل fyp)";

const RANDOM_TERMS = ["fyp", "viral", "trending", "funny", "foryou"];

async function searchVideo(query) {
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
    signal: AbortSignal.timeout(75_000),
  });
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    let errorMessage = body.slice(0, 300);
    try { errorMessage = JSON.parse(body)?.error || errorMessage; } catch {}
    throw new Error(errorMessage || `TikTok Search API: HTTP ${response.status}`);
  }
  // tS's `format=urls` returns one URL per line. limit=1 ensures we only fetch
  // and pass the first result to the downloader, never the full JSON result object.
  const firstUrl = body.split(/\r?\n/).map(line => line.trim()).find(line => /^https?:\/\//i.test(line));
  return firstUrl ? { url: firstUrl } : null;
}

async function randomVideo() {
  const term = RANDOM_TERMS[Math.floor(Math.random() * RANDOM_TERMS.length)];
  return searchVideo(term);
}

async function downloadAndSend(api, threadID, messageID, url) {
  let filePath;
  try {
    const media = await downloadYYMedia(url, { type: "video" });
    filePath = media.filePath;
    await global.mediaSendFile(api, filePath, threadID, messageID);
    return true;
  } finally {
    if (filePath) await fs.remove(filePath).catch(() => {});
  }
}

function userError(error) {
  const detail = String(error?.message || "").slice(0, 350);
  return `❌ تعذّر تحميل الفيديو: ${detail || "خطأ غير معروف"}`;
}

export default {
  config: {
    name: "fyp",
    aliases: ["تيك_توك"],
    version: "7.0.0",
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
    if (!args[0]) return message.reply(HELP);

    const raw = args.join(" ").trim();
    const isUrl = /^https?:\/\//i.test(raw);
    try {
      // التحقق من خدمة البحث قبل طلب النتائج؛ التنزيل يمر عبر yy.
      if (!isUrl) getTiktokApiUrl();

      let videoUrl = raw;
      if (!isUrl) {
        const video = raw.toLowerCase() === "fyp"
          ? await randomVideo()
          : await searchVideo(raw);
        if (!video) return message.reply("❌ لا توجد نتائج بحث.");
        videoUrl = video.url;
      }

      const ok = await downloadAndSend(api, threadID, messageID, videoUrl);
      if (!ok) await message.reply("❌ تعذّر إرسال الفيديو.");
    } catch (error) {
      console.error("❌ [fyp]", error?.message || error);
      await message.reply(userError(error));
    }
  },
};
