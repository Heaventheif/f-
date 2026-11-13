"use strict";
import { randomUUID } from "node:crypto";
import { fetchBuffer, fetchText, fetchJson } from "../../net/safeFetch.js";
import { AppError, userMessage } from "../../infra/errors.js";
import { hostBuffer, isSelfHostAvailable, ttlLabel } from "../../utils/tempHost.js";
import { sendStatus, reply, unsendQuiet } from "../../media/common.js";

const MAX_BYTES = 25 * 1024 * 1024;
// Voice attachments only ever come from Facebook's CDN; anything else is refused (SSRF / abuse).
export const VOICE_HOSTS = ["fbcdn.net", "facebook.com", "fbsbx.com"];
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const VOICE_TYPES = new Set(["audio", "voice", "voice_message", "audio_message", "ptt"]);
const AUDIO_URL_RE = /\.(mp3|m4a|ogg|opus|wav|aac|amr|webm)(\?|$)/i;

// Messenger voice notes are usually type "audio" served as .mp4 ("audioclip"); both count.
export function detectVoice(event) {
  const sources = [...(event?.attachments || []), ...(event?.messageReply?.attachments || [])];
  for (const att of sources) {
    if (!att) continue;
    const type = String(att.type || att.attachmentType || "").toLowerCase();
    const url = att.url || att.playableUrl || att.downloadUrl || att.audioUrl || att.uri || att.src || att.href;
    if (!url) continue;
    const mp4Audio = /\.mp4(\?|$)/i.test(url) && (VOICE_TYPES.has(type) || /audioclip|audio_clip|voice/i.test(url));
    if (VOICE_TYPES.has(type) || AUDIO_URL_RE.test(url) || mp4Audio) {
      return { url, filename: att.filename || att.name || "", contentType: att.contentType || att.mimeType || "" };
    }
  }
  return null;
}

const FORMATS = [
  [/mpeg|mp3/, "mp3", "audio/mpeg"], [/mp4|m4a|aac/, "m4a", "audio/mp4"], [/ogg/, "ogg", "audio/ogg"],
  [/opus/, "opus", "audio/opus"], [/wav/, "wav", "audio/wav"], [/webm/, "webm", "audio/webm"], [/amr/, "amr", "audio/amr"],
];
export function resolveFormat(voice) {
  const probes = [
    String(voice.contentType || "").toLowerCase(),
    String(voice.filename || "").toLowerCase().split(".").pop(),
    String(voice.url || "").toLowerCase().split("?")[0].split(".").pop(),
  ];
  for (const p of probes) {
    if (!p) continue;
    for (const [re, ext, mime] of FORMATS) if (re.test(p)) return { ext, mime };
  }
  return { ext: "m4a", mime: "audio/mp4" };
}

async function downloadVoice(url) {
  const buffer = await fetchBuffer(url, {
    allowHosts: VOICE_HOSTS, maxBytes: MAX_BYTES, timeoutMs: 120_000,
    headers: { "User-Agent": BROWSER_UA, Referer: "https://www.facebook.com/", Accept: "audio/*,video/*,*/*;q=0.8" },
  });
  if (!buffer.length) throw new AppError("upstream", "الملف الصوتي فارغ (0 بايت).");
  return buffer;
}

const form = (fields, buffer, filename, contentType, fileField = "file") => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  f.append(fileField, new Blob([buffer], { type: contentType }), filename);
  return f;
};
async function uploadCatbox(buffer, filename, contentType) {
  const url = (await fetchText("https://catbox.moe/user/api.php", {
    method: "POST", timeoutMs: 180_000, allowHosts: ["catbox.moe"], headers: { "User-Agent": BROWSER_UA },
    body: form({ reqtype: "fileupload" }, buffer, filename, contentType, "fileToUpload"),
  })).trim();
  if (!/^https:\/\/files\.catbox\.moe\//.test(url)) throw new AppError("upstream", "رد غير صالح من catbox.moe");
  return url;
}
async function upload0x0(buffer, filename, contentType) {
  const url = (await fetchText("https://0x0.st", {
    method: "POST", timeoutMs: 120_000, allowHosts: ["0x0.st"], headers: { "User-Agent": "SunkenBot/6.0 (Messenger voice to link)" },
    body: form({}, buffer, filename, contentType),
  })).trim();
  if (!/^https:\/\/0x0\.st\//.test(url)) throw new AppError("upstream", "رد غير صالح من 0x0.st");
  return url;
}
async function uploadLitterbox(buffer, filename, contentType) {
  const url = (await fetchText("https://litterbox.catbox.moe/resources/internals/api.php", {
    method: "POST", timeoutMs: 180_000, allowHosts: ["catbox.moe"], headers: { "User-Agent": BROWSER_UA },
    body: form({ reqtype: "fileupload", time: "72h" }, buffer, filename, contentType, "fileToUpload"),
  })).trim();
  if (!/^https:\/\/litter\.catbox\.moe\//.test(url)) throw new AppError("upstream", "رد غير صالح من litterbox");
  return url;
}
// tmpfiles returns http://tmpfiles.org/<id>/<name>; the direct link is https://tmpfiles.org/dl/<id>/<name>.
export function tmpfilesDirectUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.hostname !== "tmpfiles.org") return null;
  u.protocol = "https:";
  if (!u.pathname.startsWith("/dl/")) u.pathname = `/dl${u.pathname}`;
  return u.href;
}
async function uploadTmpfiles(buffer, filename, contentType) {
  const data = await fetchJson("https://tmpfiles.org/api/v1/upload", {
    method: "POST", timeoutMs: 120_000, allowHosts: ["tmpfiles.org"], headers: { "User-Agent": BROWSER_UA },
    body: form({}, buffer, filename, contentType),
  });
  const url = tmpfilesDirectUrl(data?.data?.url);
  if (!url) throw new AppError("upstream", "رد غير صالح من tmpfiles.org");
  return url;
}
async function uploadSelfHost(buffer, filename) {
  if (!isSelfHostAvailable()) throw new AppError("upstream", "الاستضافة الذاتية غير مفعّلة (لا يوجد رابط https عام)");
  const { url } = await hostBuffer(buffer, String(filename).split(".").pop());
  return url;
}

// Self-host is the default; third-party hosts only when VL_PUBLIC_HOSTS=1 (the voice note leaves our control).
export function buildProviders(env = process.env) {
  const list = [{ name: "self-host", fn: uploadSelfHost, ttl: ttlLabel() }];
  if (env.VL_PUBLIC_HOSTS === "1") {
    list.push(
      { name: "catbox.moe", fn: uploadCatbox, ttl: "دائم" },
      { name: "0x0.st", fn: upload0x0, ttl: "حتى 365 يوماً" },
      { name: "litterbox", fn: uploadLitterbox, ttl: "72 ساعة" },
      { name: "tmpfiles.org", fn: uploadTmpfiles, ttl: "ساعة واحدة" },
    );
  }
  return list;
}
export async function uploadWithFallback(buffer, filename, contentType, providers = buildProviders()) {
  const errors = [];
  for (const p of providers) {
    try {
      return { url: await p.fn(buffer, filename, contentType), provider: p.name, ttl: p.ttl };
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 120);
      errors.push(`${p.name}: ${msg}`);
      console.warn(`[VL] ${p.name} فشل:`, msg);
    }
  }
  const err = new AppError("upstream", "فشلت جميع خدمات الرفع.");
  err.details = errors;
  throw err;
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default {
  config: {
    name: "vl",
    version: "2.0.0",
    author: "Sunken",
    role: 0,
    countDown: 10,
    category: "وسائط وتحميل",
    description: "رفع رسالة صوتية من مسنجر إلى رابط تحميل مباشر.",
    usage: [
      "{pn}vl + رسالة صوتية — رفع المرفق",
      "رد على رسالة صوتية + {pn}vl — رفع المرفق المردود عليه",
    ],
  },
  onStart: async ({ api, event }) => {
    const { threadID, messageID } = event;
    const voice = detectVoice(event);
    if (!voice) {
      return reply(
        api, threadID,
        "🎙️ رفع رسالة صوتية إلى رابط تحميل\n━━━━━━━━━━━━━━━━\n📌 الطرق:\n  • أرسل/أعد توجيه رسالة صوتية مع الأمر vl\n  • أو رد على رسالة صوتية واكتب vl\n\n🌐 يُرجِع رابط تحميل مباشر",
        messageID,
      );
    }
    const status = await sendStatus(api, threadID, "⏳ جاري تحميل الرسالة الصوتية...", messageID);
    try {
      const buffer = await downloadVoice(voice.url);
      try { if (status?.messageID) await api.editMessage(`⏳ جاري رفع الملف (${formatSize(buffer.length)})...`, status.messageID); } catch {}
      const { ext, mime } = resolveFormat(voice);
      const { url, ttl } = await uploadWithFallback(buffer, `voice_${randomUUID().slice(0, 8)}.${ext}`, mime);
      await unsendQuiet(api, status?.messageID);
      return reply(api, threadID, `${url}\n⏱️ مدة الرابط: ${ttl}`, messageID);
    } catch (error) {
      console.error("[VL]", error?.code || "", String(error?.message || error).slice(0, 200));
      await unsendQuiet(api, status?.messageID);
      const detail = error?.details?.length && process.env.VL_PUBLIC_HOSTS !== "1" ? "\nفعّل الاستضافة الذاتية (PUBLIC_URL بـ https)." : "";
      return reply(api, threadID, `❌ تعذّر رفع الرسالة الصوتية\n${userMessage(error)}${detail}`, messageID);
    }
  },
};
