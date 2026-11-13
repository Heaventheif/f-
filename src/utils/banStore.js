"use strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getStore } from "../state/kv.js";
import { AppError } from "../infra/errors.js";
import { ensurePostgresSchema } from "./postgres.js";

const LEGACY_FILE =
  process.env.BANS_FILE ||
  path.join(process.env.STATE_DIR || path.resolve(process.cwd(), "data"), "bans.json");
const SETS = { user: "_bannedUsers", group: "_bannedGroups" };
let _ns = null;
// Test hook: inject a fake kv namespace.
export function _useNamespace(ns) {
  _ns = ns;
}
async function ns() {
  return (_ns ??= (await getStore()).ns("bans"));
}
function applyRow(kind, id, banned) {
  const set = global[SETS[kind]];
  if (!set || !id) return;
  if (banned) set.add(String(id));
  else set.delete(String(id));
}
async function legacyRows() {
  try {
    const db = await ensurePostgresSchema();
    if (db) return (await db.query("SELECT kind, id, banned, actor FROM sunkenbot_bans")).rows;
  } catch {}
  try {
    const raw = JSON.parse(await readFile(LEGACY_FILE, "utf8"));
    return Array.isArray(raw?.rows) ? raw.rows : [];
  } catch {
    return [];
  }
}
export async function loadBans() {
  const store = await ns();
  let entries = await store.list();
  if (entries.length === 0) {
    // One-time import of pre-kv ban rows.
    for (const r of await legacyRows()) {
      if (SETS[r.kind] && r.id)
        await store.set(`${r.kind}:${r.id}`, { banned: !!r.banned, actor: r.actor ?? null });
    }
    entries = await store.list();
  }
  for (const [key, v] of entries) {
    const i = key.indexOf(":");
    applyRow(key.slice(0, i), key.slice(i + 1), !!v?.banned);
  }
  console.log(
    `[BANS] ✅ استُعيد ${entries.length} سجل حظر | مستخدمون: ${global._bannedUsers?.size ?? 0} | مجموعات: ${global._bannedGroups?.size ?? 0}`,
  );
}
// Durable write; THROWS on failure so callers never change memory alone.
export async function persistBanChange(kind, id, banned, actor) {
  if (!SETS[kind] || !id) throw new AppError("bad_args", "invalid ban target");
  try {
    await (await ns()).set(`${kind}:${String(id)}`, {
      banned: !!banned,
      actor: actor == null ? null : String(actor),
      at: new Date().toISOString(),
    });
    return true;
  } catch (e) {
    throw new AppError("state_failed", "ban not persisted", { cause: e });
  }
}
// Persist first, then update the in-memory set.
export async function setBan(kind, id, banned, actor) {
  await persistBanChange(kind, id, banned, actor);
  applyRow(kind, id, !!banned);
  return true;
}
