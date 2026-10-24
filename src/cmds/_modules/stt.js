"use strict";
import http from "../../utils/fetchHttp.js";
import { getHfBase, getInternalToken } from "../../utils/hfClient.js";

function detectAudio(event) {
  const sources = [
    ...(event.attachments || []),
    ...(event.messageReply?.attachments || []),
  ];
  for (const att of sources) {
    if (!att) continue;
    const type = (att.type || att.attachmentType || "").toLowerCase();
    const url = att.url || att.audioUrl || att.uri;
    if ((type === "audio" || type === "voice_message") && url) {
      return { kind: "audio", url, contentType: att.contentType || "" };
    }
    if ((type === "file" || type === "document") && url) {
      const ext = (att.filename || att.name || "").split(".").pop().toLowerCase();
      if (["mp3", "m4a", "ogg", "wav", "flac", "aac", "webm", "mp4", "mpeg", "mpga"].includes(ext)) {
        return { kind: "audio", url, contentType: att.contentType || "" };
      }
    }
  }
  return null;
}

async function transcribe(audio, language = "ar") {
  const { data } = await http.post(
    `${getHfBase()}/groq/stt`,
    { attachment: audio, language, response_format: "text" },
    {
      timeout: 90000,
      retries: 2,
      retryDelay: 500,
      validateStatus: (status) => (status >= 200 && status < 300) || status === 503,
      headers: { "Content-Type": "application/json", "X-Internal-Token": getInternalToken() },
    }
  );
  if (!data?.text) {
    const error = new Error(data?.error || "استجابة تفريغ فارغة");
    error.response = { status: 502, data };
    throw error;
  }
  return data;
}

export default {
  config: {
    name: "stt",
    aliases: ["تفريغ", "transcribe"],
    version: "1.0.0",
    role: 0,
    countDown: 5,
    category: "ذكاء اصطناعي",
    description: "تحويل الصوت إلى نص عبر Groq Whisper",
    usage: [
      "{pn}stt + ملف صوتي أو رسالة صوتية — تحويل الصوت إلى نص",
      "{pn}stt ar + ملف صوتي — تفريغ عربي أدق",
    ],
  },
  onStart: async ({ event, args, message }) => {
    const audio = detectAudio(event);
    if (!audio) {
      return message.reply("🎙️ أرسل رسالة صوتية أو أرفق ملفاً صوتياً مع الأمر .stt");
    }
    const requestedLanguage = (args || []).join(" ").trim().split(/\s+/)[0] || "ar";
    try {
      const result = await transcribe(audio, requestedLanguage);
      return message.reply(`📝 التفريغ النصي عبر Groq Whisper:\n\n${result.text}`);
    } catch (e) {
      const status = e.response?.status;
      const details = e.response?.data?.error || e.message || "خطأ غير معروف";
      console.error("[STT→Groq]", status, details);
      const retryHint = status === 503
        ? " تم تدوير جميع مفاتيح Groq المتاحة؛ تحقق من المفاتيح أو أعد المحاولة لاحقاً."
        : "";
      return message.reply(`❌ فشل تحويل الصوت إلى نص${status ? ` (HTTP ${status})` : ""}: ${String(details).slice(0, 300)}${retryHint}`);
    }
  },
};
