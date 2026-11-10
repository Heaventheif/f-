"use strict";
// retry موحّد: exponential backoff + jitter + circuit breaker لكل خدمة خارجية.
export const ErrorClass = Object.freeze({
  NETWORK: "NETWORK", RATE_LIMITED: "RATE_LIMITED", AUTH_FAILED: "AUTH_FAILED",
  SEND_STOPPED: "SEND_STOPPED", QUEUE_FULL: "QUEUE_FULL", CIRCUIT_OPEN: "CIRCUIT_OPEN", UNKNOWN: "UNKNOWN",
});

export function classifyError(e) {
  const msg = String(e?.message || e || ""), code = e?.code || e?.cause?.code, status = e?.status ?? e?.statusCode;
  if (e?.name === "SendStopped" || /SEND_STOPPED/.test(msg)) return ErrorClass.SEND_STOPPED;
  if (e?.errorClass === ErrorClass.CIRCUIT_OPEN) return ErrorClass.CIRCUIT_OPEN;
  if (status === 429 || /rate.?limit|too many/i.test(msg)) return ErrorClass.RATE_LIMITED;
  if (status === 401 || status === 403 || /AUTH_FAILED|unauthori[sz]ed/i.test(msg)) return ErrorClass.AUTH_FAILED;
  if (/QUEUE_FULL/.test(msg)) return ErrorClass.QUEUE_FULL;
  if (["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "EPIPE"].includes(code) ||
      e?.name === "TimeoutError" || e?.name === "AbortError" || /fetch failed|network|timeout/i.test(msg)) return ErrorClass.NETWORK;
  return ErrorClass.UNKNOWN;
}
const RETRYABLE = new Set([ErrorClass.NETWORK, ErrorClass.RATE_LIMITED]);

export function backoffDelay(attempt, base = 500, max = 15000, rand = Math.random) {
  const exp = Math.min(max, base * 2 ** attempt);
  return Math.floor(exp / 2 + rand() * (exp / 2)); // equal jitter
}

export class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 30000, now = Date.now } = {}) {
    Object.assign(this, { threshold, cooldownMs, now, failures: 0, openedAt: 0, state: "CLOSED" });
  }
  canPass() {
    if (this.state === "OPEN") {
      if (this.now() - this.openedAt >= this.cooldownMs) { this.state = "HALF_OPEN"; return true; }
      return false;
    }
    return true;
  }
  success() { this.failures = 0; this.state = "CLOSED"; }
  failure() {
    this.failures++;
    if (this.state === "HALF_OPEN" || this.failures >= this.threshold) { this.state = "OPEN"; this.openedAt = this.now(); }
  }
}
const breakers = new Map();
export function getBreaker(name, opts) {
  let b = breakers.get(name);
  if (!b) { b = new CircuitBreaker(opts); breakers.set(name, b); }
  return b;
}

export async function withRetry(fn, { service = "default", retries = 3, base = 500, max = 15000, sleep = ms => new Promise(r => setTimeout(r, ms)), breaker = getBreaker(service) } = {}) {
  if (process.env.RETRY_DISABLED === "1") return fn(0);
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (!breaker.canPass()) { const e = new Error(`[${service}] circuit open`); e.errorClass = ErrorClass.CIRCUIT_OPEN; throw e; }
    try { const r = await fn(attempt); breaker.success(); return r; }
    catch (e) {
      last = e; const cls = classifyError(e); e.errorClass ??= cls;
      if (cls === ErrorClass.NETWORK || cls === ErrorClass.RATE_LIMITED) breaker.failure();
      if (!RETRYABLE.has(cls) || attempt === retries) throw e;
      await sleep(backoffDelay(attempt, base, max));
    }
  }
  throw last;
}
