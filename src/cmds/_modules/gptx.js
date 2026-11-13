"use strict";
import { fetchJson } from "../../net/safeFetch.js";
import { LRU } from "../../infra/lru.js";
import { userMessage } from "../../infra/errors.js";
import { loadCtx, saveCtx, clearCtx } from "../../utils/sharedSession.js";
import { buildGroupPrompt, resolveGroupUsername } from "../../utils/groupConversation.js";
import {
  TEXT_PROVIDERS,
  IMAGE_PROVIDERS,
  MODEL_ALIASES,
  resolveModel,
  modelListing,
  orderProviders,
  runChain,
} from "../../ai/providers.js";
import { cleanReply, chunkText } from "../../ai/text.js";
import { converse, resetThread, autoReplyAllowed, chainAllowed, isBotSender } from "../../ai/session.js";
import { detectAttachment, fetchImage } from "../../ai/media.js";

const COLLECTION = "gptx_sessions";
const COLLECTION_ACTIVE = "gptx_active";
const DETECT_URL = "https://betadash-api-swordslush-production.up.railway.app/aidetect";
const SYSTEM_TRIGGERS = ["gptx", "ai", "ذكاء"];
const CMD_ON = ["on", "تفعيل", "شغل", "يلا"];
const CMD_OFF = ["off", "إيقاف", "وقف", "سكت", "اسكت"];
const CMD_CLEAR = ["clear", "مسح", "reset"];
const BOT_CMD_PREFIXES = [".", "/", "!", "#", "-"];
const MAX_PROMPT_CHARS = 4000;

function isRegisteredCommand(text) {
  const prefixes = Array.isArray(global.config?.Prefix) ? global.config.Prefix : [""];
  for (const p of prefixes) {
    const pre = String(p ?? "");
    if (!text.startsWith(pre)) continue;
    const word = text.slice(pre.length).trim().split(/\s+/)[0]?.toLowerCase();
    if (word && global.commands?.has(word)) return true;
  }
  return false;
}

// Bounded per-thread caches (model choice, auto-reply flag).
const _modelMap = new LRU({ maxEntries: 2000, maxBytes: 1024 * 1024, ttlMs: 60 * 60 * 1000 });
const _activeMap = new LRU({ maxEntries: 2000, maxBytes: 1024 * 1024, ttlMs: 30 * 60 * 1000 });

async function isActive(threadID) {
  const hit = _activeMap.get(threadID);
  if (hit !== undefined) return hit;
  const state = await loadCtx(COLLECTION_ACTIVE, threadID);
  const val = !Array.isArray(state) && state?.active === true;
  _activeMap.set(threadID, val);
  return val;
}
async function setActive(threadID, value) {
  const ok = await saveCtx(COLLECTION_ACTIVE, threadID, { active: value });
  _activeMap.set(threadID, value);
  return ok;
}

async function callAiDetect(text) {
  const url = `${DETECT_URL}?${new URLSearchParams({ text: text.slice(0, 1500) })}`;
  const json = await fetchJson(url, { timeoutMs: 30_000, retries: 1 });
  const d = json?.data ?? json;
  if (!d || typeof d !== "object") throw new Error("empty");
  return d;
}

async function sendChunks(message, text) {
  let info;
  for (const part of chunkText(text, 1800)) info = await message.reply(part);
  return info;
}

async function handleMessage(api, event, message, prompt, registerReply, depth = 0) {
  const { threadID } = event;
  prompt = String(prompt || "").trim();
  const lower = prompt.toLowerCase();

  // `set reset` must be matched before the generic `set <alias>`.
  if (lower === "set reset" || lower === "reset model") {
    _modelMap.delete(threadID);
    return message.reply("🔄 تم إعادة تعيين النموذج للترتيب الافتراضي.");
  }
  const setMatch = lower.match(/^set\s+(.+)$/);
  if (setMatch) {
    const alias = setMatch[1].trim();
    const name = resolveModel(alias);
    if (!name) {
      const list = Object.keys(MODEL_ALIASES).filter((k) => /^[a-z]/.test(k)).join(", ");
      return message.reply(`❓ نموذج غير معروف: "${alias}"\n\nالنماذج المتاحة:\n${list}`);
    }
    _modelMap.set(threadID, name);
    const disp = TEXT_PROVIDERS.find((p) => p.name === name)?.display ?? name;
    return message.reply(
      `✅ تم تغيير النموذج إلى: ${disp}\ngptx set claude  — للعودة لكلود\ngptx set reset   — للترتيب الافتراضي`,
    );
  }
  if (lower === "models" || lower === "نماذج") {
    const current = _modelMap.get(threadID);
    const curDisp = TEXT_PROVIDERS.find((p) => p.name === current)?.display ?? "افتراضي (أفضل متاح)";
    return message.reply(`🤖 النماذج المتاحة:\n\n${modelListing(current).join("\n")}\n\nالحالي: ${curDisp}`);
  }
  if (CMD_ON.includes(lower)) {
    const ok = await setActive(threadID, true);
    return message.reply(
      "✅ تم تفعيل الوضع التلقائي!\nالبوت سيرد على رسائل الغروب.\nلإيقافه: gptx off" +
        (ok ? "" : "\n⚠️ لم تُحفظ الحالة؛ ستُفقد عند إعادة التشغيل."),
    );
  }
  if (CMD_OFF.includes(lower)) {
    const ok = await setActive(threadID, false);
    return message.reply(
      "⛔ تم إيقاف الوضع التلقائي.\nالبوت سيرد فقط عند استدعائه صراحةً." +
        (ok ? "" : "\n⚠️ لم تُحفظ الحالة؛ ستُفقد عند إعادة التشغيل."),
    );
  }
  if (CMD_CLEAR.includes(lower)) {
    await resetThread(COLLECTION, threadID);
    return message.reply("🧹 تم مسح ذاكرة المجموعة.");
  }
  const detectMatch = prompt.match(/^detect\s+([\s\S]+)$/i) || prompt.match(/^كشف\s+([\s\S]+)$/);
  if (detectMatch) {
    try {
      const d = await callAiDetect(detectMatch[1].trim());
      const human = d.isHuman ?? "?";
      const ai = typeof d.fakePercentage === "number" ? d.fakePercentage : 100 - (d.isHuman ?? 50);
      const verdict = d.feedback ?? (ai > 50 ? "النص على الأرجح من AI" : "النص على الأرجح بشري");
      return message.reply(`🔍 نتيجة الكشف:\n\n👤 بشري: ${human}%\n🤖 AI: ${ai}%\n\n📋 ${verdict}`);
    } catch (e) {
      console.error("[GPTX:detect]", e?.code || e?.message);
      return message.reply(`❌ فشل الكشف: ${userMessage(e)}`);
    }
  }

  const att = detectAttachment(event);
  const hasImage = att?.kind === "image";
  if (!prompt && !hasImage) return message.reply("⚠️ اكتب سؤالاً أو ردّ على صورة.");
  if (prompt.length > MAX_PROMPT_CHARS) prompt = prompt.slice(0, MAX_PROMPT_CHARS);

  const senderName = await resolveGroupUsername(api, event);
  const shown = prompt || "[مرفق صورة]";
  const image = hasImage ? await fetchImage(att.url) : null;
  const imageOnly = "شوف هذه الصورة وعلق عليها بجملة واحدة قصيرة بالدارجة الجزائرية كيما تعلق على صورة صاحبك، بلا إيموجي.";

  let reply;
  try {
    reply = await converse(COLLECTION, threadID, { role: "user", username: senderName, content: shown }, async (history) => {
      const group = buildGroupPrompt(history, senderName, shown);
      const finalPrompt = prompt
        ? `أجب باللغة العربية الفصحى افتراضياً، إلا إذا طلبتُ صراحةً لغة أخرى.\n${group}`
        : `${imageOnly}\n${group}`;
      const ordered = orderProviders(TEXT_PROVIDERS, _modelMap.get(threadID));
      if (image) {
        try {
          return cleanReply((await runChain(IMAGE_PROVIDERS, finalPrompt, { image: image.dataUrl })).text);
        } catch {
          /* fall through to text-only */
        }
      }
      return cleanReply((await runChain(ordered, finalPrompt)).text);
    });
  } catch (e) {
    console.error("[GPTX] failed:", e?.code, JSON.stringify(e?.meta?.errors ?? []).slice(0, 300));
    return message.reply(`❌ ${userMessage(e)}`);
  }
  if (!reply) return message.reply("❌ استجابة فارغة، حاول مجدداً.");

  const info = await sendChunks(message, reply);
  if (registerReply && info?.messageID && chainAllowed(depth)) {
    registerReply(info.messageID, { threadID }, async ({ api: api2, event: event2, message: message2 }) => {
      const followUp = event2.body?.trim() || "";
      if (!followUp && !detectAttachment(event2)) return;
      await handleMessage(api2, event2, message2, followUp, registerReply, depth + 1);
    });
  }
}

export default {
  config: {
    name: "gptx",
    aliases: ["Ai"],
    version: "5.0.0",
    author: "Sunken",
    countDown: 3,
    role: 0,
    usePrefix: false,
    category: "ذكاء اصطناعي",
    description:
      "محادثة AI مشتركة حسب threadID؛ يستطيع كل عضو المتابعة ويُميّز الحوار أسماء المشاركين — تحليل الصور، والإجابة بالعربية افتراضياً",
    usage: [
      "{pn}gptx <سؤالك> — بدء محادثة",
      "{pn}gptx on/off — تفعيل/إيقاف الرد التلقائي",
      "{pn}gptx set <نموذج> — تغيير النموذج (claude/deepseek/qwen/gpt/mini/goody/reset)",
      "{pn}gptx models — عرض النماذج المتاحة",
      "{pn}gptx detect <نص> — كشف هل النص من AI أم لا",
      "رد على صورة + gptx — تحليل الصورة",
      "يمكن لأي عضو الرد على إجابة البوت لمواصلة نقاش المجموعة",
      "{pn}gptx مسح — مسح ذاكرة المحادثة",
    ],
  },
  onStart: async ({ api, event, args, message }) => {
    let prompt = args.join(" ").trim();
    if (!prompt && event.messageReply) prompt = event.messageReply.body || "";
    await handleMessage(api, event, message, prompt, message?.registerReply);
  },
  onChat: async ({ api, event, message }) => {
    if (isBotSender(api, event)) return;
    const { body, threadID } = event;
    const text = (body || "").trim();
    const lower = text.toLowerCase();
    const hasImage = !!detectAttachment(event);
    if (!text && !hasImage) return;
    if (text && isRegisteredCommand(text)) return;
    const trigger = SYSTEM_TRIGGERS.find((t) => lower === t || lower.startsWith(t + " "));
    if (trigger) {
      return handleMessage(api, event, message, text.slice(trigger.length).trim(), message?.registerReply);
    }
    if (await isActive(threadID)) {
      if (text && BOT_CMD_PREFIXES.some((p) => text.startsWith(p))) return;
      if (!hasImage && text.length < 2) return;
      if (!autoReplyAllowed(threadID)) return;
      return handleMessage(api, event, message, text, message?.registerReply);
    }
  },
};
