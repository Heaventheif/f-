"use strict";
import fs from "node:fs";
// ── Conservative send pacing ─────────────────────────────────────
// Serialize per-thread sends and leave room for transient platform limits.
// This is a reliability guard, not a mechanism to evade platform enforcement.
const MIN_SEND_GAP_MS      = 1_500;
const PRIORITY_SEND_GAP_MS =   800;
const JITTER_RANGE_MS      =   400; // ±200 ms applied to every outgoing message
const configuredSendTimeout = Number.parseInt(process.env.FB_SEND_TIMEOUT_MS || "", 10);
const SEND_TIMEOUT_MS = Number.isSafeInteger(configuredSendTimeout) && configuredSendTimeout > 0
  ? Math.min(configuredSendTimeout, 300_000) : 60_000;
function sendWithTimeout(startSend) {
  let timer;
  const sendPromise = Promise.resolve().then(startSend);
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Facebook sendMessage timed out after ${SEND_TIMEOUT_MS}ms`)), SEND_TIMEOUT_MS);
  });
  return Promise.race([sendPromise, timeoutPromise]).finally(() => clearTimeout(timer));
}
const _threadGates = new Map();
function _gate(key, gapMs) {
  let gate = _threadGates.get(key);
  if (!gate) {
    gate = { promise: Promise.resolve(), lastSendAt: 0 };
    _threadGates.set(key, gate);
  }
  return gate;
}
const MAX_FB_MSG_LEN = 19_500; // Facebook hard-limit ~20 000; keep margin

/**
 * Split a long string into chunks ≤ MAX_FB_MSG_LEN characters.
 * Tries to break at the last newline within the window to avoid mid-word cuts.
 */
function splitMessage(text) {
  if (text.length <= MAX_FB_MSG_LEN) return [text];
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = start + MAX_FB_MSG_LEN;
    if (end < text.length) {
      // Prefer splitting at the last newline in the window
      const lastNl = text.lastIndexOf("\n", end);
      if (lastNl > start) end = lastNl + 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

function gatedSend(api, body, threadID, callback, messageID) {
  // Auto-split messages that exceed Facebook's character limit.
  // Only applies to plain-text bodies; objects with attachments pass through.
  if (typeof body === "string" && body.length > MAX_FB_MSG_LEN) {
    const parts = splitMessage(body);
    console.warn(`[SEND] ⚠️ رسالة طويلة (${body.length} حرف) — تُقسَّم إلى ${parts.length} جزء.`);
    // Send all parts sequentially; only attach the callback to the last one.
    // فشل جزء لا يوقف بقية الأجزاء؛ يُرمى أول خطأ في النهاية.
    return (async () => {
      let firstErr = null;
      let result;
      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        try {
          result = await _gatedSendRaw(api, parts[i], threadID, isLast ? callback : undefined, isLast ? messageID : undefined);
        } catch (e) {
          console.warn(`[SEND] ⚠️ فشل الجزء ${i + 1}/${parts.length}: ${e?.message}`);
          firstErr ??= e;
        }
      }
      if (firstErr) throw firstErr;
      return result;
    })();
  }
  return _gatedSendRaw(api, body, threadID, callback, messageID);
}
function _gatedSendRaw(api, body, threadID, callback, messageID) {
  const rawApi = api.__rawApi || api;
  const key    = String(threadID);
  const gate   = _gate(key, MIN_SEND_GAP_MS);
  const resultPromise = gate.promise.then(async () => {
    const _jitter = Math.floor(Math.random() * JITTER_RANGE_MS) - (JITTER_RANGE_MS >> 1);
    const wait = (MIN_SEND_GAP_MS + _jitter) - (Date.now() - gate.lastSendAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    gate.lastSendAt = Date.now();
    let result;
    try {
      result = await sendWithTimeout(() => messageID !== undefined
        ? rawApi.sendMessage(body, threadID, callback, messageID)
        : rawApi.sendMessage(body, threadID, callback));
    } catch (sendErr) {
      // On HTTP 429 / 405 back the gate off by 30–60 s so subsequent
      // messages in this thread don't pile on and worsen the rate-limit.
      const errMsg = String(sendErr?.message ?? sendErr ?? "");
      if (/429|405|rate.?limit|too many/i.test(errMsg)) {
        const backoffMs = 30_000 + Math.floor(Math.random() * 30_000);
        gate.lastSendAt = Date.now() + backoffMs;
        console.warn(`[SEND] ⚠️ rate-limited — cooldown ${Math.round(backoffMs / 1000)}s`);
      }
      throw sendErr;
    }
    return result;
  });
  gate.promise = resultPromise.catch(e => { console.error("[SEND] خطأ:", e.message); });
  return resultPromise;
}
function prioritySend(api, body, threadID, callback, messageID) {
  // [FIX P1] نُسلسل على gate.promise تماماً كـ gatedSend لمنع التداخل
  const rawApi = api.__rawApi || api;
  const key    = String(threadID);
  const gate   = _gate(key, PRIORITY_SEND_GAP_MS);
  const resultPromise = gate.promise.then(async () => {
    const _jitter = Math.floor(Math.random() * JITTER_RANGE_MS) - (JITTER_RANGE_MS >> 1);
    const wait = (PRIORITY_SEND_GAP_MS + _jitter) - (Date.now() - gate.lastSendAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    gate.lastSendAt = Date.now();
    const result = await sendWithTimeout(() => messageID !== undefined
      ? rawApi.sendMessage(body, threadID, callback, messageID)
      : rawApi.sendMessage(body, threadID, callback));
    return result;
  });
  // الطابور يكمل حتى لو فشلت عملية بالأولوية (لا يُجمّد السلسلة)
  gate.promise = resultPromise.catch(e => { console.error("[PRIORITY_SEND] خطأ:", e.message); });
  return resultPromise;
}
// ── Media send lane ──────────────────────────────────────────────
// إرسال الوسائط فوراً بلا انتظار في بوابة الخيط، فلا يتأخر الملف خلف رسائل
// أخرى ولا تتأخر الرسائل خلف رفع الملف.
//  - النتيجة تأتي من الـ callback فقط؛ الـ Promise المُرجَع من المكتبة نستعمله للأخطاء.
//  - مهلة الإرسال تُحوَّل إلى callback(err) ولا تتحول إلى unhandledRejection.
//  - MEDIA_GAP_MS (افتراضي 0) فاصل اختياري بين رفعتين في نفس المجموعة.
const MEDIA_GAP_MS = Math.max(0, Number.parseInt(process.env.MEDIA_GAP_MS || "", 10) || 0);

function mediaSend(api, body, threadID, callback, messageID) {
  const rawApi = api.__rawApi || api;
  const gate   = _gate(String(threadID), PRIORITY_SEND_GAP_MS);
  let wait = 0;
  if (MEDIA_GAP_MS > 0) {
    const startAt = Math.max(Date.now(), gate.mediaNextAt || 0);
    gate.mediaNextAt = startAt + MEDIA_GAP_MS;
    wait = startAt - Date.now();
  }
  const p = new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const finish = (err, info) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err && /429|405|rate.?limit|too many/i.test(String(err?.message ?? err))) {
        gate.lastSendAt = Date.now() + 30_000;
        console.warn("[MEDIA_SEND] ⚠️ rate-limited");
      }
      if (typeof callback === "function") { try { callback(err, info); } catch (_) {} }
      err ? reject(err) : resolve(info);
    };
    timer = setTimeout(() => {
      const e = new Error(`Facebook sendMessage timed out after ${SEND_TIMEOUT_MS}ms`);
      e.isTimeout = true;
      finish(e);
    }, SEND_TIMEOUT_MS);
    const run = () => {
      if (done) return;
      try {
        const ret = messageID !== undefined
          ? rawApi.sendMessage(body, threadID, finish, messageID)
          : rawApi.sendMessage(body, threadID, finish);
        if (ret && typeof ret.then === "function") ret.then(() => {}, err => finish(err));
      } catch (e) { finish(e); }
    };
    if (wait > 0) setTimeout(run, wait); else run();
  });
  p.catch(() => {}); // الاستهلاك عبر callback؛ لا نريد unhandledRejection
  return p;
}

// إرسال ملف مع إعادة محاولة واحدة عند فشل الرفع (مثل: returned no metadata/ids).
// لا نعيد المحاولة عند المهلة (timeout) لتفادي إرسال الملف مرتين إن كان قد وصل.
async function mediaSendFile(api, filePath, threadID, messageID, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await mediaSend(api, { attachment: fs.createReadStream(filePath) }, threadID, undefined, messageID);
      return;
    } catch (e) {
      lastErr = e;
      if (e?.isTimeout || i + 1 >= attempts) break;
      console.warn(`[MEDIA_SEND] ⚠️ فشل الرفع (${String(e?.message ?? e).slice(0, 80)}) — إعادة محاولة`);
      await new Promise(r => setTimeout(r, 700));
    }
  }
  throw lastErr;
}
function cleanupIdleThreadGates() {
  const now     = Date.now();
  let   removed = 0;
  for (const [tid, g] of _threadGates.entries()) {
    if (now - g.lastSendAt > 30 * 60 * 1000) { _threadGates.delete(tid); removed++; }
  }
  return removed;
}
const _wrappedApiCache = new WeakMap();
function wrapApiForSafety(api) {
  if (_wrappedApiCache.has(api)) return _wrappedApiCache.get(api);
  const wrapped = Object.create(api);
  wrapped.__rawApi     = api;
  wrapped.sendMessage  = (body, threadID, callback, messageID) =>
    global.safeSend(api, body, threadID, callback, messageID);
  _wrappedApiCache.set(api, wrapped);
  return wrapped;
}
global.safeSend              = gatedSend;
global.prioritySend          = prioritySend;
global.mediaSend             = mediaSend;
global.mediaSendFile         = mediaSendFile;
global.wrapApiForSafety      = wrapApiForSafety;
global.cleanupIdleThreadGates = cleanupIdleThreadGates;

async function directSend(api, threadID, messageBody, replyToID = undefined) {
  try {
    await global.safeSend(api, messageBody, threadID, undefined, replyToID);
    return true;
  } catch (e) {
    console.error("[DIRECT_SEND] خطأ:", e?.message?.substring(0, 120));
    return false;
  }
}
const PART_RETRY_ATTEMPTS = 3;
const PART_RETRY_DELAY_MS = 1500;
async function directSendParts(api, threadID, title, streams, replyToID = undefined) {
  const total = streams.length;
  let sent = 0;
  const failedParts = [];
  for (let i = 0; i < total; i++) {
    const stream = streams[i]?.stream ?? streams[i];
    let ok = false;
    for (let attempt = 1; attempt <= PART_RETRY_ATTEMPTS && !ok; attempt++) {
      const attemptStream = (attempt > 1 && typeof streams[i]?.reopen === "function")
        ? streams[i].reopen()
        : stream;
      ok = await directSend(api, threadID, { attachment: attemptStream }, replyToID);
      if (!ok && attempt < PART_RETRY_ATTEMPTS) {
        console.warn(`[DIRECT_SEND] إعادة محاولة الجزء ${i + 1}/${total} (محاولة ${attempt + 1}/${PART_RETRY_ATTEMPTS})`);
        await new Promise(r => setTimeout(r, PART_RETRY_DELAY_MS * attempt));
      }
    }
    if (ok) {
      sent++;
    } else {
      failedParts.push(i + 1);
      console.warn(`[DIRECT_SEND] فشل إرسال الجزء ${i + 1}/${total} نهائياً بعد ${PART_RETRY_ATTEMPTS} محاولات`);
    }
  }
  if (failedParts.length > 0) {
    const note = `⚠️ فشل إرسال ${failedParts.length} من ${total} جزء (الأجزاء: ${failedParts.join(", ")}) — ${title || ""}`.trim();
    await directSend(api, threadID, note, replyToID).catch(() => {});
  }
  return { sent, failedParts, total };
}

// Auto-schedule cleanup every 30 min — prevents _threadGates from growing
// unbounded when the bot is in many groups over a long uptime period.
// BUG-04 FIX: .unref() يسمح بالخروج الطبيعي عند SIGTERM دون انتظار هذا المؤقت
setInterval(() => {
  const removed = cleanupIdleThreadGates();
  if (removed > 0) console.log(`[SEND] 🧹 أُزيل ${removed} gate خامل من الذاكرة.`);
}, 30 * 60 * 1000).unref();

export { gatedSend, prioritySend, mediaSend, mediaSendFile, wrapApiForSafety, cleanupIdleThreadGates, directSend, directSendParts };

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-utils-send',
  meta: { category: 'utils', path: 'src/utils/send.js' },
  setup(_ctx) {
    // Provides shared text, priority, media, and multipart send helpers.
  },
};
