"use strict";

import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import http from "../../utils/fetchHttp.js";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const STYLES = {
  anime: {
    label: "أنمي",
    prompt:
      "anime style, japanese animation art, high quality illustration, " +
      "detailed features, vibrant colors, cinematic lighting, masterpiece, best quality",
  },
  ghibli: {
    label: "جيبلي",
    prompt:
      "studio ghibli style, hand-drawn anime, soft watercolor tones, " +
      "peaceful atmosphere, cinematic composition, masterpiece",
  },
};

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "bmp", "gif"]);

/* ---------------- كشف الصورة (يدعم الردود بكل أشكالها) ---------------- */

function detectImage(event) {
  const tryUrl = (val) => {
    if (typeof val !== "string") return null;
    const m = val.match(
      /https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp|gif|bmp)(?:\?[^\s"'<>]*)?/i
    );
    return m ? m[0] : null;
  };

  const fromAttachment = (att) => {
    if (!att) return null;
    const type = String(att.type || att.attachmentType || "").toLowerCase();

    if (["photo", "image", "sticker", "animated_image"].includes(type)) {
      const url =
        att.largePreviewUrl || att.previewUrl || att.thumbnailUrl ||
        att.url || att.uri || att.src ||
        tryUrl(att.href);
      if (url) return url;
    }
    if (type === "file" || type === "document") {
      const ext = String(att.filename || att.name || "").split(".").pop().toLowerCase();
      if (IMAGE_EXTS.has(ext)) {
        const url = att.url || att.uri || att.downloadUrl || tryUrl(att.href);
        if (url) return url;
      }
    }
    return tryUrl(att.url) || tryUrl(att.uri) || tryUrl(att.href);
  };

  // 1) الرسالة الحالية
  for (const att of event.attachments || []) {
    const url = fromAttachment(att);
    if (url) return { url, source: "current" };
  }

  // 2) الرسالة المردود عليها
  const reply = event.messageReply;
  if (reply) {
    for (const att of reply.attachments || []) {
      const url = fromAttachment(att);
      if (url) return { url, source: "reply.attachment" };
    }
    for (const arg of reply.args || []) {
      const url = tryUrl(arg);
      if (url) return { url, source: "reply.args" };
    }
    const bodyUrl = tryUrl(reply.body);
    if (bodyUrl) return { url: bodyUrl, source: "reply.body" };
    const snippetUrl = tryUrl(reply.snippet);
    if (snippetUrl) return { url: snippetUrl, source: "reply.snippet" };
  }

  return null;
}

/* ---------------- تنزيل الصورة ---------------- */

async function downloadImage(url) {
  const res = await http.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: {
      "User-Agent": BROWSER_UA,
      "Referer": "https://www.facebook.com/",
      "Accept": "image/*",
    },
  });
  const buffer = Buffer.from(res.data);
  if (!buffer.length) throw new Error("الصورة فارغة.");
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `الصورة كبيرة (${(buffer.length / 1024 / 1024).toFixed(1)}MB، الحد 15MB).`
    );
  }
  return buffer;
}

/* ---------------- رفع الصورة (للاستخدام مع Pollinations img2img) ---------------- */

async function uploadToCatbox(buffer) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("fileToUpload", new Blob([buffer], { type: "image/jpeg" }), `img_${Date.now()}.jpg`);
  const res = await http.post("https://catbox.moe/user/api.php", form, {
    timeout: 90000,
    headers: { "User-Agent": BROWSER_UA },
  });
  const url = String(res.data || "").trim();
  if (!/^https:\/\/files\.catbox\.moe\//.test(url)) throw new Error("فشل الرفع إلى catbox");
  return url;
}

async function uploadTo0x0(buffer) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "image/jpeg" }), `img_${Date.now()}.jpg`);
  const res = await http.post("https://0x0.st", form, {
    timeout: 60000,
    headers: { "User-Agent": "SunkenBot/5.0 (ani)" },
  });
  const url = String(res.data || "").trim();
  if (!/^https:\/\/0x0\.st\//.test(url)) throw new Error("فشل الرفع إلى 0x0.st");
  return url;
}

async function uploadImage(buffer) {
  try {
    return await uploadToCatbox(buffer);
  } catch (e) {
    console.warn("[ANI] catbox فشل، تجربة 0x0:", e.message);
  }
  return await uploadTo0x0(buffer);
}

/* ---------------- محركات التحويل ---------------- */

async function tryDeepAI(buffer) {
  const apiKey = process.env.DEEPAI_KEY;
  if (!apiKey) throw new Error("DEEPAI_KEY غير مضبوط");
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: "image/jpeg" }), "image.jpg");
  const res = await http.post("https://api.deepai.org/api/anime", form, {
    timeout: 90000,
    headers: { "api-key": apiKey, "User-Agent": BROWSER_UA },
  });
  const outUrl = res.data?.output_url;
  if (!outUrl || !/^https?:\/\//.test(outUrl)) throw new Error("رد غير صالح من DeepAI");
  const img = await http.get(outUrl, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: { "User-Agent": BROWSER_UA },
  });
  const buf = Buffer.from(img.data);
  if (buf.length < 5000) throw new Error("صورة DeepAI فارغة");
  return buf;
}

async function tryPollinations(imageUrl, style, model) {
  const prompt = STYLES[style].prompt;
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?model=${model}&image=${encodeURIComponent(imageUrl)}&nologo=true&enhance=true`;
  const res = await http.get(url, {
    responseType: "arraybuffer",
    timeout: 120000,
    headers: { "User-Agent": BROWSER_UA, "Accept": "image/*" },
  });
  const buf = Buffer.from(res.data);
  const ct = String(res.headers?.["content-type"] || "");
  if (!ct.includes("image")) throw new Error(`رد ليس صورة (${ct.slice(0, 40) || "empty"})`);
  if (buf.length < 5000) throw new Error("صورة صغيرة جداً");
  return buf;
}

async function transform(imageBuffer, style) {
  const errors = [];

  if (process.env.DEEPAI_KEY) {
    try {
      return { buffer: await tryDeepAI(imageBuffer), provider: "DeepAI" };
    } catch (e) {
      errors.push(`DeepAI: ${String(e.message || e).slice(0, 80)}`);
      console.warn("[ANI] DeepAI فشل:", e.message);
    }
  }

  let publicUrl;
  try {
    publicUrl = await uploadImage(imageBuffer);
  } catch (e) {
    throw new Error(`فشل رفع الصورة: ${e.message}`);
  }

  for (const model of ["kontext", "flux"]) {
    try {
      const buffer = await tryPollinations(publicUrl, style, model);
      return { buffer, provider: `Pollinations (${model})` };
    } catch (e) {
      errors.push(`${model}: ${String(e.message || e).slice(0, 80)}`);
      console.warn(`[ANI] Pollinations ${model} فشل:`, e.message);
    }
  }

  const err = new Error("فشلت جميع خدمات التحويل.");
  err.details = errors;
  throw err;
}

/* ---------------- الأمر ---------------- */

export default {
  config: {
    name: "ani",
    version: "1.0.0",
    author: "Sunken",
    role: 0,
    countDown: 20,
    category: "ذكاء اصطناعي",
    description: "تحويل صورة إلى نمط أنمي (أنمي أو جيبلي) مع بدائل تلقائية.",
    usage: [
      "رد على صورة + {pn}ani — نمط أنمي افتراضي",
      "رد على صورة + {pn}ani ghibli — نمط جيبلي",
    ],
  },

  onStart: async ({ api, event, args, message }) => {
    const { threadID, messageID } = event;
    const image = detectImage(event);

    if (!image) {
      return message.reply(
        "🎨 تحويل صورة إلى أنمي\n" +
          "━━━━━━━━━━━━━━━━\n" +
          "📌 الطرق:\n" +
          "  • رد على صورة واكتب: ani\n" +
          "  • أو أرسل صورة مع الأمر: ani\n\n" +
          "🎭 الأنماط:\n" +
          "  ani — أنمي افتراضي\n" +
          "  ani ghibli — نمط جيبلي"
      );
    }

    const styleArg = String(args[0] || "").toLowerCase();
    const style = STYLES[styleArg] ? styleArg : "anime";

    let statusMsgId = null;
    try {
      const sent = await new Promise((resolve, reject) =>
        global.safeSend(
          api,
          `🎨 جاري تحويل الصورة إلى ${STYLES[style].label}...`,
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
      await updateStatus("⬇️ تنزيل الصورة...");
      const buffer = await downloadImage(image.url);

      await updateStatus(
        `🎨 تحويل إلى ${STYLES[style].label}... (قد يستغرق 30–60 ثانية)`
      );
      const { buffer: resultBuf, provider } = await transform(buffer, style);

      if (statusMsgId) {
        try {
          await api.unsendMessage(statusMsgId);
        } catch (_) {}
      }

      const stream = Readable.from(resultBuf);
      stream.path = `ani_${Date.now()}.jpg`;

      await global.mediaSend(
        api,
        {
          body: `🎨 ${STYLES[style].label} · ${provider}`,
          attachment: stream,
        },
        threadID,
        undefined,
        messageID
      );
    } catch (error) {
      console.error("[ANI]", String(error?.message || error).slice(0, 200));
      if (statusMsgId) {
        try {
          await api.unsendMessage(statusMsgId);
        } catch (_) {}
      }
      const detail = error?.details?.length ? "\n\n" + error.details.join("\n") : "";
      await message.reply(
        `❌ تعذّر تحويل الصورة: ${String(error?.message || "خطأ غير معروف").slice(0, 200)}${detail}`
      );
    }
  },
};