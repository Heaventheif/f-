"use strict";
global._bannedGroups = new Set();
global._bannedUsers = new Set();
function buildBanSets() {
  global._bannedGroups = new Set((global.config.bannedGroups || []).map(String));
  global._bannedUsers = new Set((global.config.bannedUsers || []).map(String));
}
function isBanned(threadID, senderID) {
  if (threadID !== undefined && global._bannedGroups.has(String(threadID))) return true;
  if (senderID !== undefined && global._bannedUsers.has(String(senderID))) return true;
  return false;
}
function isGroupUnbanRequest(event) {
  if (!event?.isGroup || !String(event.body ?? "").trim()) return false;
  const words = String(event.body).trim().split(/\s+/).map(v => v.toLowerCase());
  words[0] = words[0].replace(/^[.!#/]+/, "");
  const isUnban = (words[0] === "ban" && ["ungroup", "unblock-group", "unban-group"].includes(words[1])) ||
    (["المجموعة", "جروب"].includes(words[0]) && ["unban", "unblock", "رفع-الحظر", "رفعالحظر"].includes(words[1]));
  if (!isUnban) return false;
  const role = global.getUserRole?.(event.senderID, event.api?._botIndex ?? null) ?? 0;
  return role >= 2;
}
global.isBanned = isBanned;
export { buildBanSets, isBanned, isGroupUnbanRequest };

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-utils-ban-list',
  meta: { category: 'utils', path: 'src/utils/banList.js' },
  setup(_ctx) {
    // provides: buildBanSets, isBanned
  },
};
