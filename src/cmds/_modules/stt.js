"use strict";
import { hostAllowed } from "../../net/safeFetch.js";
import { hfPost } from "../../ai/hf.js";
import { listAttachments, IMAGE_HOSTS } from "../../ai/media.js";
import { chunkText } from "../../ai/text.js";

const AUDIO_EXT = ["mp3", "m4a", "ogg", "wav", "flac", "aac", "webm", "mp4", "mpeg", "mpga", "mov", "mkv"];
const MEDIA_HOSTS = [...IMAGE_HOSTS, "cdninstagram.com"];
const LANG_RE = /^[a-z]{2}$/; // ISO-639-1

// Pure: first arg is a language only if it is a 2-letter ISO code.
export function parseLanguage(args) {
  const first = String((args || [])[0] || "").trim().toLowerCase();
  return LANG_RE.test(first) ? first : first ? null : "ar";
}

export function detectAudio(event) {
  for (const att of listAttachments(event)) {
    const type = String(att.type || att.attachmentType || "").toLowerCase();
    const url = att.url || att.audioUrl || att.playableUrl || att.uri;
    if (!url) continue;
    if (["audio", "voice_message", "video", "video_inline"].includes(type)) return { kind: "audio", url, contentType: att.contentType || "" };
    if (type === "file" || type === "document") {
      const ext = String(att.filename || att.name || "").split(".").pop().toLowerCase();
      if (AUDIO_EXT.includes(ext)) return { kind: "audio", url, contentType: att.contentType || "" };
    }
  }
  return null;
}

export default {
  config: {
    name: "stt",
    aliases: ["تفريغ", "transcribe"],
    version: "2.0.0",
    role: 0,
    countDown: 5,
    category: "ذكاء اصطناعي",
    description: "تحويل الصوت أو الفيديو إلى نص عبر Groq Whisper",
    usage: [
      "{pn}stt + ملف صوتي/فيديو أو رسالة صوتية — تحويل الصوت إلى نص",
      "{pn}stt en + ملف صوتي — تحديد لغة الصوت (رمز من حرفين)",
    ],
  },
  onStart: async ({ api, event, args, message }) => {
    const audio = detectAudio(event);
    if (!audio) return message.reply("🎙️ أرسل رسالة صوتية أو أرفق ملفاً صوتياً/فيديو مع الأمر .stt");
    const language = parseLanguage(args);
    if (!language) return message.reply("❌ رمز اللغة غير صالح. استخدم رمزاً من حرفين مثل ar أو en.");
    if (!audio.url.startsWith("https:") || !hostAllowed(audio.url, MEDIA_HOSTS))
      return message.reply("❌ مصدر الملف غير مدعوم.");
    let statusId = null;
    try {
      statusId = (await message.reply("⏳ جاري تفريغ الصوت..."))?.messageID ?? null;
    } catch {}
    const finish = async (text) => {
      const parts = chunkText(text, 1800);
      let first = true;
      for (const p of parts) {
        if (first && statusId) {
          first = false;
          try {
            await api.editMessage(p, statusId);
            continue;
          } catch {}
        }
        first = false;
        await message.reply(p);
      }
    };
    try {
      const data = await hfPost("/groq/stt", { attachment: audio, language, response_format: "text" }, { timeoutMs: 90_000 });
      if (data?.error && !data.text) throw Object.assign(new Error(String(data.error)), { status: 502 });
      const text = String(data?.text ?? "").trim();
      if (!text) return await finish("🔇 لا يوجد كلام");
      return await finish(`📝 التفريغ النصي:\n\n${text}`);
    } catch (e) {
      console.error("[STT]", e?.status || e?.code, String(e?.message).slice(0, 120));
      const hint = e?.status === 503 ? " الخدمة مشغولة، أعد المحاولة لاحقاً." : "";
      return finish(`❌ فشل تحويل الصوت إلى نص${e?.status ? ` (HTTP ${e.status})` : ""}.${hint}`).catch(() => {});
    }
  },
};
