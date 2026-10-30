"use strict";

import { Buffer } from "node:buffer";
import http from "../../utils/fetchHttp.js";
import { hostBuffer, isSelfHostAvailable, ttlLabel } from "../../utils/tempHost.js";

const MAX_BYTES = 50 * 1024 * 1024;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const VOICE_TYPES = new Set([
  "audio", "voice", "voice_message", "audio_message", "ptt",
]);

/* ---------------- كشف الرسالة الصوتية ---------------- */

function detectVoice(event) {
  const sources = [
    ...(event.attachments || []),
    ...(event.messageReply?.attachments || []),
  ];
  for (const att of sources) {
    if (!att) continue;
    const type = String(att.type || att.attachmentType || "").toLowerCase();
    const url =
      att.url || att.playableUrl || att.downloadUrl || att.audioUrl ||
      att.uri || att.src || att.href;
    if (!url) continue;

    if (VOICE_TYPES.has(type) || /\.(mp3|m4a|ogg|opus|wav|aac|amr|webm)(\?|$)/i.test(url)) {
      return {
        url,
        filename: att.filename || att.name || "",
        contentType: att.contentType || att.mimeType || "",
      };
    }
  }
  return null;
}

/* ---------------- تحديد الصيغة ---------------- */

function resolveFormat(voice) {
  const ct = String(voice.contentType || "").toLowerCase();
  if (ct.includes("mpeg") || ct.includes("mp3"))   return { ext: "mp3",  mime: "audio/mpeg" };
  if (ct.includes("mp4")  || ct.includes("m4a") || ct.includes("aac"))
                                                     return { ext: "m4a",  mime: "audio/mp4" };
  if (ct.includes("ogg"))                            return { ext: "ogg",  mime: "audio/ogg" };
  if (ct.includes("opus"))                           return { ext: "opus", mime: "audio/opus" };
  if (ct.includes("wav"))                            return { ext: "wav",  mime: "audio/wav" };
  if (ct.includes("webm"))                           return { ext: "webm", mime: "audio/webm" };
  if (ct.includes("amr"))                            return { ext: "amr",  mime: "audio/amr" };

  const fn = String(voice.filename || "").toLowerCase();
  if (fn.endsWith(".mp3"))  return { ext: "mp3",  mime: "audio/mpeg" };
  if (fn.endsWith(".m4a") || fn.endsWith(".mp4"))
                            return { ext: "m4a",  mime: "audio/mp4" };
  if (fn.endsWith(".ogg"))  return { ext: "ogg",  mime: "audio/ogg" };
  if (fn.endsWith(".opus")) return { ext: "opus", mime: "audio/opus" };
  if (fn.endsWith(".wav"))  return { ext: "wav",  mime: "audio/wav" };
  if (fn.endsWith(".amr"))  return { ext: "amr",  mime: "audio/amr" };

  const url = String(voice.url || "").toLowerCase();
  if (url.includes(".mp3"))  return { ext: "mp3",  mime: "audio/mpeg" };
  if (url.includes(".m4a") || url.includes(".mp4"))
                             return { ext: "m4a",  mime: "audio/mp4" };
  if (url.includes(".ogg"))  return { ext: "ogg",  mime: "audio/ogg" };
  if (url.includes(".opus")) return { ext: "opus", mime: "audio/opus" };

  return { ext: "m4a", mime: "audio/mp4" };
}

/* ---------------- التحميل من Facebook CDN ---------------- */

async function downloadVoice(url) {
  const res = await http.get(url, {
    responseType: "arraybuffer",
    timeout: 120_000,
    headers: {
      "User-Agent": BROWSER_UA,
      "Referer": "https://www.facebook.com/",
      "Accept": "audio/*,video/*,*/*;q=0.8",
    },
  });
  const buffer = Buffer.from(res.data);
  if (!buffer.length) throw new Error("الملف الصوتي فارغ (0 بايت).");
  if (buffer.length > MAX_BYTES) {
    throw new Error(
      `حجم الملف (${(buffer.length / 1024 / 1024).toFixed(1)}MB) يتجاوز الحد المسموح (50MB).`
    );
  }
  return buffer;
}

/* ---------------- خدمات الرفع (fallback) ---------------- */

async function uploadCatbox(buffer, filename, contentType) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("fileToUpload", new Blob([buffer], { type: contentType }), filename);
  const res = await http.post("https://catbox.moe/user/api.php", form, {
    timeout: 180_000, headers: { "User-Agent": BROWSER_UA },
  });
  const url = String(res.data || "").trim();
  if (!/^https:\/\/files\.catbox\.moe\//.test(url)) throw new Error("رد غير صالح من catbox.moe");
  return url;
}

async function upload0x0(buffer, filename, contentType) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: contentType }), filename);
  const res = await http.post("https://0x0.st", form, {
    timeout: 120_000,
    headers: { "User-Agent": "SunkenBot/5.0 (Messenger voice to link)" },
  });
  const url = String(res.data || "").trim();
  if (!/^https:\/\/0x0\.st\//.test(url)) throw new Error("رد غير صالح من 0x0.st");
  return url;
}

async function uploadLitterbox(buffer, filename, contentType) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("time", "72h");
  form.append("fileToUpload", new Blob([buffer], { type: contentType }), filename);
  const res = await http.post(
    "https://litterbox.catbox.moe/resources/internals/api.php",
    form,
    { timeout: 180_000, headers: { "User-Agent": BROWSER_UA } }
  );
  const url = String(res.data || "").trim();
  if (!/^https:\/\/litter\.catbox\.moe\//.test(url)) throw new Error("رد غير صالح من litterbox");
  return url;
}

async function uploadTmpfiles(buffer, filename, contentType) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: contentType }), filename);
  const res = await http.post("https://tmpfiles.org/api/v1/upload", form, {
    timeout: 120_000, headers: { "User-Agent": BROWSER_UA },
  });
  let url = res.data?.data?.url;
  if (!url || !/^https?:\/\//.test(url)) throw new Error("رد غير صالح من tmpfiles.org");
  url = url.replace("tmpfiles.org/", "tmpfiles.org/dl/");
  return url;
}

async function uploadFileIO(buffer, filename, contentType) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: contentType }), filename);
  const res = await http.post("https://file.io/?expires=1w", form, {
    timeout: 120_000, headers: { "User-Agent": BROWSER_UA },
  });
  const url = res.data?.link;
  if (!url || !/^https?:\/\//.test(url)) throw new Error("رد غير صالح من file.io");
  return url;
}

// Primary: host the file on the bot's own web server (no third-party limits,
// no datacenter-IP blocking). External hosts are only a fallback.
async function uploadSelfHost(buffer, filename) {
  if (!isSelfHostAvailable()) throw new Error("الاستضافة الذاتية غير مفعّلة (لا يوجد رابط https عام)");
  const ext = String(filename).split(".").pop();
  const { url } = await hostBuffer(buffer, ext);
  return url;
}

const PROVIDERS = [
  { name: "self-host",    fn: uploadSelfHost,  ttl: ttlLabel() },
  { name: "catbox.moe",   fn: uploadCatbox,    ttl: "دائم" },
  { name: "0x0.st",       fn: upload0x0,       ttl: "حتى 365 يوماً" },
  { name: "litterbox",    fn: uploadLitterbox, ttl: "72 ساعة" },
  { name: "tmpfiles.org", fn: uploadTmpfiles,  ttl: "ساعة واحدة" },
  { name: "file.io",      fn: uploadFileIO,    ttl: "حتى 7 أيام" },
];

async function uploadWithFallback(buffer, filename, contentType) {
  const errors = [];
  for (const p of PROVIDERS) {
    try {
      const url = await p.fn(buffer, filename, contentType);
      return { url, provider: p.name, ttl: p.ttl };
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 120);
      errors.push(`${p.name}: ${msg}`);
      console.warn(`[VL] ${p.name} فشل:`, msg);
    }
  }
  const err = new Error("فشلت جميع خدمات الرفع.");
  err.details = errors;
  throw err;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/* ---------------- الأمر ---------------- */

export default {
  config: {
    name: "vl",
    version: "1.0.0",
    author: "Sunken",
    role: 0,
    countDown: 10,
    category: "وسائط وتحميل",
    description: "رفع رسالة صوتية من مسنجر إلى رابط تحميل مباشر مع بدائل تلقائية.",
    usage: [
      "{pn}vl + رسالة صوتية — رفع المرفق",
      "رد على رسالة صوتية + {pn}vl — رفع المرفق المردود عليه",
    ],
  },

  onStart: async ({ api, event, message }) => {
    const { threadID, messageID } = event;
    const voice = detectVoice(event);

    if (!voice) {
      return global.safeSend(
        api,
        "🎙️ رفع رسالة صوتية إلى رابط تحميل\n" +
          "━━━━━━━━━━━━━━━━\n" +
          "📌 الطرق:\n" +
          "  • أرسل/أعد توجيه رسالة صوتية مع الأمر vl\n" +
          "  • أو رد على رسالة صوتية واكتب vl\n\n" +
          "🌐 يُرجِع رابط تحميل مباشر",
        threadID,
        null,
        messageID
      );
    }

    let statusMsgId = null;
    try {
      const sent = await new Promise((resolve, reject) =>
        global.safeSend(
          api,
          "⏳ جاري تحميل الرسالة الصوتية...",
          threadID,
          (err, info) => (err ? reject(err) : resolve(info)),
          messageID
        )
      );
      statusMsgId = sent?.messageID || null;
    } catch (_) {}

    const updateStatus = async (text) => {
      try {
        if (statusMsgId) await api.editMessage(text, statusMsgId);
      } catch (_) {}
    };

    try {
      const buffer = await downloadVoice(voice.url);

      await updateStatus(
        `⏳ جاري رفع الملف (${formatSize(buffer.length)})...`
      );

      const { ext, mime } = resolveFormat(voice);
      const filename = `voice_${Date.now()}.${ext}`;
      const { url, provider, ttl } = await uploadWithFallback(buffer, filename, mime);

      if (statusMsgId) {
        try { await api.unsendMessage(statusMsgId); } catch (_) {}
      }

      return global.safeSend(
        api,
        `${url}\n⏱️ مدة الرابط: ${ttl}`,
        threadID,
        null,
        messageID
      );
    } catch (error) {
      console.error("[VL]", String(error?.message || error).slice(0, 200));

      if (statusMsgId) {
        try { await api.unsendMessage(statusMsgId); } catch (_) {}
      }

      const detail = error?.details?.length
        ? "\n\n" + error.details.join("\n")
        : "";

      return message.reply(
        `❌ تعذّر رفع الرسالة الصوتية\n` +
          `${String(error?.message || "خطأ غير معروف").slice(0, 300)}${detail}`
      );
    }
  },
};