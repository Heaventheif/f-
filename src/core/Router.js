"use strict";
import { buildMessageAPI, buildCommandContext, getReplyTargetID } from "./Context.js";
import { HANDLER_KEYS } from "./Loader.js";
import { isAuthorized } from "../middlewares/auth.js";
import { getCooldownMessage, consumeCooldown } from "../middlewares/cooldown.js";
import timing from "../utils/timing.js";
import { redactText } from "../fca/runtimeEnv.js";
import {
  isCommandOff,
  commandKey,
  isBotOff,
  isBotRestoreRequest,
  isGroupControlRequest,
} from "../utils/offState.js";
import { isGroupUnbanRequest } from "../utils/banList.js";
import { LRU } from "../infra/lru.js";
import { SingleFlight } from "../infra/limiter.js";
import { AppError, userMessage } from "../infra/errors.js";

const intEnv = (v, d) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};
export const DEFAULT_COMMAND_TIMEOUT_MS = intEnv(process.env.COMMAND_TIMEOUT_MS, 120_000);
export const REPLY_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- timeouts
// Runs fn(signal) and rejects with AppError("timeout") once ms elapse. The
// signal is aborted on timeout so cooperative handlers can stop early.
export async function runWithTimeout(fn, ms, label = "task") {
  const ac = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new AppError("timeout", `${label} timed out after ${ms}ms`);
      ac.abort(err);
      reject(err);
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => fn(ac.signal)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------- prefix parsing
// Pure: resolves the command for a message. Prefixed forms win; a command may
// also opt in to being called without prefix (usePrefix:false / nonPrefix:true).
export function parseCommand(messageText, prefixes, commands) {
  const text = String(messageText ?? "").trim();
  const sorted = [...(prefixes?.length ? prefixes : [""])]
    .map(String)
    .sort((a, b) => b.length - a.length);
  for (const pfx of sorted) {
    if (pfx !== "" && !text.startsWith(pfx)) continue;
    const resolved = pfx ? text.slice(pfx.length).trim() : text;
    const parts = resolved.split(/ +/);
    const name = parts[0]?.toLowerCase();
    const command = name ? commands.get(name) : null;
    if (command) return { command, commandName: name, args: parts.slice(1), matchedPrefix: pfx };
  }
  const rawParts = text.split(/ +/);
  const rawName = rawParts[0]?.toLowerCase();
  const rawCmd = rawName ? commands.get(rawName) : null;
  if (rawCmd && (rawCmd.config?.usePrefix === false || rawCmd.config?.nonPrefix === true)) {
    return { command: rawCmd, commandName: rawName, args: rawParts.slice(1), matchedPrefix: "" };
  }
  return { command: null, commandName: null, args: [], matchedPrefix: "" };
}

// ---------------------------------------------------------- reply registry
// A reply entry is claimed (not deleted) before running and only removed after
// the handler succeeded, so a failure/another user's reply never burns it.
export function claimReply(registry, messageID, senderID, now = Date.now()) {
  const entry = registry?.[messageID];
  if (!entry) return { status: "none" };
  if (now - (entry.timestamp || 0) > REPLY_TTL_MS) {
    delete registry[messageID];
    return { status: "none" };
  }
  if (entry.author && String(entry.author) !== String(senderID)) return { status: "foreign", entry };
  if (entry._busy) return { status: "busy", entry };
  entry._busy = true;
  return { status: "ok", entry };
}
export function finishReply(registry, messageID, entry, ok) {
  entry._busy = false;
  // The handler may have re-registered the same id; only drop our own entry.
  if (ok && registry?.[messageID] === entry) delete registry[messageID];
}

// ------------------------------------------------------- thread info cache
const THREAD_CACHE_TTL = 15 * 60 * 1000;
const THREAD_NEG_TTL = 30 * 1000;
const _threadInfo = new LRU({ maxEntries: 2000, maxBytes: 32 * 1024 * 1024, ttlMs: THREAD_CACHE_TTL });
const _threadNeg = new LRU({ maxEntries: 2000, maxBytes: 1024 * 1024, ttlMs: THREAD_NEG_TTL });
const _threadFlight = new SingleFlight();

async function fetchAdminIDsFallback(api, threadID) {
  try {
    const rawApi = api.__rawApi || api;
    if (typeof rawApi.getThreadInfo !== "function") return [];
    const info = await rawApi.getThreadInfo(threadID);
    const admins = info?.adminIDs;
    if (Array.isArray(admins) && admins.length > 0) return admins;
    if (Array.isArray(info?.userInfo)) {
      return info.userInfo
        .filter((u) => u?.isAdmin || u?.role === "admin" || u?.type === "admin")
        .map((u) => u.id)
        .filter(Boolean);
    }
    return [];
  } catch {
    return [];
  }
}
async function getThreadInfoCached(api, threadID) {
  const key = String(threadID);
  const hit = _threadInfo.get(key);
  if (hit) return hit;
  if (_threadNeg.get(key)) return null;
  return _threadFlight.run(key, async () => {
    try {
      const data = await api.getThreadInfo(key);
      if (data && typeof data === "object") {
        _threadInfo.set(key, data);
        return data;
      }
    } catch {}
    _threadNeg.set(key, 1);
    return null;
  });
}
export function invalidateThreadInfoCache(threadID) {
  if (!threadID) return;
  _threadInfo.delete(String(threadID));
  _threadNeg.delete(String(threadID));
}
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
  let adminIDs = threadInfo?.adminIDs;
  if (!Array.isArray(adminIDs) || adminIDs.length === 0) {
    adminIDs = await fetchAdminIDsFallback(api, event.threadID);
    if (adminIDs.length > 0 && threadInfo) threadInfo.adminIDs = adminIDs;
  }
  if (!adminIDs?.length) return false;
  return adminIDs.some((a) => extractAdminId(a) === senderStr);
}
export { getThreadInfoCached };

// ------------------------------------------------------------ api wrapping
const _wrapped = new WeakMap();
function wrapApi(rawApi) {
  if (!rawApi || typeof rawApi !== "object") return rawApi;
  let w = _wrapped.get(rawApi);
  if (!w) {
    w = global.wrapApiForSafety ? global.wrapApiForSafety(rawApi) : rawApi;
    _wrapped.set(rawApi, w);
  }
  return w;
}

// ------------------------------------------------------------ bot identity
const _botIdsByApi = new WeakMap();
function getBotIds(api) {
  const hit = api && typeof api === "object" ? _botIdsByApi.get(api) : null;
  if (hit) return hit;
  const ids = [];
  for (const getId of [
    () => api?.__botFbId,
    () => api?.__botId,
    () => api?.getCurrentUserID?.(),
    () => api?.ctx?.userID,
    () => api?._ctx?.userID,
  ]) {
    try {
      const value = getId();
      if (value !== null && value !== void 0 && String(value).trim() !== "")
        ids.push(String(value).trim());
    } catch {}
  }
  if (ids.length && api && typeof api === "object") _botIdsByApi.set(api, ids);
  return ids;
}
function isBotAuthoredEvent(api, event) {
  const senderIds = [event?.senderID, event?.userID, event?.author?.id, event?.author]
    .filter((value) => value !== null && value !== void 0 && String(value).trim() !== "")
    .map((value) => String(value).trim());
  if (!senderIds.length) return false;
  const botIds = getBotIds(api);
  return senderIds.some((senderId) => botIds.includes(senderId));
}

async function notify(api, text, threadID, replyTargetID) {
  try {
    await api.sendMessage(text, threadID, null, replyTargetID);
  } catch (e) {
    console.error("[ROUTER:notify]", redactText(e?.message));
  }
}

// ------------------------------------------------------------ reply handling
async function runReply({ api, event, threadID, replyTargetID, entry }) {
  const cmdForReply = entry.commandName ? global.commands.get(entry.commandName) : null;
  const handler =
    entry.onReply ||
    entry.callback ||
    (cmdForReply?.onReply ? (...a) => cmdForReply.onReply(...a) : null);
  if (typeof handler !== "function") return true;
  const replyEvent =
    replyTargetID !== event.messageID
      ? { ...event, commandMessageID: event.messageID, messageID: replyTargetID }
      : event;
  const replyMessage = buildMessageAPI(api, threadID, replyTargetID);
  const timeoutMs = cmdForReply?.config?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  try {
    await runWithTimeout(
      (signal) =>
        handler({ api, event: replyEvent, message: replyMessage, Reply: entry, signal }),
      timeoutMs,
      `reply:${entry.commandName || entry.cmdKey || "?"}`,
    );
    return true;
  } catch (e) {
    console.error("[REPLY ERROR]", redactText(e?.message));
    await notify(api, `⚠️ ${userMessage(e)}`, threadID, replyTargetID);
    return false;
  }
}

export const handleMessage = async (rawApi, event) => {
  if (isBotAuthoredEvent(rawApi, event)) return;
  const { threadID, senderID, body, messageReply } = event;
  const replyTargetID = getReplyTargetID(event);
  const hasAttachment = event.attachments?.length > 0;
  if (!body?.trim() && !hasAttachment) return;
  const api = wrapApi(rawApi);
  const messageText = body?.trim() ?? "";
  if (!event.isGroup) return;
  const botOff = isBotOff(threadID);
  const restore = botOff && isBotRestoreRequest(event, rawApi);
  const unban =
    botOff && isGroupUnbanRequest({ ...event, api: rawApi }, rawApi?.__botIndex ?? null);
  const control = botOff && isGroupControlRequest(event, rawApi?.__botIndex ?? null);
  if (botOff && !restore && !unban && !control) return;

  // A reply to a registered bot message goes to that handler only when it is
  // the registered author; anyone else's reply falls through as a normal message.
  if (messageReply && !restore && !unban && !control) {
    const registry = global.Kagenou?.replies;
    const claim = claimReply(registry, messageReply.messageID, senderID);
    if (claim.status === "busy") return;
    if (claim.status === "ok") {
      const entry = claim.entry;
      if (isCommandOff(threadID, entry.cmdKey || entry.commandName)) {
        finishReply(registry, messageReply.messageID, entry, false);
        return;
      }
      let ok = false;
      try {
        ok = await runReply({ api, event, threadID, replyTargetID, entry });
      } finally {
        finishReply(registry, messageReply.messageID, entry, ok);
      }
      return;
    }
  }

  const { command, commandName, args, matchedPrefix } = parseCommand(
    messageText,
    (global.config?.Prefix || [""]).map(String),
    global.commands,
  );
  if (!command) return;
  if (isCommandOff(threadID, command)) return;
  if (command.config?.enabled === false) {
    await notify(api, "⚠️ هذا الأمر معطّل مؤقتاً.", threadID, replyTargetID);
    return;
  }
  const eventWithCommand = { ...event, command: commandName };
  const _botIndex = rawApi?.__botIndex ?? null;
  const reqRole = command.config?.role ?? 0;
  const isGroupAdmin = reqRole >= 1 ? await resolveGroupAdmin(api, event) : false;
  const auth = isAuthorized(senderID, command, _botIndex, isGroupAdmin);
  if (auth !== true) {
    if (matchedPrefix) await notify(api, "⛔ ليس لديك صلاحية لاستخدام هذا الأمر.", threadID, replyTargetID);
    return;
  }
  const isGroup = !!event.isGroup;
  if (command.config?.groupOnly === true && !isGroup) {
    await notify(api, "⚠️ هذا الأمر يعمل داخل المجموعات فقط.", threadID, replyTargetID);
    return;
  }
  if (command.config?.dmOnly === true && isGroup) {
    await notify(api, "⚠️ هذا الأمر يعمل في الرسائل الخاصة فقط.", threadID, replyTargetID);
    return;
  }
  const fn = HANDLER_KEYS.map((k) => command[k]).find((f) => typeof f === "function");
  if (!fn) return;
  // Cooldown is checked and consumed only now, when the command truly executes.
  const cooldownError = getCooldownMessage(senderID, commandName);
  if (cooldownError) {
    await notify(api, cooldownError, threadID, replyTargetID);
    return;
  }
  consumeCooldown(senderID, commandName, command);

  global._cmdAnalytics = global._cmdAnalytics || {};
  const _ca = global._cmdAnalytics;
  if (!_ca[commandName]) _ca[commandName] = { count: 0, lastUsed: null };
  _ca[commandName].count++;
  _ca[commandName].lastUsed = new Date().toISOString();

  const role = global.getUserRole(senderID, _botIndex);
  const t0 = Date.now();
  const timer = timing.start(`command:${commandName}`);
  const timeoutMs = Number(command.config?.timeoutMs) > 0 ? Number(command.config.timeoutMs) : DEFAULT_COMMAND_TIMEOUT_MS;
  try {
    await runWithTimeout(
      (signal) =>
        fn(
          buildCommandContext({
            api,
            event: eventWithCommand,
            args,
            role,
            prefix: matchedPrefix,
            isGroupAdmin,
            cmdKey: commandKey(command),
            signal,
          }),
        ),
      timeoutMs,
      `command:${commandName}`,
    );
    timer.end();
    global.perfManager?.trackRequest(t0);
  } catch (err) {
    timer.end("(فشل)");
    global.perfManager?.trackError();
    console.error(`[command:${commandName}]`, redactText(err?.stack || err?.message || err));
    await notify(
      api,
      err?.code === "timeout"
        ? `⏱️ ${userMessage(err)}`
        : "⚠️ حدث خطأ أثناء تنفيذ الأمر، حاول مرة أخرى لاحقاً.",
      threadID,
      replyTargetID,
    );
  }
};

export const handleReaction = (api, event) => {
  if (event?.isGroup && isBotOff(event.threadID)) return;
  const msgID = event.messageID;
  if (!msgID) return;
  const entry = global.client.reactionListener[msgID];
  if (!entry) return;
  if (entry.threadID != null && String(entry.threadID) !== String(event.threadID)) return;
  const actorID = event?.userID ?? event?.senderID ?? event?.author?.id;
  if (entry.author && String(actorID) !== String(entry.author)) return;
  if (isCommandOff(event.threadID, entry.cmdKey)) return;
  global._reactionTimestamps.set(msgID, Date.now());
  Promise.resolve()
    .then(() => entry.callback({ api, event }))
    .catch((e) => console.error("[REACTION ERR]", redactText(e?.message)));
};

// onChat listeners. Runs AFTER command handling for the same message (the
// dispatcher awaits both in order) so the two never race on one message.
export const handleEvent = async (rawApi, event) => {
  if (isBotAuthoredEvent(rawApi, event)) return;
  if (
    !event.isGroup ||
    isBotOff(event.threadID) ||
    isGroupControlRequest(event, rawApi?.__botIndex ?? null)
  )
    return;
  if (!event.messageID || (!event.body && !(event.attachments?.length > 0))) return;
  const api = wrapApi(rawApi);
  const { command: resolvedCmd } = parseCommand(
    event.body ?? "",
    (global.config?.Prefix || [""]).map(String),
    global.commands,
  );
  const handlers = [];
  for (const cmd of global.eventCommands || []) {
    if (!cmd.onChat || cmd.config?.enabled === false) continue;
    if (isCommandOff(event.threadID, cmd)) continue;
    if (resolvedCmd && resolvedCmd === cmd) continue;
    const name = commandKey(cmd) || "?";
    handlers.push(
      runWithTimeout(
        () =>
          cmd.onChat({
            api,
            event,
            message: buildMessageAPI(api, event.threadID, event.messageID, commandKey(cmd)),
          }),
        cmd.config?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        `onChat:${name}`,
      ).catch((e) => console.error(`[onChat:${name}]`, redactText(e?.message))),
    );
  }
  await Promise.allSettled(handlers);
};
