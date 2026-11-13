// Dashboard auth: password (HMAC timing-safe), per-IP + per-account exponential backoff,
// sessions in kv ns('sessions') with absolute + idle expiry. No global lockout.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../infra/errors.js";

export const COOKIE = "sunkenbot_dashboard";
export const SESSION_ABSOLUTE_MS = 12 * 3600_000;
export const SESSION_IDLE_MS = 2 * 3600_000;
const TOKEN_RE = /^[a-f0-9]{64}$/;
const MIN_PASSWORD = 12;
const ACCOUNT = "dashboard";

const sha = (s) => createHash("sha256").update(s).digest("hex");

// Compare via HMAC so length differences do not leak and compare is constant time.
export function makeSafeEqual(key = randomBytes(32)) {
  const mac = (v) => createHmac("sha256", key).update(String(v)).digest();
  return (a, b) => {
    if (a == null || b == null || a === "" || b === "") return false;
    return timingSafeEqual(mac(a), mac(b));
  };
}
export const safeEqual = makeSafeEqual();

// Exponential backoff per key: first `free` failures are free, then base*2^k up to max.
export class Backoff {
  constructor({ now = Date.now, base = 1000, max = 15 * 60_000, free = 3, maxKeys = 5000 } = {}) {
    Object.assign(this, { now, base, max, free, maxKeys });
    this.m = new Map();
  }
  retryAfterMs(key) {
    const e = this.m.get(key);
    return e && e.until > this.now() ? e.until - this.now() : 0;
  }
  fail(key) {
    const t = this.now();
    const e = this.m.get(key) || { n: 0, until: 0, last: t };
    e.n++;
    e.last = t;
    const over = e.n - this.free;
    e.until = over > 0 ? t + Math.min(this.max, this.base * 2 ** (over - 1)) : 0;
    this.m.delete(key);
    this.m.set(key, e);
    if (this.m.size > this.maxKeys) {
      for (const [k, v] of this.m) if (t - v.last > this.max * 2) this.m.delete(k);
      if (this.m.size > this.maxKeys) this.m.delete(this.m.keys().next().value);
    }
  }
  reset(key) {
    this.m.delete(key);
  }
}

export function readPasswordConfig(env = process.env, log = console) {
  const pw = String(env.DASHBOARD_PASSWORD || "");
  if (pw) {
    if (pw.length >= MIN_PASSWORD) return { secret: pw, source: "password" };
    log.error(`[AUTH] DASHBOARD_PASSWORD must be at least ${MIN_PASSWORD} characters; dashboard disabled`);
    return { secret: null, source: "invalid" };
  }
  const pin = String(env.PIN || "").trim();
  if (pin) {
    log.warn("[AUTH] using legacy PIN fallback; set DASHBOARD_PASSWORD (>=12 chars) instead");
    return { secret: pin, source: "pin" };
  }
  return { secret: null, source: "missing" };
}

export function createAuth({ store, now = Date.now, env = process.env, log = console } = {}) {
  const cfg = readPasswordConfig(env, log);
  const ipBackoff = new Backoff({ now });
  const acctBackoff = new Backoff({ now, base: 500, max: 60_000 });
  const sessions = store.ns("sessions");

  const configured = () => !!cfg.secret;

  function tokenFromCookie(header) {
    const m = String(header || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})(?:;|$)`));
    return m ? m[1] : null;
  }

  async function login(ip, provided) {
    if (!configured()) throw new AppError("not_configured", "لوحة التحكم غير مهيأة: اضبط DASHBOARD_PASSWORD");
    const wait = Math.max(ipBackoff.retryAfterMs(`ip:${ip}`), acctBackoff.retryAfterMs(ACCOUNT));
    if (wait > 0)
      throw new AppError("rate_limited", "محاولات كثيرة، انتظر ثم أعد المحاولة", { meta: { retryAfterMs: wait } });
    if (!safeEqual(String(provided ?? ""), cfg.secret)) {
      ipBackoff.fail(`ip:${ip}`);
      acctBackoff.fail(ACCOUNT);
      throw new AppError("invalid_credentials", "كلمة المرور غير صحيحة");
    }
    ipBackoff.reset(`ip:${ip}`);
    acctBackoff.reset(ACCOUNT);
    await purgeExpired();
    const token = randomBytes(32).toString("hex");
    const t = now();
    await sessions.set(sha(token), { c: t, l: t });
    return token;
  }

  async function purgeExpired() {
    const t = now();
    for (const [k, s] of await sessions.list())
      if (t - s.c > SESSION_ABSOLUTE_MS || t - s.l > SESSION_IDLE_MS) await sessions.del(k);
  }

  async function check(token) {
    if (!token || !TOKEN_RE.test(token)) return false;
    const key = sha(token);
    const s = await sessions.get(key);
    if (!s) return false;
    const t = now();
    if (t - s.c > SESSION_ABSOLUTE_MS || t - s.l > SESSION_IDLE_MS) {
      await sessions.del(key);
      return false;
    }
    if (t - s.l > 60_000) await sessions.set(key, { c: s.c, l: t });
    return true;
  }

  async function logout(token) {
    if (token && TOKEN_RE.test(token)) await sessions.del(sha(token));
  }

  function cookie(token, secure, clear = false) {
    const maxAge = clear ? 0 : Math.floor(SESSION_ABSOLUTE_MS / 1000);
    return `${COOKIE}=${clear ? "" : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  }

  return { configured, login, check, logout, cookie, tokenFromCookie, source: cfg.source };
}
