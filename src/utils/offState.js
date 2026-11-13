"use strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ensurePostgresSchema } from "./postgres.js";
import { getStore } from "../state/kv.js";
const STATE_FILE =
  process.env.OFF_STATE_FILE ||
  path.join(process.env.STATE_DIR || path.resolve(process.cwd(), "data"), "off-state.json");
const BOT_SCOPE = "*";
const MAX_ID_LEN = 64;
const _botOff = new Set();
const _cmdOff = new Map();
const asId = (v) => {
  const s = String(v ?? "").trim();
  return s && s.length <= MAX_ID_LEN ? s : null;
};
export function commandKey(command) {
  const name = typeof command === "string" ? command : command?.config?.name;
  const key = String(name ?? "")
    .trim()
    .toLowerCase();
  return key || null;
}
export function isBotOff(threadID) {
  return _botOff.size !== 0 && _botOff.has(String(threadID));
}
export function isCommandOff(threadID, command) {
  if (_cmdOff.size === 0) return false;
  const set = _cmdOff.get(String(threadID));
  if (!set) return false;
  const key = commandKey(command);
  return key !== null && set.has(key);
}
export function getThreadOffState(threadID) {
  const tid = String(threadID);
  return { botOff: _botOff.has(tid), commands: [...(_cmdOff.get(tid) ?? [])].sort() };
}
function applyBot(tid, off) {
  const had = _botOff.has(tid);
  if (off === had) return false;
  if (off) _botOff.add(tid);
  else _botOff.delete(tid);
  return true;
}
function applyCmd(tid, key, off) {
  let set = _cmdOff.get(tid);
  const had = !!set?.has(key);
  if (off === had) return false;
  if (off) {
    if (!set) _cmdOff.set(tid, (set = new Set()));
    set.add(key);
  } else {
    set.delete(key);
    if (set.size === 0) _cmdOff.delete(tid);
  }
  return true;
}
let _ns = null;
export function _useNamespace(ns) {
  _ns = ns;
}
async function ns() {
  return (_ns ??= (await getStore()).ns("off_state"));
}
// Per-thread record: { bot: boolean, cmds: string[] } persisted atomically.
function threadRecord(tid) {
  return { bot: _botOff.has(tid), cmds: [...(_cmdOff.get(tid) ?? [])] };
}
async function persistThread(tid, rec) {
  try {
    const store = await ns();
    if (!rec.bot && rec.cmds.length === 0) await store.del(tid);
    else await store.set(tid, rec);
    return true;
  } catch (e) {
    console.error("[OFF] ⚠️ لم تُحفظ الحالة (تبقى في الذاكرة فقط):", e?.message || e);
    return false;
  }
}
// Applies in memory then persists the resulting per-thread record; the
// result reports persistence so callers can warn the user.
async function change(tid, apply) {
  if (!apply()) return { changed: false, persisted: true };
  return { changed: true, persisted: await persistThread(tid, threadRecord(tid)) };
}
export async function setBotOff(threadID, off) {
  const tid = asId(threadID);
  if (!tid) return { changed: false, persisted: true };
  return change(tid, () => applyBot(tid, !!off));
}
export async function setCommandOff(threadID, command, off) {
  const tid = asId(threadID);
  const key = commandKey(command);
  if (!tid || !key || key === BOT_SCOPE) return { changed: false, persisted: true };
  return change(tid, () => applyCmd(tid, key, !!off));
}
function loadRow(tid, scope) {
  const t = asId(tid);
  const s = asId(scope);
  if (!t || !s) return;
  if (s === BOT_SCOPE) applyBot(t, true);
  else applyCmd(t, s.toLowerCase(), true);
}
async function legacyRows() {
  const rows = [];
  try {
    const db = await ensurePostgresSchema();
    if (db) {
      for (const r of (await db.query("SELECT thread_id, scope FROM sunkenbot_off_state")).rows)
        rows.push([r.thread_id, r.scope]);
      return rows;
    }
  } catch {}
  try {
    const raw = JSON.parse(await readFile(STATE_FILE, "utf8"));
    for (const tid of Array.isArray(raw?.bot) ? raw.bot : []) rows.push([tid, BOT_SCOPE]);
    for (const [tid, list] of Object.entries(raw?.cmds ?? {}))
      if (Array.isArray(list)) for (const k of list) rows.push([tid, k]);
  } catch {}
  return rows;
}
export async function loadOffState() {
  const store = await ns();
  let entries = await store.list();
  if (entries.length === 0) {
    // One-time import of pre-kv state.
    for (const [tid, scope] of await legacyRows()) loadRow(tid, scope);
    for (const tid of new Set([..._botOff, ..._cmdOff.keys()])) await persistThread(tid, threadRecord(tid));
  } else {
    for (const [tid, rec] of entries) {
      if (rec?.bot) loadRow(tid, BOT_SCOPE);
      for (const k of rec?.cmds ?? []) loadRow(tid, k);
    }
  }
  let cmdCount = 0;
  for (const s of _cmdOff.values()) cmdCount += s.size;
  console.log(
    `[OFF] ✅ استُعيدت الحالات | مجموعات موقوفة: ${_botOff.size} | أوامر معطّلة: ${cmdCount}`,
  );
}
export function isBotRestoreRequest(event, api) {
  if (!event?.isGroup) return false;
  let text = String(event.body ?? "").trim();
  if (!text) return false;
  const prefixes = (global.config?.Prefix || [""]).map(String).sort((a, b) => b.length - a.length);
  for (const pfx of prefixes) {
    if (pfx === "" || text.startsWith(pfx)) {
      text = pfx ? text.slice(pfx.length).trim() : text;
      break;
    }
  }
  const words = text.toLowerCase().split(/\s+/);
  if (words.length !== 2 || words[0] !== "on" || words[1] !== "bot") return false;
  const role = global.getUserRole?.(event.senderID, api?.__botIndex ?? null) ?? 0;
  if (role >= 2) return true;
  const devs = (global.config?.developers || []).map(String);
  return devs.includes(String(event.senderID));
}
export function isGroupControlRequest(event, botIndex = null) {
  if (!event?.isGroup || !asId(event.threadID) || !asId(event.senderID)) return false;
  if (event.type && !["message", "message_reply"].includes(event.type)) return false;
  let text = String(event.body ?? "").trim();
  if (!text) return false;
  const prefixes = (global.config?.Prefix || [""]).map(String).sort((a, b) => b.length - a.length);
  let matched = false;
  for (const prefix of prefixes) {
    if (prefix === "" || text.startsWith(prefix)) {
      text = prefix ? text.slice(prefix.length).trim() : text;
      matched = true;
      break;
    }
  }
  if (!matched) return false;
  const [name] = text.toLowerCase().split(/\s+/);
  if (name !== "off" && name !== "on") return false;
  const role = global.getUserRole?.(event.senderID, botIndex) ?? 0;
  return role >= 2;
}
