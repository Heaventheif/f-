"use strict";
import { LRU } from "../infra/lru.js";
// Shared in-memory cache bounded by entries AND bytes, with per-entry TTL.
const _lru = new LRU({ maxEntries: 1500, maxBytes: 64 * 1024 * 1024, ttlMs: 5 * 60 * 1e3 });
function get(key) {
  const v = _lru.get(key);
  return v === undefined ? null : v;
}
function set(key, value, ttlMs = 5 * 60 * 1e3) {
  _lru.set(key, value, ttlMs);
  return value;
}
function del(key) {
  _lru.delete(key);
}
function sweep() {
  return _lru.sweep();
}
function size() {
  return _lru.size;
}
export { get, set, del, sweep, size };
export default { get, set, del, sweep, size };
