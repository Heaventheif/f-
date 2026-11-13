// LRU bounded by entry count AND total bytes; optional TTL.
export class LRU {
  constructor({ maxEntries = 500, maxBytes = 64 * 1024 * 1024, ttlMs = 0, now = Date.now } = {}) {
    Object.assign(this, { maxEntries, maxBytes, ttlMs, now });
    this.map = new Map();
    this.bytes = 0;
  }
  static sizeOf(v) {
    if (v == null) return 1;
    if (typeof v === "string") return v.length * 2;
    if (v.byteLength != null) return v.byteLength;
    try { return JSON.stringify(v).length * 2; } catch { return 1024; }
  }
  get(k) {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp && e.exp < this.now()) { this.delete(k); return undefined; }
    this.map.delete(k); this.map.set(k, e);
    return e.v;
  }
  set(k, v, ttlMs = this.ttlMs) {
    this.delete(k);
    const size = LRU.sizeOf(v);
    if (size > this.maxBytes) return false;
    this.map.set(k, { v, size, exp: ttlMs ? this.now() + ttlMs : 0 });
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.delete(this.map.keys().next().value);
    }
    return true;
  }
  delete(k) {
    const e = this.map.get(k);
    if (!e) return false;
    this.bytes -= e.size;
    return this.map.delete(k);
  }
  sweep() {
    const t = this.now();
    let n = 0;
    for (const [k, e] of this.map) if (e.exp && e.exp < t) { this.delete(k); n++; }
    return n;
  }
  get size() { return this.map.size; }
}
