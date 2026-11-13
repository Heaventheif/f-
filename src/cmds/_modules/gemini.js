import { hostAllowed } from "../../net/safeFetch.js";
import { hfPost, aiErrorText } from "../../ai/hf.js";
import { IMAGE_HOSTS, detectAttachment } from "../../ai/media.js";
import { converse, resetThread, chainAllowed } from "../../ai/session.js";
import { chunkText } from "../../ai/text.js";
import { formatGroupTurn, formatThreadHistory, resolveGroupUsername } from "../../utils/groupConversation.js";

const COLLECTION = "gemini_sessions";
const MAX_PROMPT_CHARS = 4000;
const CLEAR = ["clear", "مسح", "reset"];
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];

const send = (api, text, threadID, replyTo, cb = null) => global.safeSend(api, text, threadID, cb, replyTo);

// Image URLs are handed to the HF Space, so they must be https + on the Facebook CDN allowlist.
function imageAttachment(event) {
  const att = detectAttachment(event);
  if (att?.kind !== "image") return null;
  let u;
  try {
    u = new URL(att.url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !hostAllowed(att.url, IMAGE_HOSTS)) return null;
  const guess = u.pathname.split(".").pop().toLowerCase();
  return { url: att.url, ext: IMAGE_EXTS.includes(guess) ? guess : "jpg" };
}

function visionErrorMessage(e) {
  const s = e?.status;
  if (s === 502 || s === 503 || s === 504)
    return "❌ Gemini مشغول حالياً. أعد المحاولة بعد قليل، أو استخدم .groq مع الصورة.";
  if (s === 429) return "❌ وصلت Gemini إلى حد الطلبات المؤقت. انتظر قليلاً ثم أعد المحاولة.";
  return `❌ تعذّر تحليل الصورة${s ? ` (${s})` : ""}.`;
}

export function formatSources(sources) {
  if (!Array.isArray(sources) || !sources.length) return "";
  return "\n\n📎 المصادر:\n" + sources.slice(0, 5).map((s, i) => `${i + 1}. ${s}`).join("\n");
}

// Sends (chunked) and registers a bounded reply chain.
async function deliver(api, event, text, registerReply, depth) {
  const { threadID, messageID } = event;
  const parts = chunkText(text, 1800);
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    await send(api, parts[i], threadID, messageID, (err, info) => {
      if (!last || err || !info?.messageID || !registerReply || !chainAllowed(depth)) return;
      registerReply(info.messageID, {}, async ({ api: a2, event: e2 }) => {
        await handle(a2, e2, e2.body?.trim() || "", registerReply, depth + 1);
      });
    });
  }
}

async function handleSearch(api, event, query) {
  const { threadID, messageID } = event;
  if (!query.trim())
    return send(api, "🔍 بحث فوري بالإنترنت\n\nمثال: .search آخر أخبار الذكاء الاصطناعي", threadID, messageID);
  try {
    const r = await hfPost("/gemini/search", { query: query.slice(0, 500) }, { timeoutMs: 45_000 });
    if (!r?.reply) throw new Error("empty");
    return await send(api, `🔍 ${r.reply}${formatSources(r.sources)}`, threadID, messageID);
  } catch (e) {
    console.error("[SEARCH→HF]", e?.status || e?.code, String(e?.message).slice(0, 80));
    return send(api, "❌ فشل البحث، حاول لاحقاً.", threadID, messageID);
  }
}

async function handleVision(api, event, prompt, att, registerReply, depth) {
  const { threadID, messageID } = event;
  const sender = await resolveGroupUsername(api, event);
  const question = prompt.trim().slice(0, MAX_PROMPT_CHARS) || "صف هذه الصورة بالتفصيل";
  const userContent = formatGroupTurn(sender, `[مرفق صورة] ${question}`);
  let result;
  let sources = "";
  try {
    result = await converse(COLLECTION, threadID, { role: "user", username: sender, content: userContent }, async (history) => {
      const prior = formatThreadHistory(history);
      const visionPrompt = [
        "أجب بالعربية، وميّز بين أعضاء المجموعة بأسمائهم.",
        prior ? `سياق المجموعة السابق:\n${prior}` : "",
        userContent,
      ].filter(Boolean).join("\n\n");
      const r = await hfPost("/gemini/vision", { image_url: att.url, ext: att.ext, prompt: visionPrompt }, { timeoutMs: 90_000 });
      if (!r?.reply) throw new Error("empty");
      sources = formatSources(r.sources);
      return r.reply;
    });
  } catch (e) {
    console.error("[VISION→HF]", e?.status || e?.code, String(e?.message).slice(0, 120));
    return send(api, visionErrorMessage(e), threadID, messageID);
  }
  return deliver(api, event, `🖼️ ${result}${sources}`, registerReply, depth);
}

async function handle(api, event, prompt, registerReply, depth = 0) {
  const { threadID, messageID } = event;
  prompt = String(prompt || "").trim().slice(0, MAX_PROMPT_CHARS);
  if (CLEAR.includes(prompt.toLowerCase())) {
    await resetThread(COLLECTION, threadID);
    return send(api, "🧹 تم مسح ذاكرة المجموعة.", threadID, messageID);
  }
  if (!prompt)
    return send(
      api,
      "🤖 Gemini AI\n\n.gemini <سؤال> — محادثة بذاكرة جماعية\n.gemini مسح — مسح ذاكرة المجموعة\n📷 أرسل صورة مع سؤالك — يحللها تلقائياً\n🔍 .search <سؤال> — بحث فوري بالإنترنت",
      threadID,
      messageID,
    );
  const sender = await resolveGroupUsername(api, event);
  const userContent = formatGroupTurn(sender, prompt);
  let sources = "";
  let reply;
  try {
    reply = await converse(COLLECTION, threadID, { role: "user", username: sender, content: userContent }, async (history) => {
      const messages = [...history, { role: "user", content: userContent }].map(({ role, content }) => ({ role, content }));
      const r = await hfPost("/gemini", { messages }, { timeoutMs: 30_000 });
      if (!r?.reply) throw new Error("empty");
      sources = formatSources(r.sources);
      return r.reply;
    });
  } catch (e) {
    console.error("[GEMINI→HF]", e?.status || e?.code, String(e?.message).slice(0, 120));
    return send(api, aiErrorText(e), threadID, messageID);
  }
  return deliver(api, event, reply + sources, registerReply, depth);
}

export default {
  config: {
    name: "gemini",
    aliases: ["بوت"],
    version: "1.0.0",
    author: "Sunken",
    countDown: 5,
    role: 0,
    category: "ذكاء اصطناعي",
    description:
      "دردشة Gemini جماعية بذاكرة مشتركة حسب threadID؛ كل عضو يستطيع المتابعة مع تمييزه باسمه، مع تحليل الصور والبحث",
    usage: [
      "{pn}gemini <سؤال> — محادثة بذاكرة جماعية",
      "أي عضو يستطيع الرد على إجابة البوت لمواصلة الحوار المشترك",
      "{pn}gemini مسح — مسح ذاكرة المحادثة",
      "{pn}gemini (+ صورة) — تحليل الصورة والإجابة",
      "{pn}gemini <سؤال> (+ صورة) — سؤال محدد عن الصورة",
      "{pn}search <سؤال> — بحث فوري بالإنترنت",
    ],
  },
  onStart: async ({ api, event, args, message }) => {
    const cmdName = (event.command || "").toLowerCase();
    const prompt = args.join(" ").trim() || event.messageReply?.body || "";
    if (cmdName === "search") return handleSearch(api, event, prompt);
    const att = imageAttachment(event);
    if (att) return handleVision(api, event, prompt, att, message?.registerReply, 0);
    await handle(api, event, prompt, message?.registerReply);
  },
};
