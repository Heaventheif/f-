// Concurrency + rate primitives shared by every command.
export class Semaphore {
  constructor(max) { this.max = max; this.active = 0; this.queue = []; }
  async run(fn) {
    if (this.active >= this.max) await new Promise((r) => this.queue.push(r));
    this.active++;
    try { return await fn(); }
    finally { this.active--; this.queue.shift()?.(); }
  }
}
// Serialize async work per key (read-modify-write safety).
export class KeyedMutex {
  constructor() { this.tails = new Map(); }
  run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }
}
// Share one in-flight promise per key.
export class SingleFlight {
  constructor() { this.inflight = new Map(); }
  run(key, fn) {
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = Promise.resolve().then(fn).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }
}
// Sliding-window limiter: allow(key) -> {ok, retryAfterMs}
export class RateLimiter {
  constructor({ max, windowMs, now = Date.now, maxKeys = 5000 }) {
    Object.assign(this, { max, windowMs, now, maxKeys });
    this.hits = new Map();
  }
  allow(key) {
    const t = this.now();
    const arr = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterMs: this.windowMs - (t - arr[0]) };
    }
    arr.push(t);
    this.hits.delete(key);
    this.hits.set(key, arr);
    if (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value);
    return { ok: true, retryAfterMs: 0 };
  }
}
// Circuit breaker for fallback chains.
export class Breaker {
  constructor({ failures = 3, openMs = 60000, now = Date.now } = {}) {
    Object.assign(this, { failures, openMs, now });
    this.state = new Map();
  }
  isOpen(name) {
    const s = this.state.get(name);
    return !!s && s.openUntil > this.now();
  }
  ok(name) { this.state.delete(name); }
  fail(name) {
    const s = this.state.get(name) || { n: 0, openUntil: 0 };
    s.n++;
    if (s.n >= this.failures) { s.openUntil = this.now() + this.openMs; s.n = 0; }
    this.state.set(name, s);
  }
}
// Try providers in order; skip open breakers; aggregate errors.
export async function runWithFallback(providers, call, { breaker = new Breaker(), signal } = {}) {
  const errors = [];
  for (const p of providers) {
    if (signal?.aborted) break;
    const name = p.name || String(p);
    if (breaker.isOpen(name)) continue;
    try {
      const r = await call(p);
      breaker.ok(name);
      return r;
    } catch (e) {
      breaker.fail(name);
      errors.push({ name, error: e });
    }
  }
  const err = new Error("all_providers_failed");
  err.errors = errors;
  throw err;
}
// Run items with bounded concurrency; never rejects (allSettled semantics).
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try { out[idx] = { ok: true, value: await fn(items[idx], idx) }; }
        catch (error) { out[idx] = { ok: false, error }; }
      }
    }),
  );
  return out;
}
