"use strict";
// طبقة توافق بين SunkenBot ومكتبة bun-fca المدمجة (src/fca/bun-fca).
// bun-fca signature: unsendMessage(messageID, threadID, callback) — threadID إلزامي،
// بينما استدعاءات البوت القديمة تمرر callback فقط. هذا الملف يحافظ على التوافق.

const MAX_MSG_INDEX = 800;

import { getLastKnownGoodAppState, normalizeAppState } from "./appStatePersist.js";

// كوكيز الجلسة الحرجة التي يجب أن تبقى داخل jar الخاص بالـ api
const CRITICAL_JAR_COOKIES = ["c_user", "xs", "i_user"];

/**
 * إصلاح ذاتي: إذا فقد jar الخاص بـ bun-fca كوكيز الجلسة (c_user/xs) —
 * تُعاد حقنها من آخر حالة معروفة صالحة (الذاكرة/PostgreSQL) كي لا تفشل
 * طلبات HTTP (getThreadList وغيرها) بخطأ 1357001 "Facebook blocked the login".
 * تعيد قائمة أسماء الكوكيز التي تمت إعادتها.
 */
export function healSessionCookies(api) {
  try {
    const jar = api?.ctx?.jar;
    if (!jar || typeof jar.setCookieSync !== "function") return [];
    const current = typeof api.getAppState === "function" ? api.getAppState() : [];
    const have = new Set((Array.isArray(current) ? current : []).map(c => String(c?.key ?? c?.name ?? "")));
    const missing = CRITICAL_JAR_COOKIES.filter(k => !have.has(k));
    if (!missing.length) return [];
    const known = normalizeAppState(getLastKnownGoodAppState() || []);
    if (!known.length) return [];
    const healed = [];
    for (const name of missing) {
      const cookie = known.find(c => c.key === name);
      if (!cookie || !cookie.value) continue;
      try {
        jar.setCookieSync({
          key: cookie.key,
          value: cookie.value,
          domain: cookie.domain || ".facebook.com",
          path: cookie.path || "/",
          secure: cookie.secure !== false,
          httpOnly: !!cookie.httpOnly,
          expires: cookie.expires || "Infinity"
        }, "https://www.facebook.com");
        healed.push(name);
      } catch (_) {}
    }
    if (healed.length) {
      console.log(`[APPSTATE] 🔧 أُعيد حقن كوكيز الجلسة في jar: ${healed.join(", ")}`);
    }
    return healed;
  } catch (_) {
    return [];
  }
}

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
