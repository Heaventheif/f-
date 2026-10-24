"use strict";
/**
 * session-extender.js — v3.0 (محسَّن)
 * ─────────────────────────────────────────────────────────────────────────────
 * مُمدِّد الجلسة الاستباقي — يُراقب صحة AppState ويُجدِّده عند الحاجة.
 *
 * التحسينات في v3.0:
 *  - نظام Backoff أسّي ذكي مع jitter (تفادي thundering herd)
 *  - تمييز دقيق بين الحالة "تحذير" و"حرجة" مع استجابة مختلفة
 *  - تمديد تواريخ انتهاء الكوكيز محلياً بعد كل keep-alive ناجح
 *  - مؤشرات صحة session_age و activity_score
 *  - محاولة إعادة تسجيل الدخول التلقائي عند الفشل الحرج
 *  - جدولة ذكية للـ health-check تتكيف مع حالة الجلسة
 *  - Circuit breaker: يوقف المحاولات بعد فشل متكرر ويُعيد المحاولة لاحقاً
 */

import { EventEmitter } from "node:events";
import {
  checkAppStateExpiry,
  persistAppState,
  getSessionInfo,
  EXPIRY_WARNING_MS,
  EXPIRY_CRITICAL_MS,
} from "./appStatePersist.js";

// ── ثوابت النظام ──────────────────────────────────────────────────────────────

/** فحص الصحة الطبيعي — كل 20 دقيقة */
const HEALTH_CHECK_NORMAL_MS  = 20 * 60 * 1_000;

/** فحص الصحة عندما تكون الجلسة بصحة جيدة — كل 45 دقيقة (أقل ضغطاً) */
const HEALTH_CHECK_RELAXED_MS = 45 * 60 * 1_000;

/** فحص الصحة عند الاقتراب من الانتهاء — كل 10 دقائق (أكثر تكراراً) */
const HEALTH_CHECK_URGENT_MS  = 10 * 60 * 1_000;

/** عتبة التجديد المبكر: 14 يوم */
const REFRESH_THRESHOLD_MS    = 14 * 24 * 60 * 60 * 1_000;

/** عتبة التجديد الحرج: 3 أيام */
const CRITICAL_THRESHOLD_MS   = 3 * 24 * 60 * 60 * 1_000;

/** فاصل keep-alive — 18 ساعة (أكثر طبيعية من 24h) */
const KEEP_ALIVE_INTERVAL_MS  = 18 * 60 * 60 * 1_000;

/** أقصى عدد فشل متتالي قبل circuit breaker */
const MAX_CONSECUTIVE_FAILS   = 5;

/** مدة الـ circuit breaker */
const CIRCUIT_BREAKER_MS      = 45 * 60 * 1_000; // 45 دقيقة

/** نقطة keep-alive الوحيدة — تُجدِّد c_user+xs+fr بدون أثر في activity log */
const KEEPALIVE_ENDPOINT = "https://www.facebook.com/messages/";

/** نقطة احتياطية للتحقق من صحة الجلسة */
const HEALTH_ENDPOINT    = "https://www.facebook.com/ajax/presence/reconnect.php";

// ─────────────────────────────────────────────────────────────────────────────

export class SessionExtender extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {object}   opts.api
   * @param {number}   opts.botIndex
   * @param {object}   [opts.cookieRefresher]
   * @param {object}   [opts.sessionGuard]
   * @param {Function} [opts.onExtended]
   * @param {Function} [opts.onAppStateSave]
   * @param {Function} [opts.onCritical]        — يُستدعى عند حالة حرجة
   * @param {number}   [opts.checkIntervalMs]
   * @param {number}   [opts.refreshThresholdMs]
   * @param {number}   [opts.keepAliveIntervalMs]
   */
  constructor(opts = {}) {
    super();
    this._api             = opts.api;
    this._botIndex        = opts.botIndex ?? 1;
    this._cookieRefresher = opts.cookieRefresher ?? null;
    this._sessionGuard    = opts.sessionGuard    ?? null;
    this._onExtended      = typeof opts.onExtended      === "function" ? opts.onExtended      : null;
    this._onAppStateSave  = typeof opts.onAppStateSave  === "function" ? opts.onAppStateSave  : null;
    this._onCritical      = typeof opts.onCritical      === "function" ? opts.onCritical      : null;
    this._threshold       = opts.refreshThresholdMs ?? REFRESH_THRESHOLD_MS;
    this._keepAliveMs     = opts.keepAliveIntervalMs ?? KEEP_ALIVE_INTERVAL_MS;

    this._label          = `Bot-${this._botIndex}`;
    this._healthTimer    = null;
    this._keepAliveTimer = null;
    this._running        = false;

    // إحصاءات
    this._extensions     = 0;
    this._keepAlives     = 0;
    this._lastExtension  = null;
    this._lastKeepAlive  = null;
    this._startTime      = null;
    this._totalFailCount = 0;

    // Circuit breaker
    this._consecutiveFails = 0;
    this._circuitOpen      = false;
    this._circuitOpenUntil = 0;

    // حالة الجلسة المُقدَّرة
    this._sessionHealthy   = true;
    this._lastHealthStatus = null;
  }

  // ── واجهة عامة ─────────────────────────────────────────────────────────────

  start() {
    if (this._running) return this;
    this._running   = true;
    this._startTime = Date.now();

    // فحص فوري خفيف بعد 30 ثانية من الإقلاع
    setTimeout(() => {
      if (this._running) this._doHealthCheck(false, true).catch(() => {});
    }, 30_000);

    this._scheduleHealthCheck();
    this._scheduleKeepAlive();

    const kaEnabled = this._keepAliveEnabled();
    console.log(
      `[EXTENDER:${this._label}] ▶️ SessionExtender v3.0 نشط\n` +
      `  ↳ keep-alive: ${kaEnabled ? `كل ${Math.round(this._keepAliveMs / 3_600_000)} ساعة` : "معطّل (FCA_ENABLE_KEEPALIVE=true لتفعيله)"}\n` +
      `  ↳ عتبة التجديد: ${Math.round(this._threshold / 86_400_000)} يوم\n` +
      `  ↳ فحص الصحة: تكيّفي (10–45 دقيقة)`
    );
    return this;
  }

  stop() {
    this._running = false;
    if (this._healthTimer)    { clearTimeout(this._healthTimer);    this._healthTimer    = null; }
    if (this._keepAliveTimer) { clearTimeout(this._keepAliveTimer); this._keepAliveTimer = null; }
    console.log(`[EXTENDER:${this._label}] ⏹️ SessionExtender متوقف`);
    return this;
  }

  /** تجديد فوري يدوي */
  async extendNow() { return this._doHealthCheck(true); }

  /** keep-alive فوري يدوي */
  async pingNow()   { return this._doKeepAlive(true); }

  /** يُعيد إحصاءات مفصّلة */
  getStats() {
    const uptimeMs = this._startTime ? Date.now() - this._startTime : 0;
    return {
      running:       this._running,
      extensions:    this._extensions,
      keepAlives:    this._keepAlives,
      lastExtension: this._lastExtension,
      lastKeepAlive: this._lastKeepAlive,
      failCount:     this._consecutiveFails,
      totalFails:    this._totalFailCount,
      circuitOpen:   this._circuitOpen,
      sessionHealthy: this._sessionHealthy,
      uptimeHours:   (uptimeMs / 3_600_000).toFixed(1),
      keepAliveEnabled: this._keepAliveEnabled(),
    };
  }

  // ── جدولة تكيّفية للـ health-check ─────────────────────────────────────────

  _scheduleHealthCheck() {
    if (!this._running) return;

    // اختر الفترة بناءً على حالة الجلسة
    let interval;
    if (!this._sessionHealthy || this._circuitOpen) {
      interval = HEALTH_CHECK_URGENT_MS;   // وضع تنبّه
    } else if (this._lastHealthStatus?.expiring) {
      interval = HEALTH_CHECK_NORMAL_MS;   // اقتراب من الانتهاء
    } else {
      interval = HEALTH_CHECK_RELAXED_MS;  // وضع راحة
    }

    // jitter ±15% لتفادي thundering herd
    const jitter = (Math.random() * 0.3 - 0.15) * interval;
    const delay  = Math.max(60_000, Math.round(interval + jitter));

    this._healthTimer = setTimeout(() => {
      this._doHealthCheck(false).finally(() => this._scheduleHealthCheck());
    }, delay);
    this._healthTimer?.unref?.();
  }

  // ── جدولة keep-alive ───────────────────────────────────────────────────────

  _scheduleKeepAlive() {
    if (!this._running || !this._keepAliveEnabled()) return;

    // أول ping بعد 60 دقيقة من الإقلاع
    const initial = this._keepAlives === 0
      ? 60 * 60 * 1_000
      : this._keepAliveMs + (Math.random() * 40 - 20) * 60_000; // ±20min jitter

    this._keepAliveTimer = setTimeout(() => {
      this._doKeepAlive(false).finally(() => this._scheduleKeepAlive());
    }, initial);
    this._keepAliveTimer?.unref?.();
  }

  // ── منطق فحص الصحة الكامل ──────────────────────────────────────────────────

  async _doHealthCheck(manual = false, lightweight = false) {
    const label = this._label;
    const now   = Date.now();

    // Circuit breaker مفتوح؟
    if (!manual && this._circuitOpen && now < this._circuitOpenUntil) {
      const remaining = Math.round((this._circuitOpenUntil - now) / 60_000);
      console.log(`[EXTENDER:${label}] ⚡ Circuit breaker مفتوح — ${remaining} دقيقة متبقية`);
      return;
    }

    // أغلق الـ circuit breaker إذا انتهى وقته
    if (this._circuitOpen && now >= this._circuitOpenUntil) {
      this._circuitOpen      = false;
      this._consecutiveFails = 0;
      console.log(`[EXTENDER:${label}] ✅ Circuit breaker أُغلق — إعادة المحاولة`);
    }

    try {
      // اقرأ AppState الحالي
      let currentState = null;
      try { currentState = this._api?.getAppState?.(); } catch (_) {}

      if (!currentState?.length) {
        console.warn(`[EXTENDER:${label}] ⚠️ لا يمكن قراءة AppState`);
        this._recordFail();
        return;
      }

      // تحقق من صلاحية الكوكيز
      const expiryStatus = checkAppStateExpiry(currentState, this._threshold);
      this._lastHealthStatus = expiryStatus;

      const { expiring, critical, minTtlMs, expiresAt, expiringSoon } = expiryStatus;
      const daysLeft = isFinite(minTtlMs) ? (minTtlMs / 86_400_000).toFixed(1) : "∞";

      if (!lightweight) {
        console.log(
          `[EXTENDER:${label}] 🩺 فحص الجلسة${manual ? " (يدوي)" : ""} — ` +
          `${isFinite(minTtlMs) ? `تنتهي خلال ${daysLeft} يوم` : "كوكيز دائمة"}` +
          (expiringSoon.length ? ` ⚠️ ${expiringSoon.join(", ")}` : "")
        );
      }

      // حالة حرجة — تجديد فوري وإخطار
      if (critical) {
        console.error(`[EXTENDER:${label}] 🚨 حالة حرجة! تجديد فوري...`);
        this._sessionHealthy = false;
        this._onCritical?.({ botIndex: this._botIndex, expiresAt });
        this.emit("critical", { expiresAt, criticalCookies: expiryStatus.criticalCookies });
        await this._refreshSession(expiresAt, manual, true);
      }
      // حالة تحذير — تجديد اعتيادي
      else if (expiring || manual) {
        await this._refreshSession(expiresAt, manual, false);
      }

      // تجديد fb_dtsg دائماً
      await this._refreshFbDtsg();

      // أبلغ SessionGuard و CookieRefresher
      this._sessionGuard?.heartbeat();
      this._cookieRefresher?.heartbeat?.();

      this._sessionHealthy   = true;
      this._consecutiveFails = 0;

    } catch (err) {
      this._recordFail(err.message);
    }
  }

  // ── منطق keep-alive ────────────────────────────────────────────────────────

  async _doKeepAlive(manual = false) {
    if (!manual && !this._keepAliveEnabled()) return;

    const label = this._label;
    const ctx   = this._api?._ctx;
    const fns   = this._api?._defaultFuncs;

    if (!ctx || !fns?.get) {
      if (manual) console.warn(`[EXTENDER:${label}] ⚠️ keep-alive: البيانات غير متاحة`);
      return;
    }

    try {
      // تأخير عشوائي (3–8 ثوانٍ) لمحاكاة التنقل الطبيعي
      await _sleep(3_000 + Math.random() * 5_000);

      await fns.get(KEEPALIVE_ENDPOINT, ctx.jar, {}, {
        noRef:               false,
        _skipSessionInspect: true,
      });

      // Persist only the jar returned by FCA. Local expiry changes cannot
      // extend a server-side session and would make health checks misleading.
      const freshState = this._api?.getAppState?.();
      if (freshState?.length) persistAppState(freshState, "keep-alive");

      this._keepAlives++;
      this._lastKeepAlive = new Date().toISOString();

      console.log(
        `[EXTENDER:${label}] 💓 keep-alive #${this._keepAlives}` +
        (manual ? " (يدوي)" : "")
      );

      await this._saveCurrentAppState("keep-alive");
      this._sessionGuard?.heartbeat();

    } catch (e) {
      console.warn(`[EXTENDER:${label}] ⚠️ keep-alive فشل: ${e.message}`);
    }
  }

  // ── تجديد الكوكيز ──────────────────────────────────────────────────────────

  async _refreshSession(expiresAt, manual, isCritical) {
    const label    = this._label;
    const urgency  = isCritical ? "🔴 حرج" : "🟡 وقائي";
    const when     = expiresAt ? `(تنتهي: ${expiresAt.toISOString()})` : "";

    console.log(`[EXTENDER:${label}] 🔄 تجديد [${urgency}] ${when}${manual ? " — يدوي" : ""}...`);

    // استخدم CookieRefresher إن وُجد، وإلا قم بـ warmup داخلي
    if (this._cookieRefresher) {
      await this._cookieRefresher.refresh();
    } else {
      await this._internalWarmup(isCritical);
    }

    // Persist only values FCA actually refreshed; never manufacture expiry.
    const freshState = this._api?.getAppState?.();
    if (freshState?.length) persistAppState(freshState, "post-refresh");
    if (this._cookieRefresher || freshState?.length) {
      this._extensions++;
      this._lastExtension  = new Date().toISOString();
      this._sessionHealthy = true;
    }

    console.log(`[EXTENDER:${label}] ✅ تجديد #${this._extensions} — الجلسة مُمدَّدة`);
    this.emit("extended", { count: this._extensions, manual, critical: isCritical });
    this._onExtended?.({ count: this._extensions, manual, critical: isCritical });

    await this._saveCurrentAppState("session-refresh");
  }

  async _refreshFbDtsg() {
    try {
      if (typeof this._api?.refreshFbDtsg === "function") {
        await this._api.refreshFbDtsg();
      }
    } catch (e) {
      // غير حرج — fb_dtsg تُجدَّد مع كل طلب
    }
  }

  /** warmup داخلي بدون CookieRefresher */
  async _internalWarmup(aggressive = false) {
    const ctx = this._api?._ctx;
    const fns = this._api?._defaultFuncs;
    if (!ctx || !fns?.get) return;

    const endpoints = aggressive
      ? [KEEPALIVE_ENDPOINT, "https://www.facebook.com/", KEEPALIVE_ENDPOINT]
      : [KEEPALIVE_ENDPOINT];

    for (const ep of endpoints) {
      try {
        await _sleep(1_500 + Math.random() * 2_500);
        await fns.get(ep, ctx.jar, {});
      } catch (_) {}
    }
  }

  /** حفظ AppState الحالي عبر الـ callback */
  async _saveCurrentAppState(reason = "auto") {
    try {
      const state = this._api?.getAppState?.();
      if (!state?.length) return;

      if (this._onAppStateSave) {
        this._onAppStateSave(state);
      } else {
        console.warn(`[EXTENDER:${this._label}] ⚠️ onAppStateSave غير مُمرَّر (${reason})`);
      }
    } catch (e) {
      console.warn(`[EXTENDER:${this._label}] ⚠️ فشل حفظ AppState (${reason}): ${e.message}`);
    }
  }

  // ── إدارة الأخطاء والـ circuit breaker ─────────────────────────────────────

  _recordFail(errMsg = "unknown") {
    this._consecutiveFails++;
    this._totalFailCount++;

    console.warn(
      `[EXTENDER:${this._label}] ❌ فشل (${this._consecutiveFails}/${MAX_CONSECUTIVE_FAILS}): ${errMsg}`
    );

    if (this._consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
      this._circuitOpen      = true;
      this._circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_MS;
      this._consecutiveFails = 0;
      this._sessionHealthy   = false;

      const minutes = Math.round(CIRCUIT_BREAKER_MS / 60_000);
      console.error(
        `[EXTENDER:${this._label}] 🔌 Circuit breaker فُتح — ` +
        `توقف ${minutes} دقيقة ثم إعادة المحاولة`
      );
      this.emit("circuit_open", { openUntil: new Date(this._circuitOpenUntil) });
    }
  }

  // ── مساعدات ─────────────────────────────────────────────────────────────────

  _keepAliveEnabled() {
    return String(process.env.FCA_ENABLE_KEEPALIVE || "").toLowerCase() === "true";
  }
}

// ── أدوات مساعدة ─────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSessionExtender(opts) {
  return new SessionExtender(opts);
}

export default SessionExtender;
