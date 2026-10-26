"use strict";
import { persistBanChange } from "../utils/banStore.js";

// ─── Message API ────────────────────────────────────────────────
function buildMessageAPI(api, threadID, messageID) {
  return {
    reply: (t, cb) => new Promise((resolve, reject) => {
      const settle = (err, info) => {
        // cb من المستدعي قد يرمي — لا نترك الـ Promise معلّقة
        if (cb) { try { cb(err, info); } catch (e) { console.error("[reply cb]", e?.message); } }
        if (err) reject(err);
        else resolve(info || {});
      };
      try {
        Promise.resolve(global.safeSend(api, t, threadID, settle, messageID)).catch(reject);
      } catch (e) {
        reject(e);
      }
    }),
    unsend: (msgID, tid) => {
      try { api.unsendMessage(msgID, tid || threadID, () => {}); } catch (_) {}
    },
    registerReply: (id, d, cb, senderID) => {
      global.Kagenou.replies[id] = {
        callback: cb,
        author: senderID,
        timestamp: Date.now(),
        ...d,
      };
    },
  };
}

function getReplyTargetID(event) {
  return event?.messageReply?.messageID || event?.messageID;
}

// ─── Users Interface ────────────────────────────────────────────
// واجهة موحَّدة لبيانات المستخدمين تعمل مع:
//   • global.usersData  (Map في الذاكرة — دائماً موجودة)
//   • global._bannedUsers  (يُحفظ دائماً عبر banStore: PostgreSQL أو ملف محلي)
// تتوافق مع: Users.getData(uid) / Users.setData(uid, obj)
function buildUsersInterface() {
  return {
    /**
     * جلب بيانات مستخدم — يُعيد الكائن أو {} إذا لم يوجد
     */
    getData: async (uid) => {
      const key = String(uid);
      // global.getUserData (إن عُرِّفت) تُعيد من الـ Map أولاً ثم من أي مصدر دائم
      if (typeof global.getUserData === "function") {
        try { return await global.getUserData(key); } catch (_) {}
      }
      return global.usersData?.get(key) ?? {};
    },

    /**
     * تحديث بيانات مستخدم — يدمج مع القيم الموجودة
     * يدعم حقل banned بشكل خاص: يحدِّث global._bannedUsers ويحفظه عبر banStore
     */
    setData: async (uid, data) => {
      const key = String(uid);

      // ─ تحديث الـ Map في الذاكرة ─
      const existing = global.usersData?.get(key) ?? {};
      const merged   = { ...existing, ...data };
      global.usersData?.set(key, { ...merged, _dirty: true });

      // ─ معالجة حقل banned بشكل خاص ─
      if ("banned" in data) {
        if (data.banned) {
          global._bannedUsers?.add(key);
        } else {
          global._bannedUsers?.delete(key);
        }
        await persistBanChange("user", key, !!data.banned, data.bannedBy ?? data.unbannedBy);
      }
    },
  };
}

// ─── Threads Interface ───────────────────────────────────────────
// واجهة موحَّدة لبيانات المجموعات تعمل مع:
//   • global.threadsData  (Map في الذاكرة — إن وُجدت)
//   • global._bannedGroups  (يُحفظ دائماً عبر banStore: PostgreSQL أو ملف محلي)
// تتوافق مع: Threads.getData(tid) / Threads.setData(tid, obj)
function buildThreadsInterface() {
  return {
    /**
     * جلب بيانات مجموعة — يُعيد الكائن أو {} إذا لم توجد
     */
    getData: async (tid) => {
      const key = String(tid);
      if (global.threadsData?.has?.(key)) return global.threadsData.get(key);
      // إذا لم توجد threadsData نُعيد كائناً يحتوي حالة الحظر على الأقل
      const banned = global._bannedGroups?.has(key) ?? false;
      return { banned };
    },

    /**
     * تحديث بيانات مجموعة — يدمج مع القيم الموجودة
     * يدعم حقل banned بشكل خاص: يحدِّث global._bannedGroups ويحفظه عبر banStore
     */
    setData: async (tid, data) => {
      const key = String(tid);

      // ─ تحديث الـ Map في الذاكرة (إن وُجدت) ─
      if (global.threadsData) {
        const existing = global.threadsData.get(key) ?? {};
        global.threadsData.set(key, { ...existing, ...data });
      }

      // ─ معالجة حقل banned بشكل خاص ─
      if ("banned" in data) {
        if (data.banned) {
          global._bannedGroups?.add(key);
        } else {
          global._bannedGroups?.delete(key);
        }
        await persistBanChange("group", key, !!data.banned, data.bannedBy ?? data.unbannedBy);
      }
    },
  };
}

// ─── Command Context ─────────────────────────────────────────────
function buildCommandContext({ api, event, args = [], role = 0, prefix = "", isGroupAdmin = false }) {
  const { threadID } = event;
  const commandMessageID = event.messageID;
  const messageID = getReplyTargetID(event);
  const commandEvent = messageID !== commandMessageID
    ? { ...event, commandMessageID, messageID }
    : event;
  const isGroup = !!commandEvent.isGroup;
  return {
    api,
    event: commandEvent,
    args,
    role,
    isGroup,
    isDM: !isGroup,
    isGroupAdmin,
    message: buildMessageAPI(api, threadID, messageID),
    prefix,
    usersData:  global.usersData,
    globalData: global.globalData,
    db:         global.db,
    Users:      buildUsersInterface(),    // ← إصلاح: كانت مفقودة
    Threads:    buildThreadsInterface(),  // ← إصلاح: كانت مفقودة
  };
}

export { buildMessageAPI, buildCommandContext, getReplyTargetID };
