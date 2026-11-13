"use strict";
import fs from "node:fs";

const MIN_SEND_GAP_MS = 1500;
const PRIORITY_SEND_GAP_MS = 800;
const JITTER_RANGE_MS = 400;
const posInt = (v, d, max) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : d;
};
const SEND_TIMEOUT_MS = posInt(process.env.FB_SEND_TIMEOUT_MS, 6e4, 3e5);
const MEDIA_TIMEOUT_MS = posInt(
  process.env.FB_MEDIA_TIMEOUT_MS,
  Math.max(SEND_TIMEOUT_MS, 18e4),
  6e5,
);
const MEDIA_GAP_MS = Math.max(0, Number.parseInt(process.env.MEDIA_GAP_MS || "", 10) || 0);
const MAX_FB_MSG_LEN = 19500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rate limiting is detected from structured fields only, never message text.
function isRateLimited(err) {
  if (!err || typeof err !== "object") return false;
  const codes = [err.status, err.statusCode, err.code, err.error];
  return codes.some((c) => c === 429 || c === "429" || c === 405 || c === "rate_limited");
}

// Pure: ms to wait before the next send on a gate honoring its gap (+jitter) and backoff.
export function computeWait({ now, lastSendAt = 0, gapMs, jitter = 0, blockedUntil = 0 }) {
  return Math.max(0, gapMs + jitter - (now - lastSendAt), blockedUntil - now);
}

// ONE FIFO per thread shared by text and media sends.
const _threadGates = new Map();
function _gate(key, gapMs) {
  let gate = _threadGates.get(key);
  if (!gate) {
    gate = { tail: Promise.resolve(), lastSendAt: 0, blockedUntil: 0, pending: 0, touched: Date.now() };
    _threadGates.set(key, gate);
  }
  if (gapMs !== undefined) gate.gapMs = gapMs;
  return gate;
}
function enqueue(threadID, gapMs, task) {
  const gate = _gate(String(threadID), gapMs);
  gate.pending++;
  const run = gate.tail.then(async () => {
    const jitter = Math.floor(Math.random() * JITTER_RANGE_MS) - (JITTER_RANGE_MS >> 1);
    const wait = computeWait({ now: Date.now(), lastSendAt: gate.lastSendAt, gapMs, jitter, blockedUntil: gate.blockedUntil });
    if (wait > 0) await sleep(wait);
    gate.lastSendAt = Date.now();
    try {
      return await task();
    } catch (e) {
      if (isRateLimited(e)) {
        const backoff = 3e4 + Math.floor(Math.random() * 3e4);
        gate.blockedUntil = Date.now() + backoff;
        console.warn(`[SEND] ⚠️ rate-limited — cooldown ${Math.round(backoff / 1e3)}s`);
      }
      throw e;
    }
  });
  gate.tail = run.then(
    () => {},
    () => {},
  );
  run.then(
    () => settled(gate),
    () => settled(gate),
  );
  return run;
}
function settled(gate) {
  gate.pending--;
  gate.touched = Date.now();
}

// Pure: split on code-point boundaries (never between a surrogate pair), preferring newlines.
export function splitMessage(text, max = MAX_FB_MSG_LEN) {
  if (text.length <= max) return [text];
  const parts = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end - 1);
      if (nl > start) end = nl + 1;
      else {
        const c = text.charCodeAt(end - 1);
        if (c >= 0xd800 && c <= 0xdbff && end - 1 > start) end--;
      }
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

// One raw send: settles exactly once (callback / returned promise / timeout);
// `body` may be a factory evaluated lazily at send time.
function rawSend(rawApi, body, threadID, callback, messageID, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const finish = (err, info) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (typeof callback === "function") {
        try {
          callback(err || null, info);
        } catch (_) {}
      }
      err ? reject(err) : resolve(info);
    };
    timer = setTimeout(() => {
      const e = new Error(`Facebook sendMessage timed out after ${timeoutMs}ms`);
      e.isTimeout = true;
      finish(e);
    }, timeoutMs);
    try {
      const payload = typeof body === "function" ? body() : body;
      const ret =
        messageID !== void 0
          ? rawApi.sendMessage(payload, threadID, finish, messageID)
          : rawApi.sendMessage(payload, threadID, finish);
      if (ret && typeof ret.then === "function") ret.then((info) => finish(null, info), finish);
    } catch (e) {
      finish(e);
    }
  });
}
const rawOf = (api) => api.__rawApi || api;

function sendVia(gapMs, timeoutMs, api, body, threadID, callback, messageID) {
  return enqueue(threadID, gapMs, () => rawSend(rawOf(api), body, threadID, callback, messageID, timeoutMs));
}
function gatedSend(api, body, threadID, callback, messageID) {
  if (typeof body === "string" && body.length > MAX_FB_MSG_LEN) {
    const parts = splitMessage(body);
    console.warn(`[SEND] ⚠️ رسالة طويلة (${body.length} حرف) — تُقسَّم إلى ${parts.length} جزء.`);
    // Enqueue every part synchronously so the parts stay contiguous in the FIFO.
    const sends = parts.map((p, i) => {
      const last = i === parts.length - 1;
      return sendVia(MIN_SEND_GAP_MS, SEND_TIMEOUT_MS, api, p, threadID, last ? callback : void 0, last ? messageID : void 0);
    });
    const all = Promise.allSettled(sends).then((rs) => {
      const bad = rs.find((r) => r.status === "rejected");
      if (bad) throw bad.reason;
      return rs[rs.length - 1].value;
    });
    all.catch(() => {});
    return all;
  }
  return sendVia(MIN_SEND_GAP_MS, SEND_TIMEOUT_MS, api, body, threadID, callback, messageID);
}
function prioritySend(api, body, threadID, callback, messageID) {
  return sendVia(PRIORITY_SEND_GAP_MS, SEND_TIMEOUT_MS, api, body, threadID, callback, messageID);
}
function mediaSend(api, body, threadID, callback, messageID) {
  return sendVia(Math.max(PRIORITY_SEND_GAP_MS, MEDIA_GAP_MS), MEDIA_TIMEOUT_MS, api, body, threadID, callback, messageID);
}
async function mediaSendFile(api, filePath, threadID, messageID, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const opened = [];
    try {
      await fs.promises.stat(filePath);
      await mediaSend(
        api,
        () => {
          const s = fs.createReadStream(filePath);
          s.on("error", () => {});
          opened.push(s);
          return { attachment: s };
        },
        threadID,
        void 0,
        messageID,
      );
      return;
    } catch (e) {
      lastErr = e;
      if (e?.isTimeout || e?.code === "ENOENT" || i + 1 >= attempts) break;
      console.warn(`[MEDIA_SEND] ⚠️ فشل الرفع (${String(e?.message ?? e).slice(0, 80)}) — إعادة محاولة`);
      await sleep(700);
    } finally {
      for (const s of opened) s.destroy?.();
    }
  }
  throw lastErr;
}
// Gates with pending work (or recently used) are kept.
function cleanupIdleThreadGates(now = Date.now()) {
  let removed = 0;
  for (const [tid, g] of _threadGates) {
    if (g.pending > 0) continue;
    if (now - Math.max(g.lastSendAt, g.touched, g.blockedUntil) > 30 * 60 * 1e3) {
      _threadGates.delete(tid);
      removed++;
    }
  }
  return removed;
}
const _wrappedApiCache = new WeakMap();
function wrapApiForSafety(api) {
  if (!api || typeof api !== "object") return api;
  if (_wrappedApiCache.has(api)) return _wrappedApiCache.get(api);
  const wrapped = Object.create(api);
  wrapped.__rawApi = api;
  wrapped.sendMessage = (body, threadID, callback, messageID) =>
    global.safeSend(api, body, threadID, callback, messageID);
  _wrappedApiCache.set(api, wrapped);
  return wrapped;
}
global.safeSend = gatedSend;
global.prioritySend = prioritySend;
global.mediaSend = mediaSend;
global.mediaSendFile = mediaSendFile;
global.wrapApiForSafety = wrapApiForSafety;
global.cleanupIdleThreadGates = cleanupIdleThreadGates;

async function directSend(api, threadID, messageBody, replyToID = void 0) {
  try {
    await global.safeSend(api, messageBody, threadID, void 0, replyToID);
    return true;
  } catch (e) {
    console.error("[DIRECT_SEND] خطأ:", String(e?.message ?? e).substring(0, 120));
    return false;
  }
}
const PART_RETRY_ATTEMPTS = 3;
const PART_RETRY_DELAY_MS = 1500;
// Parts may be: a stream, {stream, reopen}, or a factory function / {open}. Streams are
// opened lazily per attempt and destroyed afterwards, so only one fd is open at a time.
function openPart(part, attempt) {
  if (typeof part === "function") return part();
  if (typeof part?.open === "function") return part.open();
  if (attempt > 1 && typeof part?.reopen === "function") return part.reopen();
  return part?.stream ?? part;
}
async function directSendParts(api, threadID, title, streams, replyToID = void 0) {
  const total = streams.length;
  let sent = 0;
  const failedParts = [];
  for (let i = 0; i < total; i++) {
    let ok = false;
    for (let attempt = 1; attempt <= PART_RETRY_ATTEMPTS && !ok; attempt++) {
      let stream;
      try {
        stream = openPart(streams[i], attempt);
        ok = await directSend(api, threadID, { attachment: stream }, replyToID);
      } catch (e) {
        console.warn(`[DIRECT_SEND] تعذر فتح الجزء ${i + 1}: ${e?.message}`);
      } finally {
        stream?.destroy?.();
      }
      if (!ok && attempt < PART_RETRY_ATTEMPTS) {
        console.warn(`[DIRECT_SEND] إعادة محاولة الجزء ${i + 1}/${total} (محاولة ${attempt + 1}/${PART_RETRY_ATTEMPTS})`);
        await sleep(PART_RETRY_DELAY_MS * attempt);
      }
    }
    if (ok) sent++;
    else {
      failedParts.push(i + 1);
      console.warn(`[DIRECT_SEND] فشل إرسال الجزء ${i + 1}/${total} نهائياً بعد ${PART_RETRY_ATTEMPTS} محاولات`);
    }
  }
  if (failedParts.length > 0) {
    const note =
      `⚠️ فشل إرسال ${failedParts.length} من ${total} جزء (الأجزاء: ${failedParts.join(", ")}) — ${title || ""}`.trim();
    await directSend(api, threadID, note, replyToID).catch(() => {});
  }
  return { sent, failedParts, total };
}
setInterval(
  () => {
    const removed = cleanupIdleThreadGates();
    if (removed > 0) console.log(`[SEND] 🧹 أُزيل ${removed} gate خامل من الذاكرة.`);
  },
  30 * 60 * 1e3,
).unref();
export {
  gatedSend,
  prioritySend,
  mediaSend,
  mediaSendFile,
  wrapApiForSafety,
  cleanupIdleThreadGates,
  directSend,
  directSendParts,
  isRateLimited,
  _gate,
};
