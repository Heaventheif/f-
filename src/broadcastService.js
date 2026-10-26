"use strict";

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { ensurePostgresSchema } from "./utils/postgres.js";

// Render Free's application directory may be read-only. Prefer an explicit
// BROADCAST_DATA_DIR, then a writable TMPDIR, and finally /tmp.
const DATA_DIR = path.resolve(
  process.env.BROADCAST_DATA_DIR ||
  path.join(process.env.TMPDIR || "/tmp", "broadcast"),
);
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const STORE_FILE = path.join(DATA_DIR, "campaigns.json");
const MAX_FILE_BYTES = Math.max(1, Number.parseInt(process.env.BROADCAST_MAX_FILE_MB || "50", 10)) * 1024 * 1024;
const MAX_TOTAL_BYTES = Math.max(MAX_FILE_BYTES, Number.parseInt(process.env.BROADCAST_MAX_TOTAL_MB || "100", 10) * 1024 * 1024);
const MAX_TARGETS = Math.max(1, Number.parseInt(process.env.BROADCAST_MAX_TARGETS || "300", 10));
const POLL_MS = 1000;
// ── Pacing / safety (anti-spam) ───────────────────────────────────
// فاصل عشوائي بين الوجهات: إرسال المحتوى نفسه لمجموعات كثيرة بلا تأخير نمط سبام واضح.
const envInt = (name, def, min = 0) => {
  const n = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(n) && n >= min ? n : def;
};
const MIN_TARGET_DELAY_MS = envInt("BROADCAST_MIN_DELAY_MS", 8_000, 1_000);
const MAX_TARGET_DELAY_MS = Math.max(MIN_TARGET_DELAY_MS, envInt("BROADCAST_MAX_DELAY_MS", 20_000, 1_000));
const ITEM_DELAY_MIN_MS = 1_500;   // بين النص والمرفقات داخل نفس المجموعة
const ITEM_DELAY_MAX_MS = 4_000;
const MAX_PER_HOUR = envInt("BROADCAST_MAX_PER_HOUR", 120, 1); // وجهات/ساعة
const MAX_CONSECUTIVE_FAILURES = envInt("BROADCAST_MAX_CONSECUTIVE_FAILURES", 4, 1);
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

let store = { campaigns: [] };
let initialized = false;
let workerBusy = false;
let writeChain = Promise.resolve();

const nowIso = () => new Date().toISOString();
// المكتبة ترمي أحياناً كائنات مثل {error:"Timeout waiting for ACK"} وليس Error.
function errorText(e) {
  if (e == null) return "unknown error";
  if (typeof e === "string") return e;
  if (e.message) return String(e.message);
  if (e.error) return typeof e.error === "string" ? e.error : errorText(e.error);
  try { const j = JSON.stringify(e); if (j && j !== "{}") return j; } catch (_) {}
  return String(e);
}
const safeError = e => errorText(e).slice(0, 500);
// أخطاء قد يكون فيها الطرف الآخر قد استلم الرسالة (أو أعادت المكتبة الإرسال عبر HTTP).
const AMBIGUOUS_RE = /timed out|timeout|waiting for ack|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|network|aborted|mqtt/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
// نوم قابل للمقاطعة: يتوقف مبكراً عند إيقاف/إلغاء الحملة.
async function pacedSleep(ms, campaign) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!["running", "queued"].includes(campaign.status)) return;
    await sleep(Math.min(500, end - Date.now()));
  }
}

async function persist() {
  const snapshot = JSON.stringify(store, null, 2);
  // Serialize writes so an older snapshot cannot overwrite a newer one.
  const run = writeChain.catch(() => {}).then(async () => {
    const db = await ensurePostgresSchema();
    if (db) {
      await db.query(
        `INSERT INTO sunkenbot_broadcast_store (id, payload, updated_at) VALUES (1, $1::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
        [snapshot],
      );
    }
    // Neon is the durable source when configured. A local mirror is best-effort
    // in that case, so a read-only/ephemeral filesystem cannot break dashboard APIs.
    try {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${STORE_FILE}.${process.pid}.tmp`;
      await fs.writeFile(tmp, snapshot, "utf8");
      await fs.rename(tmp, STORE_FILE);
    } catch (e) {
      if (!db) throw e;
      console.warn("[BROADCAST] local mirror unavailable; PostgreSQL remains authoritative:", safeError(e));
    }
  });
  writeChain = run;
  return run;
}

function summarize(campaign) {
  const counts = { total: campaign.targets.length, pending: 0, processing: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 };
  for (const t of campaign.targets) counts[t.status] = (counts[t.status] || 0) + 1;
  const { files = [], targets = [], ...publicCampaign } = campaign;
  return {
    ...publicCampaign,
    files: files.map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size })),
    targets: targets.map(({ progress, ...target }) => target),
    counts,
  };
}

async function initStore() {
  if (initialized) return;
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  let loadedFromPostgres = false;
  try {
    const db = await ensurePostgresSchema();
    if (db) {
      const result = await db.query("SELECT payload FROM sunkenbot_broadcast_store WHERE id = 1");
      const parsed = result.rows?.[0]?.payload;
      if (parsed && Array.isArray(parsed.campaigns)) {
        store = parsed;
        loadedFromPostgres = true;
      }
    }
  } catch (e) {
    console.error("[BROADCAST] تعذر تحميل سجل الحملات من PostgreSQL:", safeError(e));
    // Do not silently start an empty campaign store if DATABASE_URL is configured.
    if (process.env.DATABASE_URL) throw e;
  }
  if (!loadedFromPostgres) {
    try {
      const parsed = JSON.parse(await fs.readFile(STORE_FILE, "utf8"));
      if (parsed && Array.isArray(parsed.campaigns)) store = parsed;
    } catch (e) {
      if (e.code !== "ENOENT") console.warn("[BROADCAST] تعذر قراءة السجل المحلي، سيبدأ سجل جديد:", safeError(e));
    }
  }
  // A process may have died after an external send began. Never silently resend
  // those targets: their result is ambiguous until an operator reviews them.
  let changed = false;
  for (const c of store.campaigns) {
    // On ephemeral Render Free storage, campaign metadata may survive in Neon
    // while uploaded files do not. Never automatically send a campaign with missing attachments.
    let missingAttachment = false;
    for (const file of c.files || []) {
      try { await fs.access(file.path); } catch { missingAttachment = true; }
    }
    if (missingAttachment && ["queued", "running"].includes(c.status)) {
      c.status = "paused";
      c.error = "توقفت الحملة لأن مرفقًا محليًا فُقد بعد إعادة تشغيل الاستضافة؛ أعد رفع الملفات وأنشئ حملة جديدة";
      c.updatedAt = nowIso();
      changed = true;
    }
    for (const t of c.targets || []) {
      if (t.status === "processing") {
        t.status = "unknown";
        t.error = "أعيد تشغيل الخادم أثناء محاولة الإرسال؛ النتيجة غير مؤكدة";
        t.updatedAt = nowIso();
        changed = true;
      }
    }
    if (c.status === "running" && c.targets.some(t => t.status === "pending")) {
      c.status = "queued";
      c.updatedAt = nowIso();
      changed = true;
    } else if (c.status === "running" && !c.targets.some(t => t.status === "pending")) {
      c.status = c.targets.some(t => t.status === "unknown") ? "review" : "completed";
      c.updatedAt = nowIso();
      changed = true;
    }
  }
  initialized = true;
  if (changed) await persist();
  setInterval(() => { runWorker().catch(e => console.error("[BROADCAST] worker:", safeError(e))); }, POLL_MS).unref();
  setInterval(() => { cleanupOldData().catch(e => console.warn("[BROADCAST] cleanup:", safeError(e))); }, 60 * 60 * 1000).unref();
  runWorker().catch(e => console.error("[BROADCAST] worker:", safeError(e)));
}

function getApi() {
  const api = global.botApi;
  if (!api) throw new Error("البوت غير متصل حالياً");
  return api;
}

// يُرجع سبب عدم الجاهزية (أو null). يُستعمل لإيقاف الحملة مؤقتاً بدل حرق كل الوجهات بالفشل.
function botUnhealthyReason() {
  const api = global.botApi;
  if (!api) return "البوت غير متصل";
  const h = api.__mqttManager?.health?.() || api.__mqttHealth;
  if (!h) return null;
  if (h.state === "AUTH_FAILED") return "الجلسة منتهية أو محجوبة (AUTH_FAILED)";
  if (h.cooldownUntil) return `الاتصال في فترة تهدئة حتى ${h.cooldownUntil}`;
  if (h.state === "STOPPED") return "اتصال MQTT متوقف";
  return null;
}

function normalizeThreadList(value) {
  if (Array.isArray(value)) return value;
  // Some FCA builds wrap thread results instead of returning the array directly.
  if (Array.isArray(value?.threads)) return value.threads;
  if (Array.isArray(value?.threadList)) return value.threadList;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function callThreadList(api) {
  return new Promise((resolve, reject) => {
    if (typeof api.getThreadList !== "function") return reject(new Error("مكتبة البوت لا توفر getThreadList"));
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error("انتهت مهلة جلب المجموعات من Facebook؛ تحقق من اتصال البوت")); }
    }, 30_000);
    const finish = (...args) => {
      if (settled) return;
      let [err, data] = args;
      // FCA forks differ: some callbacks use (err, data), others pass data only.
      if (args.length === 1) {
        if (err instanceof Error) data = undefined;
        else { data = err; err = null; }
      }
      settled = true;
      clearTimeout(timer);
      if (err) return reject(err instanceof Error ? err : new Error(errorText(err)));
      const list = normalizeThreadList(data);
      if (!list.length && data && typeof data === "object" && !Array.isArray(data)) {
        // An empty result is valid; preserve a concise diagnostic for unsupported shapes.
        console.warn("[BROADCAST] getThreadList returned an unrecognized result shape", Object.keys(data).slice(0, 12));
      }
      resolve(list);
    };
    try {
      const result = api.getThreadList(500, null, ["INBOX"], finish);
      if (result && typeof result.then === "function") result.then(data => finish(null, data), err => finish(err));
      else if (Array.isArray(result) || (result && (Array.isArray(result.threads) || Array.isArray(result.threadList) || Array.isArray(result.data)))) finish(null, result);
    } catch (e) { finish(e); }
  });
}

export async function listBroadcastGroups() {
  await initStore();
  const api = getApi();
  const threads = await callThreadList(api);
  const groups = threads
    .filter(t => {
      if (!t || !(t.threadID ?? t.threadId ?? t.id)) return false;
      const type = String(t.threadType ?? t.type ?? "").toUpperCase();
      const explicitGroup = t.isGroup === true || t.isGroupThread === true ||
        t.isGroup === 1 || type === "GROUP" || type === "GROUP_THREAD" || type === "MULTI";
      const participantCount = Array.isArray(t.participantIDs) ? t.participantIDs.length
        : Array.isArray(t.participants) ? t.participants.length
        : Array.isArray(t.participantIds) ? t.participantIds.length : 0;
      return explicitGroup || participantCount > 2;
    })
    .map(t => {
      const id = String(t.threadID ?? t.threadId ?? t.id);
      const participants = Array.isArray(t.participantIDs) ? t.participantIDs
        : Array.isArray(t.participants) ? t.participants
        : Array.isArray(t.participantIds) ? t.participantIds : null;
      return {
        id,
        name: String(t.name || t.threadName || t.thread_name || `مجموعة ${id}`),
        participantCount: participants ? participants.length : (t.participantCount ?? null),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "ar"));
  console.info(`[BROADCAST] group list loaded: ${groups.length} groups from ${threads.length} inbox threads`);
  if (threads.length > 0 && groups.length === 0) {
    console.warn("[BROADCAST] inbox threads were returned, but none matched known group markers");
  }
  return groups;
}

function safeFileName(name) {
  const base = path.basename(String(name || "attachment")).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 100);
  return base || "attachment";
}

export async function createBroadcastCampaign({ text = "", targetIds = [], files = [] }) {
  await initStore();
  const body = String(text || "").trim();
  if (body.length > 19_500) throw new Error("الحد الأقصى لطول النص 19500 حرف");
  const ids = [...new Set((Array.isArray(targetIds) ? targetIds : []).map(String).filter(Boolean))];
  if (!body && files.length === 0) throw new Error("أدخل رسالة أو ارفع ملفاً واحداً على الأقل");
  if (!ids.length) throw new Error("اختر مجموعة واحدة على الأقل");
  if (ids.length > MAX_TARGETS) throw new Error(`الحد الأقصى للوجهات هو ${MAX_TARGETS}`);
  let totalBytes = 0;
  for (const file of files) {
    if (!file || typeof file.arrayBuffer !== "function") throw new Error("ملف مرفق غير صالح");
    if (file.size <= 0) throw new Error(`الملف ${safeFileName(file.name)} فارغ`);
    if (file.size > MAX_FILE_BYTES) throw new Error(`الحد الأقصى لحجم الملف الواحد ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB`);
    totalBytes += file.size;
  }
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`الحد الأقصى لمجموع الملفات ${Math.floor(MAX_TOTAL_BYTES / 1024 / 1024)} MB`);

  // Validate requested IDs against the current group list, not arbitrary thread IDs.
  const groups = await listBroadcastGroups();
  const groupMap = new Map(groups.map(g => [g.id, g]));
  const invalid = ids.filter(id => !groupMap.has(id));
  if (invalid.length) throw new Error("بعض المجموعات لم تعد متاحة؛ حدّث القائمة ثم أعد الاختيار");

  const campaignId = randomUUID();
  const savedFiles = [];
  try {
    for (const file of files) {
      const originalName = safeFileName(file.name);
      const ext = path.extname(originalName).slice(0, 12);
      const storedName = `${randomUUID()}${ext}`;
      const storedPath = path.join(UPLOAD_DIR, storedName);
      // Bun.write ينسخ من الـ Blob مباشرة بدون نسخة Buffer إضافية في الذاكرة.
      if (typeof Bun !== "undefined" && typeof Bun.write === "function") await Bun.write(storedPath, file);
      else await fs.writeFile(storedPath, Buffer.from(await file.arrayBuffer()), { flag: "wx" });
      savedFiles.push({
        id: randomUUID(),
        name: originalName,
        storedName,
        path: storedPath,
        mimeType: String(file.type || "application/octet-stream").slice(0, 150),
        size: file.size,
      });
    }
  } catch (e) {
    await Promise.all(savedFiles.map(f => fs.rm(f.path, { recursive: true, force: true }).catch(() => {})));
    throw e;
  }

  const campaign = {
    id: campaignId,
    text: body,
    files: savedFiles,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    targets: ids.map(id => ({
      threadID: id,
      name: groupMap.get(id)?.name || id,
      status: "pending",
      attempts: 0,
      progress: { textSent: false, filesSent: [] },
      error: null,
      updatedAt: nowIso(),
    })),
  };
  store.campaigns.unshift(campaign);
  try { await persist(); }
  catch (e) {
    store.campaigns = store.campaigns.filter(c => c.id !== campaignId);
    await Promise.all(savedFiles.map(f => fs.rm(f.path, { recursive: true, force: true }).catch(() => {})));
    throw e;
  }
  runWorker().catch(e => console.error("[BROADCAST] worker:", safeError(e)));
  return summarize(campaign);
}

function sendMessage(api, body, threadID) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      const e = new Error("انتهت مهلة تأكيد إرسال النص؛ النتيجة غير مؤكدة");
      e.isTimeout = true;
      done(e);
    }, 65_000);
    const done = (err, info) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      err ? reject(err) : resolve(info);
    };
    try {
      const sender = global.safeSend;
      if (typeof sender !== "function") return done(new Error("دالة إرسال النص غير متاحة"));
      const result = sender(api, body, threadID, done);
      // Some callback-style FCA implementations return a fulfilled Promise
      // before the callback fires. Only reject from the Promise; success must
      // come from the callback so we do not mark an unconfirmed send as sent.
      if (result && typeof result.then === "function") result.then(() => {}, done);
    } catch (e) { done(e); }
  });
}

function sendMedia(api, file, threadID) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, info) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve(info);
    };
    try {
      if (typeof global.mediaSend !== "function") return reject(new Error("دالة إرسال المرفقات غير متاحة"));
      const stream = createReadStream(file.path);
      stream.once("error", done);
      const finish = (err, info) => { try { stream.destroy(); } catch (_) {} done(err, info); };
      const result = global.mediaSend(api, { attachment: stream }, threadID, finish);
      if (result && typeof result.then === "function") result.then(value => finish(null, value), finish);
    } catch (e) { done(e); }
  });
}

async function sendToTarget(campaign, target) {
  const api = getApi();
  target.progress ||= { textSent: false, filesSent: [] };
  target.progress.filesSent ||= [];

  // Persist each confirmed item. A later retry resumes at the first item that
  // is known not to have succeeded instead of resending already-confirmed text/files.
  if (campaign.text && !target.progress.textSent) {
    await sendMessage(api, campaign.text, target.threadID);
    target.progress.textSent = true;
    target.updatedAt = nowIso();
    await persist();
  }
  for (const file of campaign.files) {
    if (target.progress.filesSent.includes(file.id)) continue;
    if (target.progress.textSent || target.progress.filesSent.length) await sleep(rand(ITEM_DELAY_MIN_MS, ITEM_DELAY_MAX_MS));
    await sendMedia(api, file, target.threadID);
    target.progress.filesSent.push(file.id);
    target.updatedAt = nowIso();
    await persist();
  }
  return true;
}

function updateCampaignStatus(campaign) {
  const states = campaign.targets.map(t => t.status);
  if (campaign.status === "paused" || campaign.status === "cancelled") return;
  if (states.some(s => s === "pending" || s === "processing")) {
    campaign.status = "running";
  } else if (states.some(s => s === "unknown")) {
    campaign.status = "review";
  } else if (states.some(s => s === "failed")) {
    campaign.status = "completed_with_errors";
  } else if (states.every(s => s === "cancelled")) {
    campaign.status = "cancelled";
  } else {
    campaign.status = "completed";
  }
  campaign.updatedAt = nowIso();
}

const sentTimes = []; // طوابع آخر وجهات أُرسل إليها (لسقف الساعة)
function pruneSentTimes() {
  const cutoff = Date.now() - 3_600_000;
  while (sentTimes.length && sentTimes[0] < cutoff) sentTimes.shift();
}

function pauseCampaign(campaign, reason) {
  campaign.status = "paused";
  campaign.pauseReason = reason;
  campaign.updatedAt = nowIso();
  console.warn(`[BROADCAST] ⏸️ أُوقفت الحملة ${campaign.id} مؤقتاً: ${reason}`);
}

async function runWorker() {
  if (workerBusy || !initialized || !global.botApi) return;
  workerBusy = true;
  let consecutiveFailures = 0;
  let sentInThisRun = 0;
  try {
    while (true) {
      const campaign = store.campaigns.find(c => ["queued", "running"].includes(c.status) && c.targets.some(t => t.status === "pending"));
      if (!campaign) break;

      // قاطع الدوائر: لا نبدأ وجهة جديدة والجلسة غير سليمة.
      const unhealthy = botUnhealthyReason();
      if (unhealthy) { pauseCampaign(campaign, unhealthy); await persist(); break; }

      // سقف الساعة: ننتظر بدل الإرسال بسرعة.
      pruneSentTimes();
      if (sentTimes.length >= MAX_PER_HOUR) {
        campaign.status = "queued"; // يبقى جاهزاً؛ يُستأنف تلقائياً بعد انقضاء النافذة
        break;
      }

      if (campaign.status === "queued") { campaign.status = "running"; delete campaign.pauseReason; }
      const target = campaign.targets.find(t => t.status === "pending");
      if (!target) continue;

      // فاصل عشوائي بين الوجهات (ليس قبل أول وجهة في هذه الجولة).
      if (sentInThisRun > 0) {
        await pacedSleep(rand(MIN_TARGET_DELAY_MS, MAX_TARGET_DELAY_MS), campaign);
        if (!["running", "queued"].includes(campaign.status)) continue; // أُوقفت/أُلغيت أثناء الانتظار
      }

      target.status = "processing";
      target.attempts = (target.attempts || 0) + 1;
      target.updatedAt = nowIso();
      campaign.updatedAt = nowIso();
      await persist().catch(e => console.error("[BROADCAST] persist:", safeError(e)));
      sentInThisRun++;
      let outcome = "sent";
      try {
        await sendToTarget(campaign, target);
        target.status = "sent";
        target.error = null;
        sentTimes.push(Date.now());
        consecutiveFailures = 0;
      } catch (e) {
        const message = safeError(e);
        // مهلة/انقطاع/ACK مفقود قد يعني أن الرسالة وصلت (والمكتبة قد تعيد الإرسال عبر HTTP).
        const ambiguous = e?.isTimeout || AMBIGUOUS_RE.test(message);
        target.status = ambiguous ? "unknown" : "failed";
        target.error = message;
        outcome = target.status;
        consecutiveFailures++;
        // تقدّم جزئي (أُرسل نص/ملفات قبل الفشل) يعني أن الاتصال يعمل؛ لا نعدّه إخفاقاً متتالياً.
        if (target.progress?.textSent || target.progress?.filesSent?.length) consecutiveFailures = 0;
      }
      target.updatedAt = nowIso();
      updateCampaignStatus(campaign);
      if (outcome !== "sent" && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && campaign.status === "running") {
        pauseCampaign(campaign, `${consecutiveFailures} إخفاقات متتالية؛ راجع الجلسة ثم استأنف`);
        consecutiveFailures = 0;
      }
      await persist().catch(e => console.error("[BROADCAST] persist:", safeError(e)));
      if (campaign.status === "paused") break;
    }
  } finally {
    workerBusy = false;
  }
}

export async function getBroadcastCampaign(id) {
  await initStore();
  const campaign = store.campaigns.find(c => c.id === id);
  return campaign ? summarize(campaign) : null;
}

export async function listBroadcastCampaigns() {
  await initStore();
  return store.campaigns.slice(0, 50).map(summarize);
}

export async function controlBroadcastCampaign(id, action) {
  await initStore();
  const campaign = store.campaigns.find(c => c.id === id);
  if (!campaign) throw new Error("الحملة غير موجودة");
  if (action === "pause") {
    if (!["queued", "running"].includes(campaign.status)) throw new Error("لا يمكن إيقاف هذه الحملة مؤقتاً في حالتها الحالية");
    campaign.status = "paused";
  } else if (action === "resume") {
    if (campaign.status !== "paused") throw new Error("الحملة ليست متوقفة مؤقتاً");
    campaign.status = "queued";
    delete campaign.pauseReason;
  } else if (action === "cancel") {
    if (["completed", "completed_with_errors", "cancelled"].includes(campaign.status)) throw new Error("الحملة منتهية بالفعل");
    campaign.status = "cancelled";
    for (const t of campaign.targets) if (t.status === "pending") t.status = "cancelled";
  } else if (action === "retry") {
    if (campaign.status === "cancelled") throw new Error("لا يمكن إعادة محاولة حملة ملغاة");
    const failed = campaign.targets.filter(t => t.status === "failed");
    if (!failed.length) throw new Error("لا توجد وجهات فاشلة واضحة لإعادة المحاولة");
    for (const t of failed) { t.status = "pending"; t.error = null; t.updatedAt = nowIso(); }
    campaign.status = "queued";
  } else {
    throw new Error("إجراء غير معروف");
  }
  campaign.updatedAt = nowIso();
  await persist();
  runWorker().catch(e => console.error("[BROADCAST] worker:", safeError(e)));
  return summarize(campaign);
}

async function cleanupOldData() {
  if (!initialized) return;
  const cutoff = Date.now() - RETENTION_MS;
  const keep = [];
  for (const c of store.campaigns) {
    const terminal = ["completed", "completed_with_errors", "cancelled", "review"].includes(c.status);
    if (terminal && Date.parse(c.updatedAt || c.createdAt) < cutoff) {
      for (const f of c.files || []) await fs.rm(f.path, { recursive: true, force: true }).catch(() => {});
    } else keep.push(c);
  }
  if (keep.length !== store.campaigns.length) {
    store.campaigns = keep;
    await persist();
  }
}

export async function initializeBroadcast() {
  await initStore();
}

export function broadcastLimits() {
  return {
    maxFileBytes: MAX_FILE_BYTES,
    maxTotalBytes: MAX_TOTAL_BYTES,
    maxTargets: MAX_TARGETS,
  };
}
