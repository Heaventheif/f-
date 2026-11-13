"use strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { checkAppStateExpiry, persistAppState } from "./appStatePersist.js";

const HEALTH_CHECK_NORMAL_MS = 20 * 60 * 1e3;
const HEALTH_CHECK_RELAXED_MS = 45 * 60 * 1e3;
const HEALTH_CHECK_URGENT_MS = 10 * 60 * 1e3;
const REFRESH_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1e3;
const KEEP_ALIVE_INTERVAL_MS = 18 * 60 * 60 * 1e3;
export const MIN_WARMUP_GAP_MS = 30 * 60 * 1e3; // warm-up requests are never closer than this
const MAX_CONSECUTIVE_FAILS = 5;
const CIRCUIT_BREAKER_MS = 45 * 60 * 1e3;
const KEEPALIVE_ENDPOINT = "https://www.facebook.com/messages/";
const LOGIN_MARKERS = /id="login_form"|name="login"|\/login\/\?|checkpoint\/block/i;

const cookieName = (c) => String(c?.key ?? c?.name ?? "");
const cookieValue = (state, name) => state?.find?.((c) => cookieName(c) === name)?.value ?? null;

// Stable fingerprint of cookie names/values (ignores order) used to persist only on change.
export function cookieFingerprint(state) {
  if (!Array.isArray(state)) return null;
  const rows = state
    .map((c) => `${cookieName(c)}|${c?.domain ?? ""}|${c?.path ?? ""}=${c?.value ?? ""}`)
    .sort();
  return crypto.createHash("sha256").update(rows.join("\n")).digest("hex");
}

// Real whoami probe: the session is healthy only if, after a live request, the
// jar still holds c_user + xs, c_user matches the logged-in id, and FB did not serve a login page.
export async function defaultProbe(api) {
  const ctx = api?._ctx;
  const fns = api?._defaultFuncs;
  let page = null;
  if (ctx && fns?.get) {
    const res = await fns.get(KEEPALIVE_ENDPOINT, ctx.jar, {}, { noRef: false, _skipSessionInspect: true });
    page = typeof res === "string" ? res : (res?.body ?? null);
  }
  const state = api?.getAppState?.();
  const uid = cookieValue(state, "c_user");
  const xs = cookieValue(state, "xs");
  if (!uid || !xs) return { ok: false, reason: "missing_cookies", uid: null };
  const expected = api?.getCurrentUserID?.();
  if (expected && String(expected) !== String(uid)) return { ok: false, reason: "uid_mismatch", uid };
  if (typeof page === "string" && LOGIN_MARKERS.test(page.slice(0, 200_000)))
    return { ok: false, reason: "login_page", uid };
  return { ok: true, uid };
}

export class SessionExtender extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._api = opts.api;
    this._botIndex = opts.botIndex ?? 1;
    this._probe = opts.probe ?? defaultProbe;
    this._onExtended = typeof opts.onExtended === "function" ? opts.onExtended : null;
    this._onAppStateSave = typeof opts.onAppStateSave === "function" ? opts.onAppStateSave : null;
    this._onCritical = typeof opts.onCritical === "function" ? opts.onCritical : null;
    this._threshold = opts.refreshThresholdMs ?? REFRESH_THRESHOLD_MS;
    this._keepAliveMs = opts.keepAliveIntervalMs ?? KEEP_ALIVE_INTERVAL_MS;
    this._label = `Bot-${this._botIndex}`;
    this._initialTimer = null;
    this._healthTimer = null;
    this._keepAliveTimer = null;
    this._running = false;
    this._extensions = 0;
    this._keepAlives = 0;
    this._lastExtension = null;
    this._lastKeepAlive = null;
    this._startTime = null;
    this._totalFailCount = 0;
    this._consecutiveFails = 0;
    this._circuitOpen = false;
    this._circuitOpenUntil = 0;
    this._sessionHealthy = true;
    this._lastHealthStatus = null;
    this._lastFingerprint = null;
    this._lastWarmupAt = 0;
  }
  start() {
    if (this._running) return this;
    this._running = true;
    this._startTime = Date.now();
    this._lastFingerprint = cookieFingerprint(this._safeState());
    this._initialTimer = setTimeout(() => {
      this._initialTimer = null;
      if (this._running) this._doHealthCheck(false, true).catch(() => {});
    }, 3e4);
    this._initialTimer.unref?.();
    this._scheduleHealthCheck();
    this._scheduleKeepAlive();
    const kaEnabled = this._keepAliveEnabled();
    console.log(`[EXTENDER:${this._label}] ▶️ SessionExtender نشط
  ↳ keep-alive: ${kaEnabled ? `كل ${Math.round(this._keepAliveMs / 36e5)} ساعة` : "معطّل (FCA_ENABLE_KEEPALIVE=true لتفعيله)"}
  ↳ عتبة التجديد: ${Math.round(this._threshold / 864e5)} يوم
  ↳ فحص الصحة: تكيّفي (10–45 دقيقة)`);
    return this;
  }
  stop() {
    this._running = false;
    for (const k of ["_initialTimer", "_healthTimer", "_keepAliveTimer"]) {
      if (this[k]) clearTimeout(this[k]);
      this[k] = null;
    }
    console.log(`[EXTENDER:${this._label}] ⏹️ SessionExtender متوقف`);
    return this;
  }
  async extendNow() {
    return this._doHealthCheck(true);
  }
  async pingNow() {
    return this._doKeepAlive(true);
  }
  getStats() {
    const uptimeMs = this._startTime ? Date.now() - this._startTime : 0;
    return {
      running: this._running,
      extensions: this._extensions,
      keepAlives: this._keepAlives,
      lastExtension: this._lastExtension,
      lastKeepAlive: this._lastKeepAlive,
      failCount: this._consecutiveFails,
      totalFails: this._totalFailCount,
      circuitOpen: this._circuitOpen,
      sessionHealthy: this._sessionHealthy,
      uptimeHours: (uptimeMs / 36e5).toFixed(1),
      keepAliveEnabled: this._keepAliveEnabled(),
    };
  }
  _safeState() {
    try {
      return this._api?.getAppState?.() ?? null;
    } catch {
      return null;
    }
  }
  _scheduleHealthCheck() {
    if (!this._running) return;
    let interval;
    if (!this._sessionHealthy || this._circuitOpen) interval = HEALTH_CHECK_URGENT_MS;
    else if (this._lastHealthStatus?.expiring) interval = HEALTH_CHECK_NORMAL_MS;
    else interval = HEALTH_CHECK_RELAXED_MS;
    const jitter = (Math.random() * 0.3 - 0.15) * interval;
    const delay = Math.max(6e4, Math.round(interval + jitter));
    this._healthTimer = setTimeout(() => {
      this._doHealthCheck(false)
        .catch((e) => console.warn(`[EXTENDER:${this._label}] ⚠️ ${e?.message || e}`))
        .finally(() => this._scheduleHealthCheck());
    }, delay);
    this._healthTimer.unref?.();
  }
  _scheduleKeepAlive() {
    if (!this._running || !this._keepAliveEnabled()) return;
    const delay =
      this._keepAlives === 0 ? 60 * 60 * 1e3 : this._keepAliveMs + (Math.random() * 40 - 20) * 6e4;
    this._keepAliveTimer = setTimeout(() => {
      this._doKeepAlive(false)
        .catch((e) => console.warn(`[EXTENDER:${this._label}] ⚠️ ${e?.message || e}`))
        .finally(() => this._scheduleKeepAlive());
    }, delay);
    this._keepAliveTimer.unref?.();
  }
  async _doHealthCheck(manual = false, lightweight = false) {
    const label = this._label;
    const now = Date.now();
    if (!manual && this._circuitOpen && now < this._circuitOpenUntil) {
      console.log(
        `[EXTENDER:${label}] ⚡ Circuit breaker مفتوح — ${Math.round((this._circuitOpenUntil - now) / 6e4)} دقيقة متبقية`,
      );
      return;
    }
    if (this._circuitOpen && now >= this._circuitOpenUntil) {
      this._circuitOpen = false;
      this._consecutiveFails = 0;
      console.log(`[EXTENDER:${label}] ✅ Circuit breaker أُغلق — إعادة المحاولة`);
    }
    try {
      const currentState = this._safeState();
      if (!currentState?.length) {
        this._sessionHealthy = false;
        this._recordFail("لا يمكن قراءة AppState");
        return;
      }
      const expiryStatus = checkAppStateExpiry(currentState, this._threshold);
      this._lastHealthStatus = expiryStatus;
      const { expiring, critical, minTtlMs, expiresAt, expiringSoon } = expiryStatus;
      if (!lightweight) {
        const daysLeft = isFinite(minTtlMs) ? (minTtlMs / 864e5).toFixed(1) : "∞";
        console.log(
          `[EXTENDER:${label}] 🩺 فحص الجلسة${manual ? " (يدوي)" : ""} — ${isFinite(minTtlMs) ? `تنتهي خلال ${daysLeft} يوم` : "كوكيز دائمة"}` +
            (expiringSoon.length ? ` ⚠️ ${expiringSoon.join(", ")}` : ""),
        );
      }
      if (critical) {
        console.error(`[EXTENDER:${label}] 🚨 حالة حرجة! تجديد فوري...`);
        this._onCritical?.({ botIndex: this._botIndex, expiresAt });
        this.emit("critical", { expiresAt, criticalCookies: expiryStatus.criticalCookies });
        await this._refreshSession(expiresAt, manual, true);
      } else if (expiring || manual) {
        await this._refreshSession(expiresAt, manual, false);
      }
      await this._refreshFbDtsg();
      // Health is whatever the live probe says, not an assumption.
      const probe = await this._probe(this._api);
      if (!probe?.ok) {
        this._sessionHealthy = false;
        this._recordFail(`whoami probe: ${probe?.reason || "failed"}`);
        return;
      }
      this._sessionHealthy = true;
      this._consecutiveFails = 0;
      await this._persistIfChanged("health-check");
    } catch (err) {
      this._sessionHealthy = false;
      this._recordFail(err?.message || String(err));
    }
  }
  async _doKeepAlive(manual = false) {
    if (!manual && !this._keepAliveEnabled()) return;
    const label = this._label;
    if (!this._api?._ctx || !this._api?._defaultFuncs?.get) {
      if (manual) console.warn(`[EXTENDER:${label}] ⚠️ keep-alive: البيانات غير متاحة`);
      return;
    }
    try {
      await _sleep(3e3 + Math.random() * 5e3);
      const probe = await this._probe(this._api);
      if (!probe?.ok) throw new Error(`whoami probe: ${probe?.reason || "failed"}`);
      this._keepAlives++; // success only
      this._lastKeepAlive = new Date().toISOString();
      console.log(
        `[EXTENDER:${label}] 💓 keep-alive #${this._keepAlives}` + (manual ? " (يدوي)" : ""),
      );
      await this._persistIfChanged("keep-alive");
    } catch (e) {
      console.warn(`[EXTENDER:${label}] ⚠️ keep-alive فشل: ${e?.message || e}`);
    }
  }
  async _refreshSession(expiresAt, manual, isCritical) {
    const label = this._label;
    const when = expiresAt ? `(تنتهي: ${expiresAt.toISOString()})` : "";
    console.log(
      `[EXTENDER:${label}] 🔄 تجديد [${isCritical ? "🔴 حرج" : "🟡 وقائي"}] ${when}${manual ? " — يدوي" : ""}...`,
    );
    const successes = await this._internalWarmup(isCritical, manual);
    if (successes === 0) {
      console.warn(`[EXTENDER:${label}] ⚠️ التجديد لم ينجح (لا طلبات ناجحة) — لا يُحتسب`);
      return false;
    }
    this._extensions++;
    this._lastExtension = new Date().toISOString();
    console.log(`[EXTENDER:${label}] ✅ تجديد #${this._extensions} — الجلسة مُمدَّدة`);
    this.emit("extended", { count: this._extensions, manual, critical: isCritical });
    try {
      await this._onExtended?.({ count: this._extensions, manual, critical: isCritical });
    } catch (e) {
      console.warn(`[EXTENDER:${label}] ⚠️ onExtended: ${e?.message || e}`);
    }
    await this._persistIfChanged("session-refresh");
    return true;
  }
  async _refreshFbDtsg() {
    try {
      if (typeof this._api?.refreshFbDtsg === "function") await this._api.refreshFbDtsg();
    } catch (e) {
      console.warn(`[EXTENDER:${this._label}] ⚠️ refreshFbDtsg: ${e?.message || e}`);
    }
  }
  // Returns the number of successful warm-up requests. Never closer than MIN_WARMUP_GAP_MS apart (unless manual).
  async _internalWarmup(aggressive = false, manual = false) {
    const ctx = this._api?._ctx;
    const fns = this._api?._defaultFuncs;
    if (!ctx || !fns?.get) return 0;
    const now = Date.now();
    if (!manual && this._lastWarmupAt && now - this._lastWarmupAt < MIN_WARMUP_GAP_MS) {
      console.log(`[EXTENDER:${this._label}] ⏳ تخطي warm-up (أقل من 30 دقيقة على السابق)`);
      return 0;
    }
    this._lastWarmupAt = now;
    const endpoints = aggressive
      ? [KEEPALIVE_ENDPOINT, "https://www.facebook.com/", KEEPALIVE_ENDPOINT]
      : [KEEPALIVE_ENDPOINT];
    let ok = 0;
    for (const ep of endpoints) {
      try {
        await _sleep(1500 + Math.random() * 2500);
        await fns.get(ep, ctx.jar, {});
        ok++;
      } catch (e) {
        console.warn(`[EXTENDER:${this._label}] ⚠️ warm-up فشل: ${e?.message || e}`);
      }
    }
    return ok;
  }
  // Persist once per actual cookie change; the callback (or persistAppState as fallback) is awaited and guarded.
  async _persistIfChanged(reason) {
    try {
      const state = this._safeState();
      if (!state?.length) return false;
      const fp = cookieFingerprint(state);
      if (fp === this._lastFingerprint) return false;
      if (this._onAppStateSave) await this._onAppStateSave(state);
      else await persistAppState(state, reason);
      this._lastFingerprint = fp;
      return true;
    } catch (e) {
      console.warn(`[EXTENDER:${this._label}] ⚠️ فشل حفظ AppState (${reason}): ${e?.message || e}`);
      return false;
    }
  }
  _recordFail(errMsg = "unknown") {
    this._consecutiveFails++;
    this._totalFailCount++;
    console.warn(
      `[EXTENDER:${this._label}] ❌ فشل (${this._consecutiveFails}/${MAX_CONSECUTIVE_FAILS}): ${errMsg}`,
    );
    if (this._consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
      this._circuitOpen = true;
      this._circuitOpenUntil = Date.now() + CIRCUIT_BREAKER_MS;
      this._consecutiveFails = 0;
      this._sessionHealthy = false;
      console.error(
        `[EXTENDER:${this._label}] 🔌 Circuit breaker فُتح — توقف ${Math.round(CIRCUIT_BREAKER_MS / 6e4)} دقيقة ثم إعادة المحاولة`,
      );
      this.emit("circuit_open", { openUntil: new Date(this._circuitOpenUntil) });
    }
  }
  _keepAliveEnabled() {
    return String(process.env.FCA_ENABLE_KEEPALIVE || "").toLowerCase() === "true";
  }
}
function _sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
export function createSessionExtender(opts) {
  return new SessionExtender(opts);
}
export default SessionExtender;
