"use strict";
// طبقة توافق بين SunkenBot ومكتبة bun-fca المدمجة (src/fca/bun-fca).
// bun-fca signature: unsendMessage(messageID, threadID, callback) — threadID إلزامي،
// بينما استدعاءات البوت القديمة تمرر callback فقط. هذا الملف يحافظ على التوافق.

const MAX_MSG_INDEX = 800;

function msgIndex() {
  global.__sunkenMsgThreadIndex ??= new Map();
  return global.__sunkenMsgThreadIndex;
}

function rememberMessage(messageID, threadID) {
  if (messageID == null || threadID == null) return;
  const index = msgIndex();
  const key = String(messageID);
  if (index.has(key)) return;
  index.set(key, String(threadID));
  if (index.size > MAX_MSG_INDEX) {
    index.delete(index.keys().next().value);
  }
}

function lookupThreadForMessage(messageID) {
  if (messageID == null) return null;
  return msgIndex().get(String(messageID)) ?? null;
}

function defineAlias(api, alias, getter) {
  if (Object.prototype.hasOwnProperty.call(api, alias)) return;
  Object.defineProperty(api, alias, { get: getter, enumerable: false, configurable: true });
}

export function adaptApi(api) {
  if (!api || api.__fcaCompatApplied) return api;

  defineAlias(api, "_ctx", () => api.ctx);
  defineAlias(api, "_defaultFuncs", () => api.defaultFuncs);

  if (typeof api.refreshFbDtsg !== "function" && typeof api.refreshFb_dtsg === "function") {
    api.refreshFbDtsg = (...args) => api.refreshFb_dtsg(...args);
  }

  // bun-fca sendMessage(msg, threadID, callback, replyTo) يعيد {threadID, messageID} —
  // نسجّل كل رسالة يرسلها البوت في فهرس messageID→threadID لاستخدامه عند unsend.
  if (typeof api.sendMessage === "function" && !api.__sendIndexWrapped) {
    const originalSend = api.sendMessage.bind(api);
    api.sendMessage = (body, threadID, callback, replyTo, isSingleUser) => {
      const record = info => {
        if (info && typeof info === "object") {
          rememberMessage(info.messageID ?? info.messageId, info.threadID ?? threadID);
        }
      };
      let ret;
      if (typeof callback === "function") {
        ret = originalSend(body, threadID, (err, info) => {
          if (!err) record(info);
          callback(err, info);
        }, replyTo, isSingleUser);
      } else {
        ret = originalSend(body, threadID, void 0, replyTo, isSingleUser);
        if (ret && typeof ret.then === "function") ret.then(record, () => {});
      }
      return ret;
    };
    api.__sendIndexWrapped = true;
  }

  // bun-fca يتطلب threadID عند unsend. ندعم الأشكال القديمة:
  // (messageID, cb) أو (messageID) أو (messageID, threadID, cb) أو (messageID, cb, extra).
  if (typeof api.unsendMessage === "function") {
    const original = api.unsendMessage.bind(api);
    api.unsendMessage = (messageID, second, third) => {
      let threadID = null;
      let cb = null;
      if (typeof second === "function") {
        cb = second;
      } else if (second != null && typeof second !== "function") {
        threadID = second;
        cb = typeof third === "function" ? third : null;
      } else {
        cb = typeof third === "function" ? third : null;
      }
      if (threadID == null) threadID = lookupThreadForMessage(messageID);
      if (threadID == null) {
        const err = new Error(`unsendMessage: threadID غير معروف للرسالة ${messageID} — مرر threadID صراحةً`);
        err.code = "UNSEND_THREAD_UNKNOWN";
        if (cb) { try { cb(err); } catch (_) {} }
        const rejected = Promise.reject(err);
        rejected.catch(() => {});
        return rejected;
      }
      const result = cb ? original(messageID, threadID, cb) : original(messageID, threadID);
      if (cb && result && typeof result.catch === "function") result.catch(() => {});
      return result;
    };
  }

  api.__fcaCompatApplied = true;
  return api;
}
