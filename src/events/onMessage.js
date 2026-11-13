"use strict";
import {
  handleMessage,
  handleEvent,
  handleReaction,
  invalidateThreadInfoCache,
} from "../core/Router.js";
import { isGroupUnbanRequest } from "../utils/banList.js";
import { isBotOff, isBotRestoreRequest, isGroupControlRequest } from "../utils/offState.js";
import { LRU } from "../infra/lru.js";
import { AppError } from "../infra/errors.js";

const intEnv = (v, d, max = Infinity) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : d;
};
const MAX_CONCURRENT = intEnv(process.env.MAX_CONCURRENT_COMMANDS, 5, 50);
const TASK_TIMEOUT_MS = intEnv(process.env.TASK_TIMEOUT_MS, 180_000);

// Per-thread serial queue + global concurrency cap + per-task timeout.
// A hung task frees its slot when the timeout fires (it is also aborted).
export function createDispatcher({
  maxConcurrent = MAX_CONCURRENT,
  maxQueue = 500,
  maxPerThread = 50,
  taskTimeoutMs = TASK_TIMEOUT_MS,
} = {}) {
  const threads = new Map();
  const ready = [];
  let active = 0;
  let queued = 0;
  function runJob({ fn, resolve, reject }) {
    return new Promise((done) => {
      const ac = new AbortController();
      let settled = false;
      let timer;
      const fin = (f, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        f(v);
        done();
      };
      timer = setTimeout(() => {
        ac.abort();
        fin(reject, new AppError("timeout", "task timed out"));
      }, taskTimeoutMs);
      Promise.resolve()
        .then(() => fn(ac.signal))
        .then(
          (v) => fin(resolve, v),
          (e) => fin(reject, e),
        );
    });
  }
  function drain() {
    while (active < maxConcurrent && ready.length) {
      const tid = ready.shift();
      const t = threads.get(tid);
      const job = t.q.shift();
      queued--;
      active++;
      runJob(job).then(() => {
        active--;
        if (t.q.length) ready.push(tid);
        else threads.delete(tid);
        drain();
      });
    }
  }
  function submit(threadID, fn) {
    return new Promise((resolve, reject) => {
      const tid = String(threadID);
      let t = threads.get(tid);
      if (queued >= maxQueue || (t && t.q.length >= maxPerThread)) {
        reject(new AppError("rate_limited", "queue full"));
        return;
      }
      if (!t) {
        t = { q: [] };
        threads.set(tid, t);
        t.q.push({ fn, resolve, reject });
        ready.push(tid);
      } else t.q.push({ fn, resolve, reject });
      queued++;
      drain();
    });
  }
  return { submit, stats: () => ({ active, queued, threads: threads.size }) };
}
const dispatcher = createDispatcher();

// Message dedupe by (thread, messageID) with TTL: the same event can arrive twice
// (reconnects, several bots in one group).
const _seen = new LRU({ maxEntries: 10_000, maxBytes: 4 * 1024 * 1024, ttlMs: 10 * 60 * 1000 });
export function isDuplicateMessage(event, seen = _seen) {
  if (!event?.messageID || !["message", "message_reply"].includes(event.type)) return false;
  const key = `${event.threadID}:${event.messageID}`;
  if (seen.get(key)) return true;
  seen.set(key, 1);
  return false;
}
// Command first, then onChat listeners, strictly in order for one message.
async function processMessage(api, event, label) {
  try {
    await handleMessage(api, event);
  } catch (e) {
    console.error(`[MSG ERR:${label}]`, e?.message ?? e);
  }
  try {
    await handleEvent(api, event);
  } catch (e) {
    console.error(`[EVENT ERR:${label}]`, e?.message ?? e);
  }
}
export function dispatchMqttEvent(api, event, label, acceptedThreads) {
  const threadBanned = global._bannedGroups?.has(String(event.threadID));
  const senderBanned = global._bannedUsers?.has(String(event.senderID ?? event.userID));
  if (
    senderBanned ||
    (threadBanned && !isGroupUnbanRequest({ ...event, api }, api?.__botIndex ?? null))
  )
    return;
  if (!event.isGroup) return;
  if (event.logMessageType === "change_thread_admins" && event.threadID) {
    invalidateThreadInfoCache(event.threadID);
  }
  if (
    event.logMessageType === "remove_from_group" &&
    event.threadID &&
    event.participantIDs?.some((id) => String(id) === String(api.getCurrentUserID?.()))
  ) {
    invalidateThreadInfoCache(event.threadID);
    console.log(`[CACHE] 🗑️ Bot أُخرج من المجموعة ${event.threadID} — cache مُبطَل.`);
  }
  let commandOnly = false;
  if (isBotOff(event.threadID)) {
    const restore = isBotRestoreRequest(event, api);
    const unban = isGroupUnbanRequest({ ...event, api }, api?.__botIndex ?? null);
    const control = isGroupControlRequest(event, api?.__botIndex ?? null);
    if (!restore && !unban && !control) return;
    commandOnly = true;
  }
  if (["message", "message_reply", "log", "event"].includes(event.type)) {
    if (isDuplicateMessage(event)) return;
    dispatcher
      .submit(event.threadID, async () => {
        if (commandOnly) {
          await handleMessage(api, { ...event, messageReply: void 0 });
          return;
        }
        await processMessage(api, event, label);
      })
      .catch((e) => console.error(`[QUEUE ERR:${label}]`, e?.message ?? e));
  } else if (event.type === "message_reaction") {
    try {
      handleReaction(api, event);
    } catch (e) {
      console.error(`[REACTION ERR:${label}]`, e?.message ?? e);
    }
  }
}
