"use strict";

// Shared "recently sent media" store used by `random` and `fyp` so the same
// TikTok/Tumblr item is not served twice by either command.
// Keys keep the existing format (e.g. `tiktok:<url>`), and persistence keeps
// the existing globalData key so previously saved entries are still honoured.
const STORE_KEY = "random_recentlySent";
const LIMIT = 200;

const recentlySet = new Set();
let hydrated = false;

function hydrateRecentlySent() {
  if (hydrated) return;
  hydrated = true;
  const saved = global.globalData?.get?.(STORE_KEY);
  if (Array.isArray(saved)) for (const key of saved) recentlySet.add(key);
}

function hasRecentlySent(key) {
  hydrateRecentlySent();
  return recentlySet.has(key);
}

function rememberSent(key) {
  if (!key) return;
  hydrateRecentlySent();
  recentlySet.delete(key); // refresh position so eviction is least-recently-sent
  recentlySet.add(key);
  while (recentlySet.size > LIMIT) {
    recentlySet.delete(recentlySet.values().next().value);
  }
  global.globalData?.set?.(STORE_KEY, [...recentlySet]);
}

export { recentlySet, hydrateRecentlySent, hasRecentlySent, rememberSent };
