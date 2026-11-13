import { createReadStream } from "node:fs";
import { hostAllowed } from "../../net/safeFetch.js";
import { withTempDir, writeTmp } from "../../io/tmp.js";
import { hfPost, aiErrorText } from "../../ai/hf.js";
import { IMAGE_HOSTS, detectAttachment, fetchImage } from "../../ai/media.js";
import { converse, resetThread, chainAllowed } from "../../ai/session.js";
import { chunkText } from "../../ai/text.js";
import { formatGroupTurn, resolveGroupUsername } from "../../utils/groupConversation.js";

const COLLECTION = "groq_sessions";
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
const MAX_PROMPT_CHARS = 4000;
const CLEAR = ["clear", "مسح", "reset"];
const VOICE_FLAG = /^(?:-v|v|صوت)(?:\s+|$)/i;
const SEARCH_PREFIX = /^(?:بحث|ابحث|search|web)\s*[:：-]?\s*/i;

// Pure: splits the voice flag and search prefix off the prompt.
export function parseGroqPrompt(raw) {
  let p = String(raw || "").trim();
  let voice = false;
  let search = false;
  if (VOICE_FLAG.test(p)) {
    voice = true;
    p = p.replace(VOICE_FLAG, "").trim();
  }
  if (SEARCH_PREFIX.test(p)) {
    search = true;
    p = p.replace(SEARCH_PREFIX, "").trim();
  }
  return { prompt: p, voice, search };
}

const send = (api, text, threadID, replyTo, cb = null) => global.safeSend(api, text, threadID, cb, replyTo);
const sendP = (api, text, threadID, replyTo) =>
  new Promise((resolve, reject) => send(api, text, threadID, replyTo, (err, info) => (err ? reject(err) : resolve(info))));

async function sendVoice(api, threadID, replyTo, audioBase64, format) {
  return withTempDir(async (dir) => {
    const file = await writeTmp(dir, Buffer.from(audioBase64, "base64"), format);
    return new Promise((resolve, reject) =>
      api.sendMessage({ attachment: createReadStream(file) }, threadID, (err, info) => (err ? reject(err) : resolve(info)), replyTo),
    );
  }, "groqvoice");
}

async function handle(api, event, rawPrompt, registerReply, depth = 0) {
  const { threadID, messageID } = event;
  let { prompt, voice, search } = parseGroqPrompt(rawPrompt);
  if (CLEAR.includes(prompt.toLowerCase()) && !voice) {
    await resetThread(COLLECTION, threadID);
    return send(api, "🧹 تم مسح ذاكرة المجموعة.", threadID, messageID);
  }
  const repliedBody = event.messageReply?.body?.trim();
  if (repliedBody) {
    const quote = `[رد على]: "${repliedBody.slice(0, 500).replace(/"/g, "'")}"`;
    prompt = prompt ? `${quote}\n${prompt}` : quote;
  }
  prompt = prompt.slice(0, MAX_PROMPT_CHARS);
  const att = detectAttachment(event, { video: true });
  if (!prompt.trim() && !att) {
    return send(
      api,
      "❓ اكتب سؤالك أو أرسل صورة/فيديو.\nمثال: .groq كم ناتج 1+8؟\n.groq v <سؤالك> — رد صوتي 🔊\n.groq بحث <سؤالك> — بحث مباشر في الإنترنت\n.groq مسح — لمسح ذاكرة المجموعة",
      threadID,
      messageID,
    );
  }
  const sender = await resolveGroupUsername(api, event);
  let statusId = null;
  let statusSettled = false;
  try {
    const sent = await sendP(
      api,
      att ? `⏳ جاري تحليل ${att.kind === "image" ? "الصورة 🖼️" : "الفيديو 🎬"}...` : search ? "⏳ جاري البحث في الإنترنت 🌐..." : "⏳ جاري التفكير...",
      threadID,
      messageID,
    );
    statusId = sent?.messageID ?? null;
  } catch {}
  const updateStatus = async (text) => {
    try {
      if (statusId) await api.editMessage(text, statusId);
      else await sendP(api, text, threadID, messageID);
      statusSettled = true;
    } catch {
      // edit failed (e.g. too old): send as a fresh message
      try {
        await sendP(api, text, threadID, messageID);
        statusSettled = false;
      } catch {}
    }
  };
  let followUpId = null;
  try {
    const shown = prompt.trim() || (att?.kind === "video" ? "حلل هذا الفيديو" : "وصف هذه الصورة");
    const userContent = formatGroupTurn(sender, `${att ? `[${att.kind === "image" ? "صورة" : "فيديو"}] ` : ""}${shown}`);
    let attachment = null;
    if (att?.kind === "image") {
      const img = await fetchImage(att.url);
      if (img) attachment = { kind: "image", base64: img.base64, contentType: img.mime, model: GROQ_VISION_MODEL };
      else await updateStatus("⚠️ تعذّر تحميل الصورة، سأجيب على النص فقط...");
    } else if (att && hostAllowed(att.url, IMAGE_HOSTS) && att.url.startsWith("https:")) {
      attachment = { kind: att.kind, url: att.url };
    }
    let result;
    const reply = await converse(COLLECTION, threadID, { role: "user", username: sender, content: userContent }, async (history) => {
      const body = { messages: [...history, { role: "user", content: userContent }].map(({ role, content }) => ({ role, content })), prompt: userContent };
      if (attachment) body.attachment = attachment;
      if (voice) body.tts = true;
      if (search) body.web_search = true;
      result = await hfPost("/groq", body, { timeoutMs: 60_000 });
      if (!result?.reply) throw new Error(result?.error || "empty");
      return result.reply;
    });
    let voiceSent = false;
    if (voice && result.audio) {
      try {
        const info = await sendVoice(api, threadID, messageID, result.audio, result.audio_format || "wav");
        followUpId = info?.messageID ?? null;
        voiceSent = true;
      } catch (e) {
        console.warn("[GROQ] voice send failed:", String(e?.message).slice(0, 80));
      }
    }
    if (!voiceSent) {
      const prefix = voice ? "⚠️ تعذّر توليد الصوت، إليك الرد نصياً:\n\n" : "";
      const parts = chunkText(prefix + reply, 1800);
      await updateStatus(parts[0]);
      for (const p of parts.slice(1)) {
        const info = await sendP(api, p, threadID, messageID).catch(() => null);
        if (info?.messageID) followUpId = info.messageID;
      }
      if (parts.length === 1) followUpId = statusId;
    }
  } catch (e) {
    console.error("[groq]", e?.status || e?.code, String(e?.message).slice(0, 120));
    await updateStatus(aiErrorText(e));
    return;
  } finally {
    // Status message must never be left as "جاري ..." (voice path replaces it).
    if (statusId && !statusSettled) await api.unsendMessage(statusId).catch(() => {});
  }
  if (followUpId && registerReply && chainAllowed(depth)) {
    registerReply(followUpId, {}, async ({ api: a2, event: e2 }) => {
      await handle(a2, e2, e2.body?.trim() || "", registerReply, depth + 1);
    });
  }
}

export default {
  config: {
    name: "groq",
    aliases: ["ذكاء"],
    version: "1.0.0",
    author: "Sunken",
    countDown: 3,
    role: 0,
    category: "ذكاء اصطناعي",
    description:
      "محادثة Groq جماعية بذاكرة threadID مشتركة؛ أي عضو يستطيع المتابعة ويُميّز كل دور باسمه، مع دعم الصور والفيديو والصوت الناتج",
    usage: [
      "{pn}Ai4 <سؤالك> — رد نصي",
      "{pn}Ai4 v <سؤالك> — رد برسالة صوتية 🔊",
      "{pn}Ai4 + صورة/فيديو مرفق — تحليل الوسائط",
      "{pn}Ai4 بحث <سؤالك> — بحث مباشر في الإنترنت مع Groq Browser Search",
      "{pn}Ai4 مسح — مسح ذاكرة المحادثة الجماعية",
      "يمكن لأي عضو الرد على إجابة البوت لمواصلة نقاش المجموعة",
    ],
  },
  onStart: async ({ api, event, args, message }) => {
    await handle(api, event, args.join(" ").trim(), message?.registerReply);
  },
};
