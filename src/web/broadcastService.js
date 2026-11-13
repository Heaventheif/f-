"use strict";
// Broadcast campaigns: per-campaign kv records (atomic update), a single paced worker whose
// pacing / hourly+daily caps are persisted, and a typed-error API. All side effects are injectable.
import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { AppError } from "../infra/errors.js";
import { KeyedMutex, SingleFlight } from "../infra/limiter.js";
import { redactText } from "../fca/runtimeEnv.js";
import { isBotOff } from "../utils/offState.js";

const TERMINAL = ["completed", "completed_with_errors", "cancelled"];
const ACTIVE = ["queued", "running"];
// Extension -> {mime prefix(es), per-file byte cap or null for the global cap}
const MB = 1024 * 1024;
export const UPLOAD_TYPES = {
  jpg: { mime: ["image/"], max: 10 * MB }, jpeg: { mime: ["image/"], max: 10 * MB },
  png: { mime: ["image/"], max: 10 * MB }, gif: { mime: ["image/"], max: 10 * MB },
  webp: { mime: ["image/"], max: 10 * MB },
  mp4: { mime: ["video/"] }, mov: { mime: ["video/"] }, webm: { mime: ["video/"] }, "3gp": { mime: ["video/"] },
  mp3: { mime: ["audio/"] }, m4a: { mime: ["audio/"] }, aac: { mime: ["audio/"] },
  ogg: { mime: ["audio/", "video/ogg"] }, wav: { mime: ["audio/"] }, opus: { mime: ["audio/"] },
  pdf: { mime: ["application/pdf"], max: 25 * MB },
};
const MAX_FILES = 10;
const MAX_TEXT = 19500;
const AMBIGUOUS_RE = /timed out|timeout|waiting for ack|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|network|aborted|mqtt/i;

const errorText = (e) => {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e;
  if (e.message) return String(e.message);
  if (e.error) return typeof e.error === "string" ? e.error : errorText(e.error);
  try { const j = JSON.stringify(e); if (j && j !== "{}") return j; } catch (_) {}
  return String(e);
};
export const safeError = (e) => redactText(errorText(e)).slice(0, 500);

// Ambiguous = the message may or may not have been delivered. Codes first; the message
// regex is only a fallback for untyped errors coming from the third-party library.
export function isAmbiguous(e) {
  if (e?.code === "timeout" || e?.isTimeout) return true;
  if (e instanceof AppError) return false;
  if (/^(ECONNRESET|ETIMEDOUT|EPIPE|ECONNABORTED|UND_ERR)/.test(String(e?.code || ""))) return true;
  return AMBIGUOUS_RE.test(errorText(e));
}

// Pure state transition for a campaign after a target changes.
export function settle(c, nowIso) {
  if (c.status === "paused" || c.status === "cancelled") return;
  const s = c.targets.map((t) => t.status);
  if (s.some((x) => x === "pending" || x === "processing")) c.status = ACTIVE.includes(c.status) ? c.status : "running";
  else if (s.some((x) => x === "unknown")) c.status = "review";
  else if (s.some((x) => x === "failed")) c.status = "completed_with_errors";
  else if (s.every((x) => x === "cancelled")) c.status = "cancelled";
  else c.status = "completed";
  c.updatedAt = nowIso;
}

export function summarize(campaign) {
  const counts = { total: campaign.targets.length, pending: 0, processing: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 };
  for (const t of campaign.targets) counts[t.status] = (counts[t.status] || 0) + 1;
  const { files = [], targets = [], consecutiveFailures, ...pub } = campaign;
  return {
    ...pub,
    files: files.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
    targets: targets.map(({ progress, ...t }) => t),
    counts,
  };
}

const envInt = (env, name, def, min = 0) => {
  const n = Number.parseInt(env[name] || "", 10);
  return Number.isFinite(n) && n >= min ? n : def;
};
const safeFileName = (name) =>
  path.basename(String(name || "attachment")).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 100) || "attachment";

export function createBroadcastService({
  store,
  getBot = () => global.botApi,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  sendText = (api, body, threadID, cb) => {
    if (typeof global.safeSend !== "function") return cb(new AppError("unavailable", "دالة إرسال النص غير متاحة"));
    return global.safeSend(api, body, threadID, cb);
  },
  sendMediaFile = (api, file, threadID, cb) => {
    if (typeof global.mediaSend !== "function") return cb(new AppError("unavailable", "دالة إرسال المرفقات غير متاحة"));
    const stream = createReadStream(file.path);
    stream.once("error", cb);
    const r = global.mediaSend(api, { attachment: stream }, threadID, (...a) => { stream.destroy(); cb(...a); });
    return r;
  },
  isOff = isBotOff,
  env = process.env,
  dataDir,
  log = console,
  timeouts = { text: 65_000, media: 65_000, groups: 30_000 },
} = {}) {
  const stateDir = env.STATE_DIR || path.join(process.cwd(), "data");
  const DATA_DIR = path.resolve(dataDir || env.BROADCAST_DATA_DIR || path.join(stateDir, "broadcast"));
  const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
  const ephemeral = !dataDir && !env.BROADCAST_DATA_DIR && !env.STATE_DIR;
  const MAX_FILE = envInt(env, "BROADCAST_MAX_FILE_MB", 50, 1) * MB;
  const MAX_TOTAL = Math.max(MAX_FILE, envInt(env, "BROADCAST_MAX_TOTAL_MB", 100, 1) * MB);
  const MAX_TARGETS = envInt(env, "BROADCAST_MAX_TARGETS", 300, 1);
  const MIN_DELAY = envInt(env, "BROADCAST_MIN_DELAY_MS", 8000, 1000);
  const MAX_DELAY = Math.max(MIN_DELAY, envInt(env, "BROADCAST_MAX_DELAY_MS", 20000, 1000));
  const ITEM_MIN = 1500, ITEM_MAX = 4000;
  const MAX_PER_HOUR = envInt(env, "BROADCAST_MAX_PER_HOUR", 60, 1);
  const MAX_PER_DAY = envInt(env, "BROADCAST_MAX_PER_DAY", 500, 1);
  const MAX_CONSEC = envInt(env, "BROADCAST_MAX_CONSECUTIVE_FAILURES", 4, 1);
  const RETENTION_MS = 7 * 24 * 3600_000;
  const LEASE_MS = 60_000;
  const GROUP_TTL = 30_000;

  const campaigns = store.ns("broadcast_campaigns", { now });
  const metaNs = store.ns("broadcast_meta", { now });
  const idemNs = store.ns("broadcast_idem", { ttlMs: 24 * 3600_000, now });
  const cache = new Map();
  const mutex = new KeyedMutex();
  const flight = new SingleFlight();
  const owner = randomUUID();
  const iso = () => new Date(now()).toISOString();
  const rand = (a, b) => a + Math.floor(random() * (b - a + 1));
  let initPromise = null;
  let workerBusy = false;
  let leaseUntil = 0;
  let timers = [];
  let groupCache = { at: 0, groups: null };

  // ---------- persistence ----------
  async function mutate(id, fn) {
    const next = await campaigns.update(id, (cur) => {
      if (!cur) throw new AppError("not_found", "الحملة غير موجودة");
      fn(cur);
      cur.updatedAt = iso();
      return cur;
    });
    cache.set(id, next);
    return next;
  }
  const missingFiles = async (c) => {
    const out = [];
    for (const f of c.files || []) {
      try { await fs.access(f.path); } catch { out.push(f); }
    }
    return out;
  };
  // Missing attachments can never be sent: fail the pending targets with a typed reason.
  async function failForMissingFiles(id) {
    return mutate(id, (c) => {
      for (const t of c.targets) if (t.status === "pending") { t.status = "failed"; t.error = "file_missing"; t.updatedAt = iso(); }
      delete c.pauseReason; delete c.pauseCode; delete c.waitReason; delete c.waitUntil;
      if (c.status !== "cancelled") c.status = "running"; // settle() below picks the terminal status
      settle(c, iso());
    });
  }

  function init() {
    return (initPromise ||= initOnce().catch((e) => { initPromise = null; throw e; }));
  }
  async function initOnce() {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    if (ephemeral)
      log.warn("[BROADCAST] STATE_DIR/BROADCAST_DATA_DIR not set: uploads live under ./data and may be lost on redeploy");
    for (const [id, c] of await campaigns.list()) cache.set(id, c);
    for (const id of [...cache.keys()]) {
      const c = cache.get(id);
      const stale = c.targets.some((t) => t.status === "processing") || c.status === "running";
      if (stale) {
        await mutate(id, (x) => {
          for (const t of x.targets)
            if (t.status === "processing") { t.status = "unknown"; t.error = "restart_during_send"; t.updatedAt = iso(); }
          if (x.status === "running") x.status = x.targets.some((t) => t.status === "pending") ? "queued" : "running";
          settle(x, iso());
        });
      }
      if (ACTIVE.includes(cache.get(id).status) && (await missingFiles(cache.get(id))).length) await failForMissingFiles(id);
    }
    await sweepOrphans();
  }
  async function sweepOrphans() {
    const used = new Set([...cache.values()].flatMap((c) => (c.files || []).map((f) => f.storedName)));
    let n = 0;
    for (const name of await fs.readdir(UPLOAD_DIR).catch(() => [])) {
      if (used.has(name)) continue;
      const p = path.join(UPLOAD_DIR, name);
      const st = await fs.stat(p).catch(() => null);
      if (st && now() - st.mtimeMs > 60_000) { await fs.rm(p, { force: true, recursive: true }).catch(() => {}); n++; }
    }
    return n;
  }

  // ---------- groups ----------
  const threadList = (api, limit, ts) =>
    new Promise((resolve, reject) => {
      if (typeof api.getThreadList !== "function") return reject(new AppError("not_implemented", "مكتبة البوت لا توفر getThreadList"));
      let settled = false;
      const done = (err, data) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) return reject(err instanceof AppError ? err : new AppError("upstream", "تعذر جلب المجموعات من Facebook", { cause: err }));
        const list = Array.isArray(data) ? data : data?.threads || data?.threadList || data?.data || [];
        resolve(Array.isArray(list) ? list : []);
      };
      const timer = setTimeout(() => done(new AppError("timeout", "انتهت مهلة جلب المجموعات من Facebook")), timeouts.groups);
      try {
        const r = api.getThreadList(limit, ts, ["INBOX"], (err, data) => done(err, data));
        if (r && typeof r.then === "function") r.then((d) => done(null, d), (e) => done(e || new Error("failed")));
      } catch (e) { done(e); }
    });
  const participantsOf = (t) => (Array.isArray(t.participantIDs) ? t.participantIDs : Array.isArray(t.participants) ? t.participants : Array.isArray(t.participantIds) ? t.participantIds : null);
  const isGroupThread = (t) => {
    const type = String(t.threadType ?? t.type ?? "").toUpperCase();
    return (
      t.isGroup === true || t.isGroupThread === true || t.isGroup === 1 || Number(t.threadType) === 2 ||
      type === "GROUP" || type === "GROUP_THREAD" || type === "MULTI" || (participantsOf(t)?.length ?? 0) > 2
    );
  };
  async function fetchGroups() {
    const api = getBot();
    if (!api) throw new AppError("bot_offline", "البوت غير متصل حالياً");
    const PAGE = 500, seen = new Map();
    let ts = null;
    for (let page = 0; page < 5; page++) {
      const list = await threadList(api, PAGE, ts);
      let fresh = 0;
      for (const t of list) {
        const id = t && String(t.threadID ?? t.threadId ?? t.id ?? "");
        if (!id || seen.has(id)) continue;
        seen.set(id, t);
        fresh++;
      }
      const last = list[list.length - 1];
      if (list.length < PAGE || !fresh || last?.timestamp == null) break;
      ts = String(last.timestamp);
    }
    return [...seen].filter(([, t]) => isGroupThread(t)).map(([id, t]) => {
      const p = participantsOf(t);
      return {
        id,
        name: String(t.name || t.threadName || t.thread_name || `مجموعة ${id}`).slice(0, 200),
        participantCount: p ? p.length : (t.participantCount ?? null),
      };
    }).sort((a, b) => a.name.localeCompare(b.name, "ar"));
  }
  async function listGroups({ force = false } = {}) {
    if (!force && groupCache.groups && now() - groupCache.at < GROUP_TTL) return groupCache.groups;
    return flight.run("groups", async () => {
      const groups = await fetchGroups();
      groupCache = { at: now(), groups };
      return groups;
    });
  }

  // ---------- create ----------
  function validateFiles(files) {
    if (files.length > MAX_FILES) throw new AppError("bad_request", `الحد الأقصى ${MAX_FILES} ملفات`);
    let total = 0;
    for (const f of files) {
      if (!f || typeof f.arrayBuffer !== "function") throw new AppError("bad_request", "ملف مرفق غير صالح");
      const name = safeFileName(f.name);
      const ext = path.extname(name).slice(1).toLowerCase();
      const rule = UPLOAD_TYPES[ext];
      if (!rule) throw new AppError("unsupported_media", `نوع الملف ${name} غير مسموح`);
      const mime = String(f.type || "").toLowerCase();
      if (mime && mime !== "application/octet-stream" && !rule.mime.some((m) => mime.startsWith(m)))
        throw new AppError("unsupported_media", `نوع الملف ${name} لا يطابق امتداده`);
      if (!(f.size > 0)) throw new AppError("bad_request", `الملف ${name} فارغ`);
      const cap = Math.min(rule.max || MAX_FILE, MAX_FILE);
      if (f.size > cap) throw new AppError("payload_too_large", `الحد الأقصى لحجم ${name} هو ${Math.floor(cap / MB)} MB`);
      total += f.size;
    }
    if (total > MAX_TOTAL) throw new AppError("payload_too_large", `الحد الأقصى لمجموع الملفات ${Math.floor(MAX_TOTAL / MB)} MB`);
  }

  async function create({ text = "", targetIds = [], files = [], idempotencyKey } = {}) {
    await init();
    if (idempotencyKey !== undefined && !/^[\w.:-]{8,128}$/.test(String(idempotencyKey)))
      throw new AppError("bad_request", "Idempotency-Key غير صالح");
    const run = async () => {
      if (idempotencyKey) {
        const prev = await idemNs.get(idempotencyKey);
        if (prev && cache.has(prev)) return { campaign: summarize(cache.get(prev)), replay: true };
      }
      const body = String(text || "").trim();
      if (body.length > MAX_TEXT) throw new AppError("bad_request", `الحد الأقصى لطول النص ${MAX_TEXT} حرف`);
      if (!Array.isArray(targetIds)) throw new AppError("bad_request", "قائمة المجموعات غير صالحة");
      const ids = [...new Set(targetIds.map(String).filter(Boolean))];
      if (!body && !files.length) throw new AppError("bad_request", "أدخل رسالة أو ارفع ملفاً واحداً على الأقل");
      if (!ids.length) throw new AppError("bad_request", "اختر مجموعة واحدة على الأقل");
      if (ids.length > MAX_TARGETS) throw new AppError("bad_request", `الحد الأقصى للوجهات هو ${MAX_TARGETS}`);
      validateFiles(files);
      const groups = await listGroups();
      const map = new Map(groups.map((g) => [g.id, g]));
      if (ids.some((id) => !map.has(id))) throw new AppError("conflict", "بعض المجموعات لم تعد متاحة؛ حدّث القائمة ثم أعد الاختيار");
      const saved = [];
      try {
        for (const f of files) {
          const name = safeFileName(f.name);
          const storedName = `${randomUUID()}.${path.extname(name).slice(1).toLowerCase()}`;
          const p = path.join(UPLOAD_DIR, storedName);
          await fs.writeFile(p, Buffer.from(await f.arrayBuffer()), { flag: "wx", mode: 0o600 });
          saved.push({ id: randomUUID(), name, storedName, path: p, mimeType: String(f.type || "application/octet-stream").slice(0, 150), size: f.size });
        }
        const t = iso();
        const campaign = {
          id: randomUUID(), text: body, files: saved, status: "queued", createdAt: t, updatedAt: t, consecutiveFailures: 0,
          targets: ids.map((id) => ({ threadID: id, name: map.get(id).name, status: "pending", attempts: 0, progress: { textSent: false, filesSent: [] }, error: null, updatedAt: t })),
        };
        await campaigns.set(campaign.id, campaign);
        cache.set(campaign.id, campaign);
        if (idempotencyKey) await idemNs.set(idempotencyKey, campaign.id);
        return { campaign: summarize(campaign), replay: false };
      } catch (e) {
        await Promise.all(saved.map((f) => fs.rm(f.path, { force: true }).catch(() => {})));
        throw e;
      }
    };
    return idempotencyKey ? mutex.run(`idem:${idempotencyKey}`, run) : run();
  }

  // ---------- reads / controls ----------
  async function get(id) {
    await init();
    const c = cache.get(id);
    return c ? summarize(c) : null;
  }
  async function list({ limit = 50 } = {}) {
    await init();
    return [...cache.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, Math.min(100, limit)).map(summarize);
  }
  const conflict = (m) => new AppError("conflict", m, { status: 409 });
  async function control(id, action) {
    await init();
    if (!["pause", "resume", "cancel", "retry"].includes(action)) throw new AppError("bad_request", "إجراء غير معروف");
    if (action === "resume" && cache.get(id)?.status === "paused" && (await missingFiles(cache.get(id))).length) {
      await failForMissingFiles(id);
      return summarize(cache.get(id));
    }
    const c = await mutate(id, (x) => {
      if (action === "pause") {
        if (!ACTIVE.includes(x.status)) throw conflict("لا يمكن إيقاف هذه الحملة مؤقتاً في حالتها الحالية");
        x.status = "paused"; x.pauseCode = "manual"; x.pauseReason = "أوقفتها يدوياً"; delete x.waitReason;
      } else if (action === "resume") {
        if (x.status !== "paused") throw conflict("الحملة ليست متوقفة مؤقتاً");
        x.status = "queued"; x.consecutiveFailures = 0;
        delete x.pauseReason; delete x.pauseCode;
      } else if (action === "cancel") {
        if (TERMINAL.includes(x.status)) throw conflict("الحملة منتهية بالفعل");
        x.status = "cancelled"; delete x.waitReason;
        for (const t of x.targets) if (t.status === "pending") t.status = "cancelled";
      } else {
        if (x.status === "cancelled") throw conflict("لا يمكن إعادة محاولة حملة ملغاة");
        const failed = x.targets.filter((t) => t.status === "failed");
        if (!failed.length) throw conflict("لا توجد وجهات فاشلة لإعادة المحاولة");
        for (const t of failed) { t.status = "pending"; t.error = null; t.updatedAt = iso(); }
        // A manual pause must survive a retry.
        if (x.status !== "paused") x.status = "queued";
      }
    });
    return summarize(c);
  }
  // Operator decision for a target whose delivery is unconfirmed.
  async function controlTarget(id, threadID, action) {
    await init();
    if (action !== "resolve" && action !== "skip") throw new AppError("bad_request", "إجراء غير معروف");
    const c = await mutate(id, (x) => {
      const t = x.targets.find((y) => y.threadID === String(threadID));
      if (!t) throw new AppError("not_found", "الوجهة غير موجودة");
      if (t.status !== "unknown") throw conflict("الوجهة ليست في حالة نتيجة غير مؤكدة");
      t.status = action === "resolve" ? "sent" : "cancelled";
      t.resolvedManually = true;
      t.updatedAt = iso();
      settle(x, iso());
    });
    return summarize(c);
  }

  // ---------- worker ----------
  function unhealthy() {
    const api = getBot();
    if (!api) return { reason: "البوت غير متصل", code: null };
    const h = api.__mqttManager?.health?.() || api.__mqttHealth;
    if (!h) return null;
    if (h.state === "AUTH_FAILED") return { reason: "الجلسة منتهية أو محجوبة (AUTH_FAILED)", code: "auth_failed" };
    if (h.cooldownUntil) return { reason: `الاتصال في فترة تهدئة حتى ${h.cooldownUntil}`, code: null };
    if (h.state === "STOPPED") return { reason: "اتصال MQTT متوقف", code: null };
    return null;
  }
  // Auth failures resume automatically once the connection recovers.
  async function resumeAuthPaused() {
    for (const [id, c] of cache)
      if (c.status === "paused" && c.pauseCode === "auth_failed")
        await mutate(id, (x) => { x.status = "queued"; delete x.pauseCode; delete x.pauseReason; }).catch(() => {});
  }

  function callbackOnce(start, ms, { promiseResolves }) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err, info) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(info);
      };
      const timer = setTimeout(() => done(new AppError("timeout", "انتهت مهلة تأكيد الإرسال؛ النتيجة غير مؤكدة")), ms);
      try {
        const r = start(done);
        if (r && typeof r.then === "function") r.then((v) => (promiseResolves ? done(null, v) : undefined), done);
      } catch (e) { done(e); }
    });
  }
  const recordId = (t, info) => {
    const id = info?.messageID || info?.messageId || (typeof info === "string" ? info : null);
    if (id) { t.messageIDs ||= []; if (!t.messageIDs.includes(id)) t.messageIDs.push(id); }
  };
  const stopped = (id) => !ACTIVE.includes(cache.get(id)?.status);

  async function sendToTarget(id, threadID, api) {
    const snap = () => cache.get(id).targets.find((t) => t.threadID === threadID);
    const c0 = cache.get(id);
    if (c0.text && !snap().progress.textSent) {
      if (isOff(threadID)) throw new AppError("conflict", "المجموعة متوقفة مؤقتاً", { meta: { groupPaused: true } });
      const info = await callbackOnce((cb) => sendText(api, c0.text, threadID, cb), timeouts.text, { promiseResolves: false });
      await mutate(id, (x) => { const t = x.targets.find((y) => y.threadID === threadID); recordId(t, info); t.progress.textSent = true; t.updatedAt = iso(); });
    }
    for (const file of c0.files) {
      if (snap().progress.filesSent.includes(file.id)) continue;
      if (stopped(id)) throw new AppError("conflict", "توقفت الحملة", { meta: { campaignStopped: true } });
      const t = snap();
      if (t.progress.textSent || t.progress.filesSent.length) await sleep(rand(ITEM_MIN, ITEM_MAX));
      if (isOff(threadID)) throw new AppError("conflict", "المجموعة متوقفة مؤقتاً", { meta: { groupPaused: true } });
      const info = await callbackOnce((cb) => sendMediaFile(api, file, threadID, cb), timeouts.media, { promiseResolves: true });
      await mutate(id, (x) => { const y = x.targets.find((z) => z.threadID === threadID); recordId(y, info); y.progress.filesSent.push(file.id); y.updatedAt = iso(); });
    }
  }

  async function acquireLease() {
    const t = now();
    if (leaseUntil - t > LEASE_MS / 2) return true;
    const cur = await metaNs.update("lease", (l) => (l && l.owner !== owner && l.until > t ? l : { owner, until: t + LEASE_MS }), null);
    if (cur.owner === owner) { leaseUntil = cur.until; return true; }
    return false;
  }

  // One worker step: send to at most one target. Returns a short reason code (used by tests).
  async function tick() {
    await init();
    if (workerBusy) return "busy";
    workerBusy = true;
    try {
      if (!getBot()) return "no_bot";
      const cand = [...cache.values()]
        .filter((c) => ACTIVE.includes(c.status))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
        .find((c) => c.targets.some((t) => t.status === "pending" && !isOff(t.threadID)));
      if (!cand) {
        for (const c of cache.values())
          if (c.status === "running" && c.targets.some((t) => t.status === "pending")) await mutate(c.id, (x) => { x.status = "queued"; });
        return "idle";
      }
      if (!(await acquireLease())) return "not_leader";
      const bad = unhealthy();
      if (bad) {
        await mutate(cand.id, (x) => { x.status = "paused"; x.pauseReason = bad.reason; if (bad.code) x.pauseCode = bad.code; else delete x.pauseCode; });
        if (bad.code === "auth_failed") attachRecovery();
        return "unhealthy";
      }
      if ((await missingFiles(cand)).length) { await failForMissingFiles(cand.id); return "file_missing"; }
      const t0 = now();
      const meta = (await metaNs.get("meta")) || { nextAt: 0, sends: [] };
      meta.sends = (meta.sends || []).filter((x) => t0 - x < 86_400_000);
      const hour = meta.sends.filter((x) => t0 - x < 3_600_000);
      let cap = null;
      if (meta.sends.length >= MAX_PER_DAY) cap = { why: "daily_cap", until: meta.sends[0] + 86_400_000 };
      else if (hour.length >= MAX_PER_HOUR) cap = { why: "hourly_cap", until: hour[0] + 3_600_000 };
      if (cap) {
        if (cand.waitReason !== cap.why)
          await mutate(cand.id, (x) => { x.status = "queued"; x.waitReason = cap.why; x.waitUntil = new Date(cap.until).toISOString(); });
        return "capped";
      }
      if (t0 < meta.nextAt) return "wait";
      const target = cand.targets.find((t) => t.status === "pending" && !isOff(t.threadID));
      await mutate(cand.id, (x) => {
        x.status = "running"; delete x.waitReason; delete x.waitUntil;
        const t = x.targets.find((y) => y.threadID === target.threadID);
        t.status = "processing"; t.attempts = (t.attempts || 0) + 1; t.updatedAt = iso();
      });
      let outcome = "sent", error = null;
      try {
        await sendToTarget(cand.id, target.threadID, getBot());
      } catch (e) {
        if (e?.meta?.groupPaused || e?.meta?.campaignStopped) {
          await mutate(cand.id, (x) => {
            const t = x.targets.find((y) => y.threadID === target.threadID);
            t.status = x.status === "cancelled" ? "cancelled" : "pending";
            if (e.meta.groupPaused && ACTIVE.includes(x.status)) x.status = "queued";
          });
          return e.meta.groupPaused ? "group_paused" : "stopped";
        }
        error = safeError(e);
        outcome = isAmbiguous(e) ? "unknown" : "failed";
      }
      const t1 = now();
      if (outcome === "sent") meta.sends.push(t1);
      meta.nextAt = t1 + rand(MIN_DELAY, MAX_DELAY);
      meta.lastSendAt = t1;
      await metaNs.set("meta", meta);
      await mutate(cand.id, (x) => {
        const t = x.targets.find((y) => y.threadID === target.threadID);
        t.status = outcome; t.error = error; t.updatedAt = iso();
        const partial = t.progress?.textSent || t.progress?.filesSent?.length;
        x.consecutiveFailures = outcome === "sent" || partial ? 0 : (x.consecutiveFailures || 0) + 1;
        settle(x, iso());
        if (outcome !== "sent" && x.consecutiveFailures >= MAX_CONSEC && x.status === "running") {
          x.status = "paused"; x.pauseCode = "failures"; x.pauseReason = `${x.consecutiveFailures} إخفاقات متتالية؛ راجع الجلسة ثم استأنف`; x.consecutiveFailures = 0;
        }
      });
      return outcome;
    } finally {
      workerBusy = false;
    }
  }

  let recoveryFor = null;
  function attachRecovery() {
    const m = getBot()?.__mqttManager;
    if (!m?.on || recoveryFor === m) return;
    recoveryFor = m;
    m.on("ping_ok", () => { resumeAuthPaused().catch(() => {}); });
  }

  async function cleanup() {
    await init();
    const cutoff = now() - RETENTION_MS;
    const all = [...cache.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    for (const [i, c] of all.entries()) {
      const done = [...TERMINAL, "review"].includes(c.status);
      if (done && (Date.parse(c.updatedAt || c.createdAt) < cutoff || i >= 100)) {
        for (const f of c.files || []) await fs.rm(f.path, { force: true }).catch(() => {});
        await campaigns.del(c.id);
        cache.delete(c.id);
      }
    }
    await sweepOrphans();
  }

  // Idempotent: a second call never starts a second loop.
  function start() {
    if (timers.length) return;
    const t1 = setInterval(() => tick().catch((e) => log.error("[BROADCAST] worker:", safeError(e))), 1000);
    const t2 = setInterval(() => cleanup().catch((e) => log.warn("[BROADCAST] cleanup:", safeError(e))), 3600_000);
    t1.unref?.(); t2.unref?.();
    timers = [t1, t2];
    init().catch((e) => log.error("[BROADCAST] init:", safeError(e)));
  }
  function stop() { timers.forEach(clearInterval); timers = []; }

  const limits = () => ({
    maxFileBytes: MAX_FILE, maxTotalBytes: MAX_TOTAL, maxTargets: MAX_TARGETS, maxFiles: MAX_FILES,
    maxTextLength: MAX_TEXT, allowedExtensions: Object.keys(UPLOAD_TYPES), perHour: MAX_PER_HOUR, perDay: MAX_PER_DAY,
    ephemeralStorage: ephemeral,
  });

  return { init, start, stop, tick, listGroups, create, get, list, control, controlTarget, cleanup, limits, _cache: cache };
}
