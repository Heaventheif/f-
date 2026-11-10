"use strict";
import { timingSafeEqual, createHash } from "node:crypto";
import path from "node:path";

// رؤوس أمان موحّدة (CSP / clickjacking / sniffing)
export const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
});
export function withSecurityHeaders(res, { skip = [] } = {}) {
  try { for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!skip.includes(k) && !res.headers.has(k)) res.headers.set(k, v); } catch { /* immutable headers */ }
  return res;
}

// مقارنة PIN بزمن ثابت بغض النظر عن الطول (تجزئة ثم timingSafeEqual)
export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = createHash("sha256").update(a).digest(), hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

// قفل تصاعدي لمحاولات تسجيل الدخول الفاشلة لكل IP
export function makeLoginLockout({ free = 5, baseMs = 30000, maxMs = 3600000, max = 5000, now = Date.now } = {}) {
  const m = new Map();
  return {
    check(key) { const r = m.get(key); const left = r ? r.until - now() : 0; return left > 0 ? left : 0; },
    fail(key) {
      if (m.size >= max) m.delete(m.keys().next().value);
      const r = m.get(key) || { n: 0, until: 0 }; r.n++;
      if (r.n > free) r.until = now() + Math.min(maxMs, baseMs * 2 ** (r.n - free - 1));
      m.delete(key); m.set(key, r); return r.n;
    },
    ok(key) { m.delete(key); },
    size: () => m.size,
  };
}

// حماية Prototype Pollution
const BAD = new Set(["__proto__", "constructor", "prototype"]);
export function safeMerge(target, src, depth = 0) {
  if (!src || typeof src !== "object" || depth > 8) return target;
  for (const k of Object.keys(src)) {
    if (BAD.has(k)) continue;
    const v = src[k];
    if (v && typeof v === "object" && !Array.isArray(v)) target[k] = safeMerge(Object.hasOwn(target, k) && typeof target[k] === "object" ? target[k] : {}, v, depth + 1);
    else target[k] = v;
  }
  return target;
}
export function safeJsonParse(text, { maxLen = 1_000_000 } = {}) {
  if (typeof text !== "string" || text.length > maxLen) return null;
  try { return JSON.parse(text, (k, v) => (BAD.has(k) ? undefined : v)); } catch { return null; }
}

// Path traversal: يرجع المسار المحلول فقط إن كان داخل الجذر
export function resolveInside(root, ...parts) {
  const base = path.resolve(root), full = path.resolve(base, ...parts);
  return full === base || full.startsWith(base + path.sep) ? full : null;
}
export function clampInput(s, max = 2000) { return String(s ?? "").slice(0, max); }
