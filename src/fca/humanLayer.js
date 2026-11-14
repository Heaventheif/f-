"use strict";
/**
 * humanLayer — طبقة السلوك البشري (anti-ban)
 * ─────────────────────────────────────────────
 * تجعل ردود البوت تبدو إنسانية عبر:
 *  1. مؤشر "يكتب الآن..." قبل الردود النصية بمدة تتناسب مع طول النص.
 *  2. إيصالات قراءة متأخرة (لا تُقرأ الرسالة لحظة وصولها).
 *  3. إيقاع إرسال لكل محادثة: ميزانية رسائل/10 دقائق مع تباطؤ تدريجي عند تجاوزها.
 *  4. كادنس ليلي: تأخير إضافي بسيط بين 01:00–06:00 (تقليص النشاط الليلي).
 *  5. وقفات "تشتّت" عشوائية نادرة قبل الإرسال.
 *  6. إيقاع تصفّح يومي خفيف (طلبات HTTP دورية تبدو كفتح فيسبوك من حين لآخر).
 *
 * كل شيء قابل للتعطيل عبر متغيرات البيئة:
 *   HUMAN_LAYER=false            تعطيل الطبقة بالكامل (سلوك قديم)
 *   HUMAN_TYPING=false           تعطيل مؤشر الكتابة فقط
 *   HUMAN_READ_DELAY=false       تعطيل تأخير القراءة (يعود autoMarkRead الفوري)
 *   HUMAN_NIGHT_LATENCY=false    تعطيل الكادنس الليلي
 *   HUMAN_THREAD_BUDGET=15       ميزانية الرسائل لكل محادثة / 10 دقائق
 *   HUMAN_TYPING_MAX_MS=9000     سقف مدة مؤشر الكتابة
 */

const TYPING_MIN_MS = 1200;
const PACING_WINDOW_MS = 10 * 60 * 1000;

function envFlag(name, def = "true") {
  const raw = String(process.env[name] ?? def).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return String(def).toLowerCase() === "true";
}
function envInt(name, def, min, max) {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isSafeInteger(v) || v <= 0) return def;
  return Math.min(max, Math.max(min, v));
}

export function humanLayerEnabled() { return envFlag("HUMAN_LAYER", "true"); }
export function typingActive() { return humanLayerEnabled() && envFlag("HUMAN_TYPING", "true"); }
export function readDelayActive() { return humanLayerEnabled() && envFlag("HUMAN_READ_DELAY", "true"); }
function nightLatencyActive() { return humanLayerEnabled() && envFlag("HUMAN_NIGHT_LATENCY", "true"); }

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function _rand(min, max) { return min + Math.random() * (max - min); }

/* ─── حالة كل محادثة (مزاج الكتابة + نافذة الإيقاع) ─── */
const _threads = new Map();
function threadState(tid) {
  const key = String(tid);
  let st = _threads.get(key);
  if (!st) {
    st = { mood: _rand(0.75, 1.3), moodAt: Date.now(), sends: [], lastReadAt: 0 };
    _threads.set(key, st);
  }
  return st;
}
// مزاج ينجرف ببطء (سرعة كتابة تتغير مع "اليوم")
function threadMood(st) {
  if (Date.now() - st.moodAt > 30 * 60 * 1000) { st.mood = Math.min(1.35, Math.max(0.7, st.mood + _rand(-0.15, 0.15))); st.moodAt = Date.now(); }
  return st.mood;
}
function recordSend(st) { st.sends.push(Date.now()); }
function pruneSends(st) {
  const cutoff = Date.now() - PACING_WINDOW_MS;
  while (st.sends.length && st.sends[0] < cutoff) st.sends.shift();
}
function pacingExtraMs(st) {
  pruneSends(st);
  const budget = envInt("HUMAN_THREAD_BUDGET", 15, 3, 200);
  const over = st.sends.length - budget;
  if (over <= 0) return 0;
  // تباطؤ تدريجي: +1.6 ثانية لكل رسالة فوق الميزانية، بحد أقصى 20 ثانية
  return Math.min(20000, Math.round(over * 1600 * _rand(0.85, 1.2)));
}
function isNightHour() {
  const h = new Date().getHours();
  return h >= 1 && h < 6;
}
function nightExtraMs() {
  if (!nightLatencyActive() || !isNightHour()) return 0;
  return Math.round(_rand(800, 3800));
}

/* ─── مدة الكتابة البشرية ─── */
function typingDurationMs(text, st) {
  const maxMs = envInt("HUMAN_TYPING_MAX_MS", 9000, 1500, 60000);
  const len = String(text || "").length;
  if (!len) return 0;
  // رد سريع عفوي أحياناً (13%): إنسان يرد فوراً برسالة قصيرة
  if (len <= 90 && Math.random() < 0.13) return Math.round(_rand(500, 1300));
  const charsPerSec = (26 + Math.random() * 22) * threadMood(st); // ~26–48 حرف/ث
  const thinkMs = _rand(500, 1600);                                // "قراءة وفهم" قبل الكتابة
  const typeMs = (len / charsPerSec) * 1000;
  const jitter = _rand(-350, 550);
  return Math.max(TYPING_MIN_MS, Math.min(maxMs, Math.round(thinkMs + typeMs + jitter)));
}

/* ─── إظهار/إخفاء مؤشر الكتابة (يجب ألا يكسر الإرسال أبداً) ─── */
function showTyping(api, threadID, durationMs) {
  try {
    if (typeof api?.sendTypingIndicator !== "function" || durationMs <= 0) return null;
    const p = api.sendTypingIndicator(threadID, true, { duration: Math.ceil(durationMs + 4000) }, () => {});
    if (p && typeof p.catch === "function") p.catch(() => {});
    return true;
  } catch (_) { return null; }
}
function stopTyping(api, threadID) {
  try {
    if (typeof api?.sendTypingIndicator !== "function") return;
    const p = api.sendTypingIndicator(threadID, false, () => {});
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (_) {}
}

/**
 * يُستدعى من طبقة الإرسال قبل إرسال رسالة نصية.
 * ينتظر مدة بشرية (كتابة + إيقاع + ليل) ويعيد دالة إيقاف مؤشر الكتابة.
 */
export async function humanPreSendPause(api, threadID, body) {
  if (!humanLayerEnabled()) return null;
  const st = threadState(threadID);
  const text = typeof body === "string" ? body : (body && typeof body.body === "string" ? body.body : "");
  recordSend(st);
  let pauseMs = pacingExtraMs(st) + nightExtraMs();
  const typingMs = typingActive() ? typingDurationMs(text, st) : 0;
  if (text) {
    pauseMs += typingMs;
    // وقفة تشتّت نادرة (8%): إنسان تشاغل عن المحادثة لحظة
    if (Math.random() < 0.08) pauseMs += Math.round(_rand(3000, 9000));
  }
  pauseMs = Math.min(pauseMs, 45000);
  if (pauseMs > 0) {
    if (typingMs > 0) showTyping(api, threadID, pauseMs);
    await _sleep(pauseMs);
  }
  return { api, threadID };
}

/** يُستدعى بعد خروج الرسالة فعلياً لإخفاء مؤشر الكتابة فوراً */
export function humanPostSend(handle) {
  if (!handle) return;
  stopTyping(handle.api, handle.threadID);
}

/* ─── إيصال قراءة متأخر ─── */
export function markReadLikeHuman(api, event) {
  if (!humanLayerEnabled() || !readDelayActive()) return;
  const type = String(event?.type || "");
  if (type !== "message" && type !== "message_reply") return;
  const threadID = event?.threadID;
  if (!threadID || typeof api?.markAsRead !== "function") return;
  const st = threadState(threadID);
  const now = Date.now();
  if (now - st.lastReadAt < 1200) return; // لا نكرر لكل رسالة في نفس اللحظة
  st.lastReadAt = now;
  const bodyLen = String(event?.body || "").length;
  const delay = Math.round(_rand(1400, 3600) + Math.min(bodyLen * 26, 3200));
  const timer = setTimeout(() => {
    try {
      const p = api.markAsRead(threadID, true, () => {});
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {}
  }, delay);
  if (timer.unref) timer.unref();
}

/* ─── الإيقاع اليومي: تصفّح خفيف دوري ─── */
const BROWSE_ENDPOINTS = [
  "https://www.facebook.com/messages/",
  "https://www.facebook.com/",
  "https://www.facebook.com/friends"
];

export function initHumanLayer(api, opts = {}) {
  const label = opts.label || "Bot-1";
  if (!humanLayerEnabled()) {
    console.log(`[HUMAN:${label}] ⏸️ طبقة السلوك البشري معطّلة (HUMAN_LAYER=false)`);
    return null;
  }
  if (api.__humanLayer) return api.__humanLayer;
  const state = { startedAt: Date.now(), browsing: 0, stopped: false, timer: null };
  api.__humanLayer = state;
  const browse = () => {
    if (state.stopped) return;
    try {
      const ep = BROWSE_ENDPOINTS[Math.floor(Math.random() * BROWSE_ENDPOINTS.length)];
      const p = typeof api.httpGet === "function" ? api.httpGet(ep, {}) : null;
      if (p && typeof p.catch === "function") p.catch(() => {});
      state.browsing++;
      if (Math.random() < 0.3 && typeof api.refreshFbDtsg === "function") {
        const p2 = api.refreshFbDtsg();
        if (p2 && typeof p2.catch === "function") p2.catch(() => {});
      }
    } catch (_) {}
  };
  const schedule = (delayMs) => {
    if (state.stopped) return;
    state.timer = setTimeout(() => { browse(); schedule(_rand(90, 240) * 60 * 1000); }, delayMs);
    if (state.timer.unref) state.timer.unref();
  };
  schedule(_rand(5, 15) * 60 * 1000); // أول "فتح للفيسبوك" بعد 5–15 دقيقة
  console.log(`[HUMAN:${label}] 🧠 طبقة السلوك البشري نشطة` +
    ` | كتابة: ${typingActive() ? "مفعّل" : "معطّل"}` +
    ` | قراءة متأخرة: ${readDelayActive() ? "مفعّلة" : "معطّلة"}` +
    ` | ميزانية/10د: ${envInt("HUMAN_THREAD_BUDGET", 15, 3, 200)} رسالة` +
    ` | كادنس ليلي: ${nightLatencyActive() ? "مفعّل" : "معطّل"}`);
  return state;
}

/* تنظيف خفيف للذاكرة كل 30 دقيقة */
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [k, st] of _threads) {
    pruneSends(st);
    if (st.sends.length === 0 && st.lastReadAt < cutoff) _threads.delete(k);
  }
}, 30 * 60 * 1000).unref?.();
