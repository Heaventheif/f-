import fs from "../utils/fsCompat.js";
import path from "node:path";
import { redactText } from "../fca/runtimeEnv.js";
import { downloadYYMedia } from "../utils/yyApi.js";
import { directSend, directSendParts } from "../utils/send.js";
import { splitFile, NEEDS_SPLIT } from "../utils/mediaSplitter.js";
import { assertSafeUrl } from "../utils/ssrfGuard.js";
import { withTempDir } from "../io/tmp.js";
import { LRU } from "../infra/lru.js";
import { Semaphore, RateLimiter } from "../infra/limiter.js";
import { AppError, userMessage } from "../infra/errors.js";
import { sendStatus, reply, unsendQuiet } from "../media/common.js";

const URL_RE = /https?:\/\/[^\s"'<>]+/i;
const API_LABEL = "yy API";
const TRAILING_PUNCT = /[.,;:!?)\]}>'"،؛؟]+$/;
const DEDUPE_TTL_MS = 5 * 60_000;
const THREAD_COOLDOWN_MS = 8_000;

const seen = new LRU({ maxEntries: 1000, maxBytes: 4 * 1024 * 1024, ttlMs: DEDUPE_TTL_MS });
const slots = new Semaphore(2);
const threadLimiter = new RateLimiter({ max: 1, windowMs: THREAD_COOLDOWN_MS });

export function extractUrl(text) {
  const raw = String(text || "").match(URL_RE)?.[0];
  return raw ? raw.replace(TRAILING_PUNCT, "") || null : null;
}
const AUTO_DL_HOSTS = [
  "tiktok.com", "instagram.com", "youtube.com", "youtu.be", "facebook.com", "fb.watch",
  "soundcloud.com", "pinterest.com", "pin.it",
];
export function isAllowedAutoHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return AUTO_DL_HOSTS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}
// Auto-detect uses only the message itself (a quoted/replied message must not trigger a download).
export function extractUrlFromEvent(event, { allowReply = false } = {}) {
  return extractUrl(event?.body) || (allowReply ? extractUrl(event?.messageReply?.body) : null);
}
export function parseDownloadType(args = []) {
  const normalized = args.map((value) => String(value).toLowerCase());
  return normalized.includes("audio") || normalized.includes("mp3") ? "audio" : "video";
}
export const dedupeKey = (threadID, url) => `${threadID}|${String(url).replace(/#.*$/, "")}`;
// true on first sight within the TTL, false on a duplicate (and records it).
export function firstSeen(threadID, url) {
  const key = dedupeKey(threadID, url);
  if (seen.get(key)) return false;
  seen.set(key, 1);
  return true;
}

async function sendLocalFile(api, threadID, dir, filePath, title, replyToID) {
  const { size } = await fs.stat(filePath);
  if (NEEDS_SPLIT(size)) {
    const parts = await splitFile(filePath, path.extname(filePath).slice(1) || "mp4", { dir });
    const streams = parts.map((part) => ({ stream: fs.createReadStream(part), reopen: () => fs.createReadStream(part) }));
    return (await directSendParts(api, threadID, title, streams, replyToID)).sent > 0;
  }
  return directSend(api, threadID, { attachment: fs.createReadStream(filePath) }, replyToID);
}

// Returns { ok } or { ok:false, error }. The temp dir is removed in exactly one place (withTempDir).
async function downloadAndSend(api, event, url, type = "video") {
  const { threadID, messageID } = event;
  try {
    const ok = await slots.run(() =>
      withTempDir(async (dir) => {
        const media = await downloadYYMedia(url, { type, dir });
        console.log(`[AUTODL] provider=${API_LABEL} type=${type} url=${redactText(url)}`);
        return sendLocalFile(api, threadID, dir, media.filePath, media.title || "وسائط", messageID);
      }, "autodl"),
    );
    return ok ? { ok: true } : { ok: false, error: new AppError("upstream", "send_failed") };
  } catch (error) {
    console.error(`[AUTODL:${API_LABEL}]`, error?.code || "", redactText(error?.message || error));
    return { ok: false, error };
  }
}

export default {
  config: {
    name: "autodl",
    aliases: ["dl", "تحميل"],
    version: "3.0.0",
    role: 0,
    countDown: 6,
    category: "وسائط وتحميل",
    description: "تحميل الفيديو أو الصوت من رابط واحد عبر API مشروع yy.",
    usage: [
      "{pn}autodl <رابط> — تحميل فيديو عبر API مشروع yy",
      "{pn}autodl audio <رابط> — تحميل صوت عبر API مشروع yy",
      "أرسل الرابط مباشرة بدون أمر — اكتشاف وتحميل تلقائي",
    ],
    hidden: true,
  },
  onChat: async ({ api, event }) => {
    const url = extractUrlFromEvent(event);
    if (!url || !isAllowedAutoHost(url)) return;
    if (!firstSeen(event.threadID, url)) return;
    if (!threadLimiter.allow(String(event.threadID)).ok) return;
    const result = await downloadAndSend(api, event, url, "video");
    if (!result.ok) {
      seen.delete(dedupeKey(event.threadID, url)); // allow a retry after a failure
      await reply(api, event.threadID, `❌ ${userMessage(result.error)}`, event.messageID);
    }
  },
  onStart: async ({ api, event, args, message }) => {
    const values = [...args];
    const type = parseDownloadType(values);
    const url =
      extractUrl(values.find((v) => /^https?:\/\//i.test(String(v)))) ||
      extractUrlFromEvent({ body: values.join(" "), messageReply: event.messageReply }, { allowReply: true });
    if (!url) return message.reply("📥 الاستخدام: autodl <رابط>\nوللصوت: autodl audio <رابط>");
    try {
      await assertSafeUrl(url);
    } catch {
      return message.reply(`❌ ${userMessage(new AppError("blocked_url"))}`);
    }
    const status = await sendStatus(api, event.threadID, `⏳ جاري التحميل عبر ${API_LABEL}...`, event.messageID);
    const result = await downloadAndSend(api, event, url, type);
    await unsendQuiet(api, status?.messageID);
    if (!result.ok) await message.reply(`❌ تعذّر التحميل: ${userMessage(result.error)}`);
  },
};
