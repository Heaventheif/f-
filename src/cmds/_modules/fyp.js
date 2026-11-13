"use strict";
import { redact, redactText } from "../../fca/runtimeEnv.js";
import { fetchJson } from "../../net/safeFetch.js";
import { AppError, userMessage } from "../../infra/errors.js";
import { withTempDir } from "../../io/tmp.js";
import { downloadYYMedia } from "../../utils/yyApi.js";
import { downloadToTemp } from "../../utils/mediaStream.js";
import { reply } from "../../media/common.js";
import { hydrateRecentlySent, hasRecentlySent, rememberSent } from "../../utils/recentlySent.js";
const HELP =
  "📺 تيك توك\n\nfyp <كلمة بحث أو رابط>   — تحميل أول نتيجة\nfyp fyp                  — فيديو عشوائي (FYP)\n\n(أو تيك_توك بدل fyp)";
const RANDOM_TERMS = [
  "fyp",
  "viral",
  "trending",
  "funny",
  "foryou",
  "comedy",
  "dance",
  "food",
  "nature",
  "music",
  "animals",
  "sports",
  "cars",
  "travel",
  "art",
  "diy",
  "gaming",
  "science",
  "history",
  "fashion",
];
export const TIKTOK_HOSTS = ["tiktok.com", "tiktokv.com", "tiktokcdn.com", "tiktokcdn-us.com", "muscdn.com"];
const DIRECT_HOSTS = ["tikwm.com", ...TIKTOK_HOSTS];
const JOB_BUDGET_MS = 120e3;
export function isTiktokUrl(value) {
  try {
    const u = new URL(String(value));
    const h = u.hostname.toLowerCase();
    return /^https?:$/.test(u.protocol) && TIKTOK_HOSTS.some((d) => h === d || h.endsWith("." + d));
  } catch { return false; }
}
// Unbiased in-place Fisher-Yates on a copy.
export function shuffle(items, rnd = Math.random) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const FETCH_TIMEOUT_MS = 15e3;
const DOWNLOAD_TIMEOUT_MS = 6e4;
const SEARCH_BUDGET_MS = 25e3;
const RANDOM_BUDGET_MS = 45e3;
const RESULTS_PER_REQUEST = 20;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms) =>
  new Promise((r) => setTimeout(r, Math.max(0, ms + (Math.random() * 800 - 400))));
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
async function searchViaTikwm(query) {
  const url = new URL("https://www.tikwm.com/api/feed/search");
  url.searchParams.set("keywords", query);
  url.searchParams.set("count", String(RESULTS_PER_REQUEST));
  url.searchParams.set("cursor", "0");
  url.searchParams.set("HD", "1");
  const data = await fetchJson(url.href, {
    timeoutMs: FETCH_TIMEOUT_MS, allowHosts: ["tikwm.com"],
    headers: { "User-Agent": BROWSER_UA, Referer: "https://www.tikwm.com/" },
  }).catch((e) => { throw new Error(`tikwm ${e?.code || ""} ${e?.message || ""}`.trim()); });
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
      console.warn(`[fyp:tikwm] "${q}": ${redactText(err?.message).slice(0, 100)}`);
    }
  }
  if (allCandidates.length === 0) {
    if (lastError) throw lastError;
    return null;
  }
  return pickUnseen(allCandidates);
}
async function randomVideo() {
  hydrateRecentlySent();
  const startTime = Date.now();
  const terms = shuffle(RANDOM_TERMS);
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
      console.warn(`[fyp:random] "${term}": ${redactText(err?.message).slice(0, 100)}`);
    }
  }
  if (lastError) throw lastError;
  return null;
}
async function downloadAndSend(api, threadID, messageID, video) {
  await withTempDir(async (dir) => {
    let filePath;
    if (video._direct) {
      try {
        filePath = (await downloadToTemp(video.url, "mp4", { dir, allowHosts: DIRECT_HOSTS, maxBytes: 100 * 1024 * 1024 })).tmpPath;
      } catch (err) {
        console.warn(`[fyp] direct failed: ${redactText(err?.message).slice(0, 100)} — fallback to yy`);
      }
    }
    if (!filePath) filePath = (await downloadYYMedia(video.url, { type: "video", dir, maxBytes: 100 * 1024 * 1024 })).filePath;
    await global.mediaSendFile(api, filePath, threadID, messageID);
  }, "fyp");
  rememberSent(`tiktok:${video.tiktokUrl || video.url}`);
}
const withDeadline = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new AppError("timeout", "fyp_budget")), ms).unref?.())]);
export default {
  config: {
    name: "fyp",
    aliases: ["تيك_توك"],
    version: "9.0.0",
    role: 0,
    countDown: 5,
    category: "وسائط وتحميل",
    description: "بحث فيديوهات TikTok عبر tikwm وتنزيلها، بدون تكرار.",
    usage: ["{pn}fyp <كلمة بحث أو رابط> — تحميل أول نتيجة", "{pn}fyp fyp — فيديو عشوائي"],
  },
  onStart: async ({ api, message, args, event }) => {
    const { threadID, messageID } = event;
    if (!args[0]) return message.reply(HELP);
    const raw = args.join(" ").trim().slice(0, 200);
    const isUrl = /^https?:\/\//i.test(raw);
    if (isUrl && !isTiktokUrl(raw)) return reply(api, threadID, "🔒 هذا الرابط غير مدعوم (روابط تيك توك فقط).", messageID);
    try {
      await withDeadline((async () => {
        let video;
        if (isUrl) video = { url: raw, tiktokUrl: raw, _direct: false };
        else {
          video = raw.toLowerCase() === "fyp" ? await randomVideo() : await searchVideo(raw);
          if (!video) {
            console.warn(`[fyp] لا نتائج جديدة | ${JSON.stringify(redact({ threadID, senderID: event.senderID }))}`);
            return reply(api, threadID, "لم أجد فيديوهات جديدة الآن، جرّب كلمة أخرى.", messageID);
          }
        }
        await downloadAndSend(api, threadID, messageID, video);
      })(), JOB_BUDGET_MS);
    } catch (error) {
      console.error(`[fyp] فشل | ${JSON.stringify(redact({ threadID, senderID: event.senderID }))} | ${redactText(error?.message || error)}`);
      await reply(api, threadID, `❌ ${userMessage(error)}`, messageID);
    }
  },
};
