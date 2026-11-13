"use strict";
import { getStore } from "../state/kv.js";
const LIMIT = 200;
const recentlySet = new Set();
let hydrated = false;
let _ns = null;
export function _useNamespace(ns) {
  _ns = ns;
}
async function ns() {
  return (_ns ??= (await getStore()).ns("recently_sent"));
}
// Sync API kept: memory is authoritative, storage is loaded/merged in background.
function hydrateRecentlySent() {
  if (hydrated) return;
  hydrated = true;
  ns()
    .then((n) => n.get("list"))
    .then((saved) => {
      if (!Array.isArray(saved)) return;
      const current = [...recentlySet];
      recentlySet.clear();
      for (const key of [...saved, ...current]) recentlySet.add(key);
      trim();
    })
    .catch((e) => console.warn("[RECENT] load failed:", e?.message));
}
function trim() {
  while (recentlySet.size > LIMIT) recentlySet.delete(recentlySet.values().next().value);
}
let _saving = false;
let _again = false;
async function save() {
  if (_saving) {
    _again = true;
    return;
  }
  _saving = true;
  try {
    do {
      _again = false;
      await (await ns()).set("list", [...recentlySet]);
    } while (_again);
  } catch (e) {
    console.warn("[RECENT] save failed:", e?.message);
  } finally {
    _saving = false;
  }
}
function hasRecentlySent(key) {
  hydrateRecentlySent();
  return recentlySet.has(key);
}
function rememberSent(key) {
  if (!key) return;
  hydrateRecentlySent();
  recentlySet.delete(key);
  recentlySet.add(key);
  trim();
  void save();
}
export { recentlySet, hydrateRecentlySent, hasRecentlySent, rememberSent };
