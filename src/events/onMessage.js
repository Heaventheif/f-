"use strict";
import { handleMessage, handleEvent, handleReaction, invalidateThreadInfoCache } from "../core/Router.js";
import { isGroupUnbanRequest } from "../utils/banList.js";
// ─── Bounded concurrency queue ───────────────────────────────────
// Prevents unbounded concurrent command execution that can cause
// unhandled-rejection crashes under Node 20+ and Meta rate-limiting.
const configuredConcurrency = Number.parseInt(process.env.MAX_CONCURRENT_COMMANDS || "5", 10);
const MAX_CONCURRENT = Number.isInteger(configuredConcurrency) && configuredConcurrency > 0
  ? Math.min(configuredConcurrency, 50) : 5;
let _activeSlots = 0;
const _pendingQueue = [];

const MAX_QUEUE = 500;

function _enqueue(fn) {
  return new Promise((resolve, reject) => {
    if (_pendingQueue.length >= MAX_QUEUE) {
      reject(new Error("queue full"));
      return;
    }
    _pendingQueue.push({ fn, resolve, reject });
    _drainQueue();
  });
}

function _drainQueue() {
  while (_activeSlots < MAX_CONCURRENT && _pendingQueue.length > 0) {
    const { fn, resolve, reject } = _pendingQueue.shift();
    _activeSlots++;
    fn()
      .then(resolve, reject)
      .finally(() => { _activeSlots--; _drainQueue(); });
  }
}
// ────────────────────────────────────────────────────────────────

export function dispatchMqttEvent(api, event, label, acceptedThreads) {
  const threadBanned = global._bannedGroups?.has(String(event.threadID));
  const senderBanned = global._bannedUsers?.has(String(event.senderID ?? event.userID));
  if (senderBanned || (threadBanned && !isGroupUnbanRequest({ ...event, api }))) return;

  // Group-only policy: ignore DMs and message requests without replying or accepting them.
  if (!event.isGroup) return;

  // [FIX ADMIN CACHE] إبطال cache المجموعة فوراً عند تغيير المشرفين
  if (event.logMessageType === "change_thread_admins" && event.threadID) {
    invalidateThreadInfoCache(event.threadID);
  }

  // [FIX CACHE EVICT] Invalidate thread cache when the bot itself is removed
  // from a group — otherwise stale data lingers for up to 5 min and causes
  // confusing "not an admin" errors if the bot rejoins the same group.
  if (
    event.logMessageType === "remove_from_group" &&
    event.threadID &&
    event.participantIDs?.some(id => String(id) === String(api.getCurrentUserID?.()))
  ) {
    invalidateThreadInfoCache(event.threadID);
    console.log(`[CACHE] 🗑️ Bot أُخرج من المجموعة ${event.threadID} — cache مُبطَل.`);
  }

  if (["message", "message_reply", "log", "event"].includes(event.type)) {
    // Route through bounded queue — prevents unbounded parallelism and ensures
    // every async path has a top-level catch that never terminates the process.
    // handleEvent (onChat) وhandleMessage (الأمر) مستقلان: يعملان بالتوازي كي لا ينتظر
    // الأمر انتهاء معالجات onChat البطيئة (تنزيل رابط، نقلة شطرنج...). يبقى الـ slot محجوزًا
    // حتى ينتهي الاثنان.
    _enqueue(async () => {
      await Promise.all([
        (async () => {
          try { await handleEvent(api, event); }
          catch (e) { console.error(`[EVENT ERR:${label}]`, e?.message ?? e); }
        })(),
        (async () => {
          try { await handleMessage(api, event); }
          catch (e) { console.error(`[MSG ERR:${label}]`, e?.message ?? e); }
        })(),
      ]);
    }).catch(e => console.error(`[QUEUE ERR:${label}]`, e?.message ?? e));
  } else if (event.type === "message_reaction") {
    try {
      handleReaction(api, event);
    } catch (e) {
      console.error(`[REACTION ERR:${label}]`, e?.message ?? e);
    }
  }
}
