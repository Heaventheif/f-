"use strict";
// Message-request management on top of fcanew (the bot api). Friend-request actions are
// intentionally NOT implemented: the library exposes no verified pending-request adapter.
import { AppError } from "../infra/errors.js";
import { redactText } from "../fca/runtimeEnv.js";

export class RequestError extends AppError {
  constructor(message, status = 500, code = "internal") {
    super(code, message, { status });
  }
}

export const LIMITS = { maxLimit: 100, defaultLimit: 50, maxBulk: 25 };
const FOLDERS = { PENDING: "PENDING", OTHER: "OTHER", INBOX: "INBOX" };
const KINDS = { all: "all", message: "messages", messages: "messages", friend: "friends", friends: "friends" };
const bad = (code, message) => new AppError(code, message, { status: 400 });

export function validateId(id, label = "id") {
  const s = String(id ?? "");
  if (!/^\d{5,24}$/.test(s)) throw bad("invalid_param", `${label} غير صالح`);
  return s;
}
export function parseLimit(v) {
  if (v === undefined || v === null || v === "") return LIMITS.defaultLimit;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.maxLimit) throw bad("invalid_param", "limit يجب أن يكون بين 1 و100");
  return n;
}
export function parseCursor(v) {
  if (v === undefined || v === null || v === "") return null;
  if (!/^\d{1,16}$/.test(String(v))) throw bad("invalid_param", "cursor غير صالح");
  return String(v);
}
export function parseFolder(v) {
  const f = FOLDERS[String(v ?? "PENDING").toUpperCase()];
  if (!f) throw bad("invalid_param", "folder غير صالح (PENDING|OTHER|INBOX)");
  return f;
}
export function parseAction(v) {
  if (v !== "accept" && v !== "reject") throw bad("invalid_param", "action غير صالح");
  return v;
}
export function parseKind(v) {
  const k = KINDS[String(v ?? "messages")];
  if (!k) throw bad("invalid_param", "kind غير صالح");
  return k;
}

const str = (v, n = 200) => (v == null ? "" : String(v).slice(0, n));
const safeText = (v, n = 200) => redactText(str(v, n));

function normFriend(u) {
  const id = str(u.userID ?? u.id, 30);
  const isFriend = !!u.isFriend;
  return {
    userID: id,
    name: safeText(u.fullName || u.name),
    isFriend,
    isPendingCandidate: !isFriend, // candidate only; getFriendsList is not an authoritative pending list
    profileUrl: str(u.profileUrl || (id ? `https://www.facebook.com/${id}` : ""), 500),
  };
}
function normThread(t, folder) {
  const isGroup = t.isGroup === true || Number(t.threadType) === 2;
  return {
    threadID: str(t.threadID, 30),
    name: safeText(t.name || t.threadName),
    isGroup,
    folder,
    unreadCount: Number(t.unreadCount) || 0,
    participantCount: Array.isArray(t.participants) ? t.participants.length : null,
    snippet: safeText(t.snippet),
    timestamp: t.timestamp != null ? String(t.timestamp) : null,
  };
}

export function createRequestService({
  getBot = () => global.botApi,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  timeoutMs = 30_000,
} = {}) {
  function getApi(...methods) {
    const api = getBot();
    if (!api) throw new AppError("bot_offline", "البوت غير متصل");
    for (const m of methods)
      if (typeof api[m] !== "function") throw new AppError("not_implemented", `الواجهة ${m} غير مدعومة في نسخة المكتبة الحالية`);
    return api;
  }

  // Supports node-callback and Promise forms, settles once, bounded by a timeout.
  function call(api, method, ...args) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => cb(new AppError("timeout", "انتهت مهلة Facebook", { retryable: true })), timeoutMs);
      const cb = (err, res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(res);
      };
      try {
        const ret = api[method](...args, cb);
        if (ret && typeof ret.then === "function") ret.then((r) => cb(null, r), (e) => cb(e || new Error("failed")));
      } catch (e) {
        cb(e);
      }
    });
  }
  function wrap(e, ctx) {
    if (e instanceof AppError) return e;
    console.error(`[REQUESTS:${ctx}]`, redactText(e?.stack || e?.message || e));
    return new AppError("upstream", "فشل الطلب من Facebook");
  }

  async function listFriends() {
    const api = getApi("getFriendsList");
    try {
      const list = await call(api, "getFriendsList");
      const items = (Array.isArray(list) ? list : []).map(normFriend).filter((f) => f.userID);
      const pendingCandidates = items.filter((f) => f.isPendingCandidate);
      return {
        items,
        count: items.length,
        pendingCandidates,
        pendingCandidateCount: pendingCandidates.length,
        warning: "getFriendsList لا يضمن أنها قائمة طلبات الصداقة المعلقة؛ إجراءات الصداقة معطّلة.",
      };
    } catch (e) {
      throw wrap(e, "friends");
    }
  }

  async function listMessages({ folder, limit, cursor } = {}) {
    const f = parseFolder(folder);
    const l = parseLimit(limit);
    const c = parseCursor(cursor);
    const api = getApi("getThreadList");
    try {
      const list = await call(api, "getThreadList", l, c, [f]);
      const items = (Array.isArray(list) ? list : []).map((t) => normThread(t, f)).filter((t) => t.threadID);
      const last = items[items.length - 1];
      return {
        folder: f,
        items,
        count: items.length,
        limit: l,
        nextCursor: items.length >= l && last?.timestamp ? last.timestamp : null,
      };
    } catch (e) {
      throw wrap(e, "messages");
    }
  }

  async function listRequests({ kind, folder, limit, cursor } = {}) {
    const k = parseKind(kind);
    const out = { fetchedAt: new Date().toISOString() };
    if (k === "all" || k === "messages") out.messages = await listMessages({ folder, limit, cursor });
    if (k === "all" || k === "friends") out.friends = await listFriends();
    return out;
  }

  // Which of `ids` currently sit in PENDING/OTHER (bounded paging). Acting on anything else is refused.
  async function findPending(ids) {
    const want = new Set(ids);
    const found = new Set();
    const api = getApi("getThreadList");
    for (const folder of ["PENDING", "OTHER"]) {
      let cursor = null;
      for (let page = 0; page < 5 && found.size < want.size; page++) {
        let list;
        try {
          list = await call(api, "getThreadList", LIMITS.maxLimit, cursor, [folder]);
        } catch (e) {
          throw wrap(e, "verify");
        }
        list = Array.isArray(list) ? list : [];
        for (const t of list) if (want.has(String(t.threadID))) found.add(String(t.threadID));
        const ts = list.length ? list[list.length - 1]?.timestamp : null;
        if (list.length < LIMITS.maxLimit || ts == null) break;
        cursor = String(ts);
      }
      if (found.size === want.size) break;
    }
    return found;
  }

  async function actOne(api, id, action) {
    try {
      await call(api, "handleMessageRequest", id, action === "accept");
    } catch (e) {
      throw wrap(e, "message");
    }
  }

  async function handleMessage(threadId, action) {
    const id = validateId(threadId, "threadId");
    const a = parseAction(action);
    const api = getApi("handleMessageRequest", "getThreadList");
    const found = await findPending([id]);
    if (!found.has(id)) throw new AppError("conflict", "الطلب غير موجود ضمن الطلبات المعلقة؛ حدّث القائمة", { status: 409 });
    await actOne(api, id, a);
    return { kind: "message", action: a, threadID: id, changed: true };
  }

  async function bulk({ kind, action, ids } = {}) {
    const k = parseKind(kind);
    if (k === "friends") throw new AppError("not_implemented", "إجراءات الصداقة معطّلة");
    if (k !== "messages") throw bad("invalid_param", "kind غير صالح");
    const a = parseAction(action);
    if (!Array.isArray(ids) || !ids.length) throw bad("invalid_param", "ids مطلوبة");
    if (ids.length > LIMITS.maxBulk) throw bad("invalid_param", `الحد الأقصى ${LIMITS.maxBulk} عنصرًا`);
    const clean = [...new Set(ids.map((i) => validateId(i)))];
    const api = getApi("handleMessageRequest", "getThreadList");
    const found = await findPending(clean);
    const results = [];
    let first = true;
    for (const id of clean) {
      if (!found.has(id)) {
        results.push({ id, success: false, error: "الطلب غير موجود ضمن الطلبات المعلقة" });
        continue;
      }
      if (!first) await sleep(150 + Math.floor(random() * 350)); // jitter between actions
      first = false;
      try {
        await actOne(api, id, a); // each id attempted exactly once: no retry of succeeded ids
        results.push({ id, success: true });
      } catch (e) {
        results.push({ id, success: false, error: redactText(String(e?.message || "فشلت العملية")).slice(0, 120) });
      }
    }
    const succeeded = results.filter((r) => r.success).length;
    return {
      ok: succeeded > 0,
      data: { kind: "message", action: a, requested: clean.length, succeeded, failed: clean.length - succeeded, results },
    };
  }

  return { listFriends, listMessages, listRequests, handleMessage, bulk };
}
