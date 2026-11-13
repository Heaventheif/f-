"use strict";
import { setBan } from "../utils/banStore.js";
import { KeyedMutex } from "../infra/limiter.js";
import { AppError } from "../infra/errors.js";

const REPLY_TIMEOUT_MS = Math.max(
  1000,
  Number.parseInt(process.env.REPLY_TIMEOUT_MS || "", 10) || 180_000,
);
const MAX_REPLY_ENTRIES = 5000;
const INTERNAL_KEYS = new Set(["_dirty", "_lastSeen"]);

function callCb(cb, err, info) {
  if (typeof cb !== "function") return;
  try {
    cb(err, info);
  } catch (e) {
    console.error("[reply cb]", e?.message);
  }
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AppError("timeout", "reply timed out")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function buildMessageAPI(api, threadID, messageID, cmdKey) {
  return {
    // Always settles (send timeout + deadline); the callback fires exactly once.
    reply: (t, cb) =>
      withDeadline(
        Promise.resolve().then(() => global.safeSend(api, t, threadID, undefined, messageID)),
        REPLY_TIMEOUT_MS,
      ).then(
        (info) => {
          callCb(cb, null, info);
          return info || {};
        },
        (err) => {
          callCb(cb, err);
          throw err;
        },
      ),
    unsend: (msgID) => {
      try {
        const r = api.unsendMessage(msgID, () => {});
        if (r?.catch) r.catch(() => {});
      } catch (_) {}
    },
    // author / timestamp / cmdKey are authoritative: `d` cannot override them.
    registerReply: (id, d, cb, senderID) => {
      const replies = (global.Kagenou.replies ??= {});
      const key = String(id);
      const keys = Object.keys(replies);
      if (keys.length >= MAX_REPLY_ENTRIES) delete replies[keys[0]];
      replies[key] = {
        callback: cb,
        ...d,
        author: senderID == null ? null : String(senderID),
        timestamp: Date.now(),
        ...(cmdKey ? { cmdKey } : null),
      };
    },
  };
}
function getReplyTargetID(event) {
  return event?.messageReply?.messageID || event?.messageID;
}

const _userLocks = new KeyedMutex();
const _threadLocks = new KeyedMutex();
const clean = (data) =>
  Object.fromEntries(Object.entries(data || {}).filter(([k]) => !INTERNAL_KEYS.has(k)));

function buildUsersInterface() {
  return {
    getData: async (uid) => {
      const key = String(uid);
      if (typeof global.getUserData === "function") {
        try {
          return await global.getUserData(key);
        } catch (_) {}
      }
      const entry = global.usersData?.get(key);
      if (entry) {
        entry._lastSeen = Date.now();
        return entry;
      }
      return {};
    },
    setData: (uid, data) =>
      _userLocks.run(String(uid), async () => {
        const key = String(uid);
        const patch = clean(data);
        // Ban state is durable first: if persisting fails nothing changes in memory.
        if ("banned" in patch) {
          await setBan("user", key, !!patch.banned, patch.bannedBy ?? patch.unbannedBy);
        }
        const existing = global.usersData?.get(key) ?? {};
        const merged = { ...clean(existing), ...patch };
        global.usersData?.set(key, { ...merged, _dirty: true, _lastSeen: Date.now() });
        // Optional host-provided persistence; clear the dirty flag only when it succeeded.
        if (typeof global.setUserData === "function") {
          try {
            await global.setUserData(key, merged);
            const cur = global.usersData?.get(key);
            if (cur) cur._dirty = false;
          } catch (e) {
            console.warn("[Users.setData] flush failed, kept dirty:", e?.message);
          }
        }
      }),
  };
}
function buildThreadsInterface() {
  return {
    getData: async (tid) => {
      const key = String(tid);
      if (global.threadsData?.has?.(key)) return global.threadsData.get(key);
      const banned = global._bannedGroups?.has(key) ?? false;
      return { banned };
    },
    setData: (tid, data) =>
      _threadLocks.run(String(tid), async () => {
        const key = String(tid);
        const patch = clean(data);
        if ("banned" in patch) {
          await setBan("group", key, !!patch.banned, patch.bannedBy ?? patch.unbannedBy);
        }
        if (global.threadsData) {
          const existing = global.threadsData.get(key) ?? {};
          global.threadsData.set(key, { ...existing, ...patch });
        }
      }),
  };
}
function buildCommandContext({
  api,
  event,
  args = [],
  role = 0,
  prefix = "",
  isGroupAdmin = false,
  cmdKey,
  signal,
}) {
  const { threadID } = event;
  const commandMessageID = event.messageID;
  const messageID = getReplyTargetID(event);
  const commandEvent =
    messageID !== commandMessageID ? { ...event, commandMessageID, messageID } : event;
  const isGroup = !!commandEvent.isGroup;
  return {
    api,
    event: commandEvent,
    args,
    role,
    isGroup,
    isDM: !isGroup,
    isGroupAdmin,
    signal,
    message: buildMessageAPI(api, threadID, messageID, cmdKey),
    prefix,
    usersData: global.usersData,
    globalData: global.globalData,
    db: global.db,
    Users: buildUsersInterface(),
    Threads: buildThreadsInterface(),
  };
}
export { buildMessageAPI, buildCommandContext, getReplyTargetID };
