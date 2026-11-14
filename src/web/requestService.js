"use strict";
// Message-request management on top of fca-nx (global.botApi)

export class RequestError extends Error {
  constructor(message, status = 500, code = "INTERNAL") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const LIMITS = { maxLimit: 100, defaultLimit: 50, maxBulk: 25 };
const FOLDERS = { PENDING: "PENDING", OTHER: "OTHER", INBOX: "INBOX" };

function getApi(...methods) {
  const api = global.botApi;
  if (!api) throw new RequestError("البوت غير متصل", 503, "BOT_OFFLINE");
  for (const m of methods) {
    if (typeof api[m] !== "function") {
      throw new RequestError(`الواجهة ${m} غير مدعومة في نسخة المكتبة الحالية`, 501, "NOT_IMPLEMENTED");
    }
  }
  return api;
}

// Supports fca-nx's node callback and Promise forms, while settling only once.
function call(api, method, ...args) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cb = (err, res) => {
      if (done) return;
      done = true;
      err ? reject(err) : resolve(res);
    };
    try {
      const ret = api[method](...args, cb);
      if (ret && typeof ret.then === "function") ret.then(r => cb(null, r), e => cb(e || new Error("failed")));
    } catch (e) {
      cb(e);
    }
  });
}

function wrapFbError(e, ctx) {
  if (e instanceof RequestError) return e;
  console.error(`[REQUESTS:${ctx}]`, e?.stack || e?.message || e);
  return new RequestError("فشل الطلب من Facebook", 502, "UPSTREAM_ERROR");
}

export function validateId(id, label = "id") {
  const s = String(id ?? "");
  if (!/^\d{5,24}$/.test(s)) throw new RequestError(`${label} غير صالح`, 400, "INVALID_ID");
  return s;
}

export function parseLimit(v) {
  if (v === undefined || v === null || v === "") return LIMITS.defaultLimit;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxLimit) {
    throw new RequestError("limit يجب أن يكون بين 1 و100", 400, "INVALID_LIMIT");
  }
  return n;
}

export function parseFolder(v) {
  const f = FOLDERS[String(v ?? "PENDING").toUpperCase()];
  if (!f) throw new RequestError("folder غير صالح (PENDING|OTHER|INBOX)", 400, "INVALID_FOLDER");
  return f;
}

export function parseAction(v) {
  if (v !== "accept" && v !== "reject") throw new RequestError("action غير صالح", 400, "INVALID_ACTION");
  return v;
}

const str = (v, n = 200) => (v == null ? "" : String(v).slice(0, n));

function normThread(t, folder) {
  const isGroup = t.isGroup === true || Number(t.threadType) === 2;
  return {
    threadID: str(t.threadID, 30),
    name: str(t.name || t.threadName),
    isGroup,
    threadType: isGroup ? 2 : 1,
    folder,
    unreadCount: Number(t.unreadCount) || 0,
    participants: (Array.isArray(t.participants) ? t.participants : [])
      .slice(0, 50)
      .map(p => ({ userID: str(p?.userID ?? p?.id ?? p, 30), name: str(p?.name ?? p?.fullName) })),
    snippet: str(t.snippet, 200),
  };
}

export async function listMessages({ folder, limit } = {}) {
  const f = parseFolder(folder);
  const l = parseLimit(limit);
  const api = getApi("getThreadList");
  try {
    const list = await call(api, "getThreadList", l, null, [f]);
    const items = (Array.isArray(list) ? list : []).map(t => normThread(t, f)).filter(t => t.threadID);
    return { folder: f, items, count: items.length };
  } catch (e) {
    throw wrapFbError(e, "messages");
  }
}

export async function listRequests({ kind = "all", folder, limit } = {}) {
  if (!["all", "message"].includes(kind)) {
    throw new RequestError("kind غير صالح", 400, "INVALID_KIND");
  }
  return { ok: true, fetchedAt: new Date().toISOString(), messages: await listMessages({ folder, limit }) };
}

export async function handleMessage(threadId, action) {
  const id = validateId(threadId, "threadId");
  const a = parseAction(action);
  const api = getApi("handleMessageRequest");
  let isGroup = null;
  if (typeof api.getThreadInfo === "function") {
    try {
      const info = await call(api, "getThreadInfo", id);
      if (info) isGroup = info.isGroup === true || Number(info.threadType) === 2;
    } catch {} // classification is best-effort
  }
  try {
    await call(api, "handleMessageRequest", id, a === "accept");
    return { ok: true, kind: "message", action: a, threadID: id, isGroup, changed: true, refreshAvailable: true };
  } catch (e) {
    throw wrapFbError(e, "message");
  }
}

export async function bulk({ kind, action, ids }) {
  if (kind !== "message") throw new RequestError("kind غير صالح", 400, "INVALID_KIND");
  const a = parseAction(action);
  if (!Array.isArray(ids) || !ids.length) throw new RequestError("ids مطلوبة", 400, "INVALID_IDS");
  if (ids.length > LIMITS.maxBulk) throw new RequestError(`الحد الأقصى ${LIMITS.maxBulk} عنصرًا`, 400, "TOO_MANY_IDS");
  const clean = [...new Set(ids.map(i => validateId(i)))];
  const api = getApi("handleMessageRequest");
  const results = [];
  try {
    await call(api, "handleMessageRequest", clean, a === "accept");
    clean.forEach(id => results.push({ id, success: true }));
  } catch (e) {
    console.error("[REQUESTS:bulk]", e?.message || e);
    for (const id of clean) {
      try {
        await call(api, "handleMessageRequest", id, a === "accept");
        results.push({ id, success: true });
      } catch {
        results.push({ id, success: false, error: "فشلت العملية" });
      }
    }
  }
  const succeeded = results.filter(r => r.success).length;
  return { ok: true, kind, action: a, requested: clean.length, succeeded, failed: clean.length - succeeded, results };
}
