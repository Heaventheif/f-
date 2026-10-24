import http from "../../utils/fetchHttp.js";
import fs from "fs";
import { splitFile, cleanupParts, NEEDS_SPLIT } from "../../utils/mediaSplitter.js";
import { downloadToTemp } from "../../utils/mediaStream.js";
import { buildYozoraDownloadUrl, getYozoraEntries, getYozoraInfo } from "../../utils/yozora.js";
import { downloadYYMedia } from "../../utils/yyApi.js";
const TUMBLR_API_KEY = process.env.TUMBLR_API_KEY || "";
const TIKTOK_INFO_TIMEOUT_MS = 15_000;
const TIKTOK_PROFILE_CACHE_TTL_MS = 30 * 60 * 1000;
const TIKTOK_PROFILE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
// Defaults span meme and animal accounts; add public edit/music handles via TIKTOK_RANDOM_USERS.
const DEFAULT_TIKTOK_USERS = ["meme", "corgibobaa"];
const TIKTOK_USERS = parseTikTokUsers(process.env.TIKTOK_RANDOM_USERS);
const _RECENTLY_SENT_KEY = "random_recentlySent";
const _recentlySent = new Set();
const _RECENT_LIMIT = 200;
let _hydrated = false;
const _tiktokProfileCache = new Map();
const _tiktokProfileCooldown = new Map();
function hydrateRecentlySent() {
  if (_hydrated) return;
  _hydrated = true;
  const saved = global.globalData?.get?.(_RECENTLY_SENT_KEY);
  if (Array.isArray(saved)) for (const key of saved) _recentlySent.add(key);
}
function rememberSent(key) {
  if (!key) return;
  _recentlySent.add(key);
  if (_recentlySent.size > _RECENT_LIMIT) {
    _recentlySent.delete(_recentlySent.values().next().value);
  }
  global.globalData?.set?.(_RECENTLY_SENT_KEY, [..._recentlySent]);
}
export function parseTikTokUsers(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return [...DEFAULT_TIKTOK_USERS];
  const users = [...new Set(raw.split(",")
    .map(user => user.trim().replace(/^@/, ""))
    .filter(user => /^[\w.-]{2,32}$/.test(user)))];
  return users.length ? users : [...DEFAULT_TIKTOK_USERS];
}

export function isTikTokVideoUrl(value) {
  try {
    const url = new URL(value);
    return /(^|\.)tiktok\.com$/i.test(url.hostname) && /\/video\/\d+/.test(url.pathname);
  } catch (_) {
    return false;
  }
}

export function chooseRandomUnseen(items, keyOf, seen = new Set()) {
  const valid = (Array.isArray(items) ? items : [])
    .filter(item => item && String(keyOf(item) || "").trim());
  if (!valid.length) return null;
  const fresh = valid.filter(item => !seen.has(String(keyOf(item))));
  const pool = fresh.length ? fresh : valid;
  return pool[Math.floor(Math.random() * pool.length)];
}

function shuffled(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [result[index], result[swap]] = [result[swap], result[index]];
  }
  return result;
}

const VIDEO_BLOGS = [
  "videohall", "gifak-net", "sizvideos", "pleatedjeans",
  "tastefullyoffensive", "humortrain", "best-of-tumblr-daily",
  "videogifs", "funnyordie", "motionaddicts",
  "catasters", "kittens", "there-is-always-hope",
  "awesome-picz", "thefrogman",
];

async function getTikTokVideos(username) {
  const cached = _tiktokProfileCache.get(username);
  if (cached && Date.now() - cached.fetchedAt < TIKTOK_PROFILE_CACHE_TTL_MS) {
    return cached.videos;
  }
  const retryAfter = _tiktokProfileCooldown.get(username) || 0;
  if (retryAfter > Date.now()) {
    if (cached?.videos.length) return cached.videos;
    throw new Error("مصدر TikTok في مهلة تهدئة مؤقتة");
  }
  try {
    const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
    const info = await getYozoraInfo(profileUrl, undefined, TIKTOK_INFO_TIMEOUT_MS);
    const videos = [...new Map(
      getYozoraEntries(info, 60)
        .filter(entry => isTikTokVideoUrl(entry.url))
        .map(entry => [entry.url, { id: entry.id, url: entry.url }]),
    ).values()];
    if (!videos.length) throw new Error("لم تُعثر على فيديوهات عامة في الحساب");
    _tiktokProfileCache.set(username, { fetchedAt: Date.now(), videos });
    _tiktokProfileCooldown.delete(username);
    return videos;
  } catch (error) {
    _tiktokProfileCooldown.set(username, Date.now() + TIKTOK_PROFILE_FAILURE_COOLDOWN_MS);
    if (cached?.videos.length) return cached.videos;
    throw error;
  }
}

async function tryTikTok() {
  let repeatPool = [];
  const usernames = shuffled(TIKTOK_USERS).slice(0, 3);
  const attempts = usernames.map(async username => {
    try {
      const videos = await getTikTokVideos(username);
      const fresh = videos.filter(video => !_recentlySent.has(`tiktok:${video.url}`));
      if (fresh.length) {
        const selected = chooseRandomUnseen(fresh, video => video.url, new Set());
        return {
          source: "tiktok",
          sourceUrl: selected.url,
          videoUrl: buildYozoraDownloadUrl(selected.url),
          sentKey: `tiktok:${selected.url}`,
        };
      }
      repeatPool.push(...videos);
    } catch (error) {
      console.warn(`[RANDOM] TikTok @${username} unavailable: ${error.message}`);
    }
    return null;
  });
  const picked = await Promise.any(attempts.map(attempt => attempt.then(result => {
    if (result) return result;
    throw new Error("لا توجد فيديوهات جديدة");
  }))).catch(() => null);
  if (picked) return picked;
  if (!repeatPool.length) return null;
  const selected = chooseRandomUnseen(repeatPool, video => video.url, new Set());
  return {
    source: "tiktok",
    sourceUrl: selected.url,
    videoUrl: buildYozoraDownloadUrl(selected.url),
    sentKey: `tiktok:${selected.url}`,
  };
}

async function tryTumblr() {
  if (!TUMBLR_API_KEY) return null;
  for (const blog of shuffled(VIDEO_BLOGS)) {
    try {
      const countResp = await http.get(
        `https://api.tumblr.com/v2/blog/${blog}/posts/video`,
        { params: { api_key: TUMBLR_API_KEY, limit: 1 }, timeout: 8000 }
      );
      const totalPosts = countResp.data?.response?.total_posts || 20;
      const maxOffset  = Math.max(0, totalPosts - 20);
      const offset     = Math.floor(Math.random() * (maxOffset + 1));
      const response = await http.get(
        `https://api.tumblr.com/v2/blog/${blog}/posts/video`,
        { params: { api_key: TUMBLR_API_KEY, limit: 20, offset }, timeout: 8000 }
      );
      const posts = response.data?.response?.posts || [];
      if (!posts.length) continue;
      const post = chooseRandomUnseen(posts, item => item.post_url || item.id_string || item.video_url, _recentlySent);
      if (!post) continue;
      const url = post.video_url
        || post.player?.find(p => p.width >= 400)?.embed_code
        || post.player?.[0]?.embed_code;
      if (!url || !url.startsWith("http")) continue;
      return {
        source: "tumblr",
        videoUrl: url,
        sentKey: post.post_url || post.id_string || post.video_url || "",
      };
    } catch (_) { continue; }
  }
  return null;
}

async function pickRandomVideo() {
  for (const provider of shuffled([tryTikTok, tryTumblr])) {
    const picked = await provider();
    if (picked) return picked;
  }
  return null;
}

export default {
  config: {
    name: "random",
    aliases: ["فيديو"],
    version: "1.6.0",
    countDown: 15,
    role: 0,
    category: "وسائط وتحميل",
    description: "فيديو عشوائي من Tumblr أو TikTok",
    usage: ["{pn}فيديو — فيديو عشوائي من Tumblr أو TikTok"],
  },
  onStart: async function ({ api, event }) {
    const { threadID, messageID } = event;
    hydrateRecentlySent();
    let tmpFile = null;
    let partPaths = [];
    try {
      const picked = await pickRandomVideo();
      if (!picked) {
        return global.safeSend(api, "لم أجد فيديو الآن. حاول مرة أخرى لاحقاً.", threadID, null, messageID);
      }
      const { videoUrl, sourceUrl, source: mediaSource, sentKey } = picked;
      let size;
      if (mediaSource === "tiktok") {
        try {
          const media = await downloadYYMedia(sourceUrl || videoUrl, { type: "video" });
          tmpFile = media.filePath;
          size = media.bytes;
        } catch (yyError) {
          console.warn(`[RANDOM] yy failed, using direct TikTok stream fallback: ${yyError.message}`);
          const downloaded = await downloadToTemp(videoUrl, "mp4");
          tmpFile = downloaded.tmpPath;
          size = downloaded.size;
        }
      } else {
        // Tumblr is not in yy's supported source list; keep its direct media URL path.
        const downloaded = await downloadToTemp(videoUrl, "mp4");
        tmpFile = downloaded.tmpPath;
        size = downloaded.size;
      }
      if (size < 10240) return global.safeSend(api, "الفيديو فارغ.", threadID, null, messageID);
      const files = NEEDS_SPLIT(size)
        ? (partPaths = await splitFile(tmpFile, "mp4"))
        : [tmpFile];
      for (const file of files) {
        await new Promise((resolve, reject) =>
          global.safeSend(api,
            { attachment: fs.createReadStream(file) },
            threadID, (err) => err ? reject(err) : resolve(), messageID
          )
        );
      }
      rememberSent(sentKey);
    } catch (error) {
      let errMsg = "فشل جلب الفيديو. ";
      if (error.response?.status === 401) errMsg += "رفض المصدر الطلب.";
      else if (error.response?.status === 429) errMsg += "تجاوز المصدر حد الطلبات.";
      else if (error.code === "ECONNABORTED") errMsg += "انتهت مهلة الانتظار.";
      else errMsg += error.message?.substring(0, 150) || "خطأ غير معروف.";
      global.safeSend(api, errMsg, threadID, null, messageID);
    } finally {
      try { if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) {}
      if (partPaths.length) await cleanupParts(partPaths);
    }
  }
};
