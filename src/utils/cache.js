"use strict";
const _store      = new Map();
const MAX_ENTRIES = 1500;
let _pm = null;
function _bridgePerfManager(pm) {
  _pm = pm;
}
function get(key) {
  const entry = _store.get(key);
  if (!entry) {
    _pm?.get?.(`__miss__${key}`);
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    _store.delete(key);
    _pm?.get?.(`__miss__${key}`);
    return null;
  }
  entry.gen = (_store._gen = (_store._gen || 0) + 1);
  return entry.value;
}
function set(key, value, ttlMs = 5 * 60 * 1000) {
  if (_store.size >= MAX_ENTRIES && !_store.has(key)) {
    let oldestKey = null;
    let oldestGen = Infinity;
    for (const [k, e] of _store) {
      if (e.gen < oldestGen) { oldestGen = e.gen; oldestKey = k; }
    }
    if (oldestKey) _store.delete(oldestKey);
  }
  _store.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
    gen: (_store._gen = (_store._gen || 0) + 1),
  });
  return value;
}
function del(key) { _store.delete(key); }
function sweep() {
  const now     = Date.now();
  let   removed = 0;
  for (const [key, entry] of _store) {
    if (now > entry.expiresAt) { _store.delete(key); removed++; }
  }
  return removed;
}
function size() { return _store.size; }
export { get, set, del, sweep, size, _bridgePerfManager };
export default { get, set, del, sweep, size, _bridgePerfManager };
