"use strict";
import fs from "../../utils/fsCompat.js";
import { fetchBuffer, sniffImage } from "../../net/safeFetch.js";
import { AppError, userMessage } from "../../infra/errors.js";
import { withTempDir, writeTmp } from "../../io/tmp.js";
import { translateToEnglish } from "../../utils/translator.js";
import { sendStatus, sendPayload, reply, unsendQuiet } from "../../media/common.js";
const MAX_PROMPT_CHARS = 400;
const API_BASE = "https://t2i.anbuinfosec.workers.dev";
const STYLE_PRESETS = {
  anime: "anime style, vibrant colors",
  realistic: "photorealistic, 4k, detailed",
  pixel: "pixel art, retro game style",
  sketch: "pencil sketch, hand-drawn",
  watercolor: "watercolor painting, soft brushstrokes",
};
export default {
  config: {
    name: "img",
    aliases: ["تخيل"],
    version: "1.0.0",
    role: 0,
    countDown: 2,
    category: "ذكاء اصطناعي",
    description: "توليد صورة بالذكاء الاصطناعي من وصف نصي (مع دعم أنماط متعددة)",
    usage: [
      "{pn}imagine <وصف الصورة> — يولّد صورة",
      "{pn}imagine anime <وصف> — نمط أنيمي",
      "{pn}imagine realistic <وصف> — نمط واقعي",
      "{pn}imagine styles — عرض الأنماط المتاحة",
    ],
  },
  onStart: async ({ api, event, args, message }) => {
    const { threadID, messageID } = event;
    if (!args[0]) {
      return message.reply(
        "🎨 توليد صور بالذكاء الاصطناعي\n\n📝 الاستخدام: imagine <وصف الصورة>\n💡 مثال: imagine cyberpunk cat in the rain\n\n🎭 الأنماط المتاحة: anime | realistic | pixel | sketch | watercolor\nمثال: imagine anime فتاة تحت المطر",
      );
    }
    if (args[0].toLowerCase() === "styles") {
      return message.reply(
        "🎭 الأنماط المتاحة:\n" +
          Object.entries(STYLE_PRESETS)
            .map(([k, v]) => `• ${k} — ${v}`)
            .join("\n"),
      );
    }
    let style = null;
    let promptArgs = [...args];
    if (STYLE_PRESETS[args[0].toLowerCase()]) {
      style = STYLE_PRESETS[promptArgs.shift().toLowerCase()];
    }
    const rawPrompt = promptArgs.join(" ").trim();
    if (!rawPrompt) {
      return message.reply("❓ اكتب وصف الصورة بعد اسم النمط.");
    }
    const prompt = rawPrompt.slice(0, MAX_PROMPT_CHARS);
    const status = await sendStatus(api, threadID, "🎨 جاري توليد الصورة...", messageID);
    try {
      // translation is best-effort: fall back to the raw prompt
      let englishPrompt = await translateToEnglish(prompt).catch(() => prompt);
      englishPrompt = String(englishPrompt || prompt).slice(0, MAX_PROMPT_CHARS);
      if (style) englishPrompt = `${englishPrompt}, ${style}`;
      const buf = await fetchBuffer(`${API_BASE}/${encodeURIComponent(englishPrompt)}`, {
        timeoutMs: 6e4, maxBytes: 15 * 1024 * 1024, allowHosts: ["workers.dev"], headers: { "User-Agent": "Mozilla/5.0" },
      });
      const kind = sniffImage(buf);
      if (!kind) throw new AppError("upstream", "non_image_response");
      const captionParts = [`🧠 الوصف: ${prompt}`];
      if (englishPrompt !== prompt) captionParts.push(`🌐 EN: ${englishPrompt}`);
      if (style) captionParts.push(`🎭 نمط: ${style}`);
      await withTempDir(async (dir) => {
        const file = await writeTmp(dir, buf, kind);
        await sendPayload(api, threadID, { body: captionParts.join("\n"), attachment: fs.createReadStream(file) }, messageID);
      }, "img");
    } catch (err) {
      console.error("[IMG:ERR]", err?.code || "", String(err?.message || err).slice(0, 200));
      await reply(api, threadID, `❌ فشل توليد الصورة: ${userMessage(err)}`, messageID);
    } finally {
      await unsendQuiet(api, status?.messageID); // status is always cleaned up
    }
  },
};
