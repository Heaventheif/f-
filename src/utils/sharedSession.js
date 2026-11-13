"use strict";
import { getStore } from "../state/kv.js";
import { KeyedMutex } from "../infra/limiter.js";
import { LRU } from "../infra/lru.js";

const SESSION_TTL_MS = Math.max(
  60_000,
  Number.parseInt(process.env.AI_SESSION_TTL_MS || "", 10) || 30 * 24 * 3600 * 1000,
);
let _ns = null;
export function _useNamespace(ns) {
  _ns = ns;
}
async function ns() {
  return (_ns ??= (await getStore()).ns("ai_sessions", { ttlMs: SESSION_TTL_MS }));
}
// RAM mirror: serves reads if storage is down and holds unsaved writes.
const _ram = new LRU({ maxEntries: 500, maxBytes: 16 * 1024 * 1024, ttlMs: SESSION_TTL_MS });
const _locks = new KeyedMutex();
const ramKey = (collection, id) => `${collection}::${id}`;
let _sweepTimer = null;
function ensureSweep() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(
    async () => {
      try {
        await (await ns()).sweep();
      } catch (e) {
        console.warn("[SESSION] sweep failed:", e?.message);
      }
    },
    6 * 3600 * 1000,
  );
  _sweepTimer.unref?.();
}
export function trimByChars(
  messages,
  maxChars = Number.parseInt(process.env.AI_CTX_MAX_CHARS || "12000", 10) || 12e3,
) {
  if (!Array.isArray(messages) || messages.length <= 1) return messages;
  let total = 0;
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    let len;
    try {
      len = JSON.stringify(messages[i]).length;
    } catch {
      len = 0;
    }
    if (out.length && total + len > maxChars) break;
    total += len;
    out.unshift(messages[i]);
  }
  return out;
}
export async function loadCtx(collectionName, id, limit = 20) {
  const key = ramKey(collectionName, id);
  ensureSweep();
  let value;
  try {
    value = await (await ns()).get(key);
  } catch (error) {
    console.warn(`[SESSION] load failed (${error?.code || error?.message}); using RAM fallback`);
    value = _ram.get(key);
  }
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value.slice(-limit) : value;
}
export async function saveCtx(collectionName, id, messages, limit = 20) {
  const key = ramKey(collectionName, id);
  const sliced = Array.isArray(messages) ? messages.slice(-limit) : messages;
  ensureSweep();
  return _locks.run(key, async () => {
    _ram.set(key, sliced);
    try {
      await (await ns()).set(key, sliced);
      return true;
    } catch (error) {
      console.warn(`[SESSION] save failed (${error?.code || error?.message}); context is only in RAM`);
      return false;
    }
  });
}
export async function clearCtx(collectionName, id) {
  const key = ramKey(collectionName, id);
  return _locks.run(key, async () => {
    _ram.delete(key);
    try {
      await (await ns()).del(key);
      return true;
    } catch (error) {
      console.warn(`[SESSION] delete failed (${error?.code || error?.message})`);
      return false;
    }
  });
}
