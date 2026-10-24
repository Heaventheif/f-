"use strict";
import { buildMessageAPI, buildCommandContext, getReplyTargetID } from "./Context.js";
import { HANDLER_KEYS } from "./Loader.js";
import { checkAuth } from "../middlewares/auth.js";
import { checkAndSetCooldown } from "../middlewares/cooldown.js";
import timing from "../utils/timing.js";

// ─── Thread Info Cache ───────────────────────────────────────────
// نجلب threadInfo مرة واحدة لكل مجموعة ونحتفظ بها 5 دقائق
// لتجنب استدعاءات API مكررة من كل أمر بشكل منفصل
const _threadInfoCache = new Map(); // threadID → { data, expiresAt }
const THREAD_CACHE_TTL = 5 * 60 * 1000; // 5 دقائق

async function getThreadInfoCached(api, threadID) {
  const now = Date.now();
  const cached = _threadInfoCache.get(threadID);
  if (cached && cached.expiresAt > now) return cached.data;
  try {
    const data = await api.getThreadInfo(threadID);
    _threadInfoCache.set(threadID, { data, expiresAt: now + THREAD_CACHE_TTL });
    return data;
  } catch {
    return null;
  }
}

// [FIX ADMIN] Helper: جلب adminIDs بطريقة بديلة إذا رجعت فارغة من getThreadInfo
// getThreadInfo يستخدم doc_id ثابت قد لا يُرجع thread_admins دائماً
async function fetchAdminIDsFallback(api, threadID) {
  try {
    // نُحاول جلب قائمة المشرفين من thread_info الـ legacy
    const rawApi = api.__rawApi || api;
    if (typeof rawApi.getThreadInfo !== "function") return [];
    const info = await rawApi.getThreadInfo(threadID);
    const admins = info?.adminIDs;
    if (Array.isArray(admins) && admins.length > 0) return admins;
    // fallback ثاني: من participantIDs + userInfo إذا كان الـ response يحملها
    if (Array.isArray(info?.userInfo)) {
      const adminList = info.userInfo
        .filter(u => u?.isAdmin || u?.role === "admin" || u?.type === "admin")
        .map(u => u.id)
        .filter(Boolean);
      if (adminList.length > 0) return adminList;
    }
    return [];
  } catch {
    return [];
  }
}

// تنظيف الإدخالات المنتهية كل 10 دقائق لمنع تراكم الذاكرة
// BUG-04 FIX: .unref() يسمح لـ Bun/Node بالخروج الطبيعي عند SIGTERM
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of _threadInfoCache) {
    if (entry.expiresAt <= now) _threadInfoCache.delete(id);
  }
}, 10 * 60 * 1000).unref();

// [FIX ADMIN CACHE] عند تغيير مشرفي المجموعة نُبطل cache الـ threadInfo فوراً
// حتى لا يبقى البوت يرفض المشرف الجديد لـ 5 دقائق
export function invalidateThreadInfoCache(threadID) {
  if (threadID) _threadInfoCache.delete(String(threadID));
}

// كشف هل المُرسِل مشرف في المجموعة
// [FIX ADMIN] adminIDs يأتي بشكلين من FCA:
//   - objects: [{id:"123"}, {id:"456"}]  ← من getThreadInfo / GraphQL
//   - strings: ["123", "456"]            ← من thread-info-realtime-sync
// نعالج كلا الشكلين
function extractAdminId(entry) {
  if (!entry) return null;
  if (typeof entry === "string" || typeof entry === "number") return String(entry);
  if (typeof entry === "object" && entry.id) return String(entry.id);
  return null;
}
async function resolveGroupAdmin(api, event) {
  if (!event.isGroup) return false;
  const senderStr = String(event.senderID);
  const threadInfo = await getThreadInfoCached(api, event.threadID);

  // [FIX ADMIN] إذا adminIDs فارغة أو null (GraphQL لم يُرجعها)، نجرب جلبها مباشرة
  let adminIDs = threadInfo?.adminIDs;
  if (!Array.isArray(adminIDs) || adminIDs.length === 0) {
    adminIDs = await fetchAdminIDsFallback(api, event.threadID);
    // نُحدّث الـ cache بالـ adminIDs الجديدة إذا نجحنا
    if (adminIDs.length > 0 && threadInfo) {
      threadInfo.adminIDs = adminIDs;
    }
  }
  if (!adminIDs?.length) return false;
  return adminIDs.some(a => extractAdminId(a) === senderStr);
}

// تصدير الـ cache ليتمكن الأوامر من استخدامه مباشرةً بدل استدعاء getThreadInfo
export { getThreadInfoCached };
export const handleMessage = async (rawApi, event) => {
  const { threadID, senderID, body, messageReply } = event;
  const replyTargetID = getReplyTargetID(event);
  const hasAttachment = (event.attachments?.length > 0);
  if (!body?.trim() && !hasAttachment) return;
  const api         = global.wrapApiForSafety(rawApi);
  const messageText = body?.trim() ?? "";
  // Group-only policy: do not read, answer, or otherwise process direct messages.
  if (!event.isGroup) return;
  if (messageReply && global.Kagenou.replies?.[messageReply.messageID]) {
    const replyData = global.Kagenou.replies[messageReply.messageID];
    if (!replyData.author || replyData.author === senderID) {
      delete global.Kagenou.replies[messageReply.messageID];
      const cmdForReply = replyData.commandName ? global.commands.get(replyData.commandName) : null;
      const handler = replyData.onReply || replyData.callback ||
        (cmdForReply?.onReply ? (...a) => cmdForReply.onReply(...a) : null);
      if (typeof handler === "function") {
        const replyEvent = replyTargetID !== event.messageID
          ? { ...event, commandMessageID: event.messageID, messageID: replyTargetID }
          : event;
        const replyMessage = buildMessageAPI(api, threadID, replyTargetID);
        await Promise.resolve().then(() =>
          handler({ api, event: replyEvent, message: replyMessage, Reply: replyData })
        ).catch(e => console.error("[REPLY ERROR]", e.message));
      }
    }
    return;
  }
  // Check explicit prefixes before the empty (prefixless) option. Otherwise
  // ["", "!"] consumes every message before "!" can ever match.
  const prefixes = (global.config?.Prefix || [""]).map(String)
    .sort((a, b) => b.length - a.length);
  let resolvedText  = null;
  let matchedPrefix = "";
  for (const pfx of prefixes) {
    if (pfx === "" || messageText.startsWith(pfx)) {
      matchedPrefix = pfx;
      resolvedText  = pfx ? messageText.slice(pfx.length).trim() : messageText;
      break;
    }
  }
  let commandName = null;
  let args        = [];
  let command     = null;
  if (resolvedText !== null) {
    const parts = resolvedText.split(/ +/);
    commandName = parts[0]?.toLowerCase();
    args        = parts.slice(1);
    command     = global.commands.get(commandName);
  }
  if (!command) {
    const rawParts = messageText.split(/ +/);
    const rawName  = rawParts[0]?.toLowerCase();
    const rawCmd   = rawName ? global.commands.get(rawName) : null;
    const allowsNoPrefix = rawCmd?.config?.usePrefix === false || rawCmd?.config?.nonPrefix === true;
    if (rawCmd && allowsNoPrefix) {
      commandName   = rawName;
      args          = rawParts.slice(1);
      command       = rawCmd;
      matchedPrefix = "";
    }
  }
  if (!command) return;
  if (command.config?.enabled === false) {
    api.sendMessage("⚠️ هذا الأمر معطّل مؤقتاً.", threadID, null, replyTargetID);
    return;
  }
  const eventWithCommand = { ...event, command: commandName };
  const _botIndex = rawApi?.__botIndex ?? null;
  const isGroupAdmin = await resolveGroupAdmin(api, event);
  const authError = checkAuth(senderID, command, _botIndex, isGroupAdmin);
  if (authError) return;
  const cooldownError = checkAndSetCooldown(senderID, commandName, command);
  if (cooldownError) { api.sendMessage(cooldownError, threadID, null, replyTargetID); return; }

  // Record usage for the analytics dashboard (in-memory, resets on restart)
  global._cmdAnalytics = global._cmdAnalytics || {};
  const _ca = global._cmdAnalytics;
  if (!_ca[commandName]) _ca[commandName] = { count: 0, lastUsed: null };
  _ca[commandName].count++;
  _ca[commandName].lastUsed = new Date().toISOString();
  const role    = global.getUserRole(senderID, _botIndex);
  const isGroup = !!event.isGroup;
  // فلترة: أوامر مقيّدة بالمجموعات أو الخاص فقط
  if (command.config?.groupOnly === true && !isGroup) {
    api.sendMessage("⚠️ هذا الأمر يعمل داخل المجموعات فقط.", threadID, null, replyTargetID);
    return;
  }
  if (command.config?.dmOnly === true && isGroup) {
    api.sendMessage("⚠️ هذا الأمر يعمل في الرسائل الخاصة فقط.", threadID, null, replyTargetID);
    return;
  }
  const t0 = Date.now();
  // Keep the dispatch queue slot until the command actually finishes.
  // Fire-and-forget here bypassed MAX_CONCURRENT_COMMANDS entirely.
  const timer = timing.start(`command:${commandName}`);
  try {
    const ctx = buildCommandContext({ api, event: eventWithCommand, args, role, prefix: matchedPrefix, isGroupAdmin });
    const fn  = HANDLER_KEYS.map(k => command[k]).find(f => typeof f === "function");
    if (fn) await fn(ctx);
    timer.end();
    global.perfManager?.trackRequest(t0);
  } catch (err) {
    timer.end("(فشل)");
    global.perfManager?.trackError();
    console.error(`[command:${commandName}]`, err.message);
    try {
      await api.sendMessage("⚠️ حدث خطأ أثناء تنفيذ الأمر — تم إبلاغ المطوّر تلقائياً.", threadID, null, replyTargetID);
    } catch (sendError) {
      console.error(`[command:${commandName}:send]`, sendError.message);
    }
  }
};
export const handleReaction = (api, event) => {
  const msgID = event.messageID;
  if (!msgID) return;
  const entry = global.client.reactionListener[msgID];
  if (!entry) return;
  if (entry.author && event.userID !== entry.author) return;
  global._reactionTimestamps.set(msgID, Date.now());
  Promise.resolve(entry.callback({ api, event }))
    .catch(e => console.error("[REACTION ERR]", e.message));
};
export const handleEvent = async (rawApi, event) => {
  if (!event.isGroup) return;
  const api       = global.wrapApiForSafety(rawApi);
  const firstWord = event.body?.trim().split(/ +/)[0]?.toLowerCase();
  // نحسب مرة واحدة هل firstWord يُحيل إلى أيّ أمر (سواء باسمه أو alias)
  const resolvedCmd = firstWord ? global.commands.get(firstWord) : null;
  const handlers = [];
  for (const cmd of global.eventCommands) {
    if (!cmd.onChat) continue;
    const hasAtt = (event.attachments?.length > 0);
    if (!event.messageID || (!event.body && !hasAtt)) continue;
    // تجاهل إذا كانت الرسالة تُطلق هذا الأمر بالذات (اسماً أو alias أو nonPrefix)
    if (resolvedCmd && resolvedCmd === cmd) continue;
    handlers.push(Promise.resolve().then(() =>
      cmd.onChat({ api, event, message: buildMessageAPI(api, event.threadID, event.messageID) })
    ));
  }
  // Keep the queue slot until onChat handlers settle too.
  await Promise.allSettled(handlers);
};

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-core-router',
  meta: { category: 'core', path: 'src/core/Router.js' },
  setup(_ctx) {
    // provides: handleEvent, handleMessage, handleReaction
  },
};
