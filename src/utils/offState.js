"use strict";

import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { ensurePostgresSchema } from "./postgres.js";

const STATE_FILE =
  process.env.OFF_STATE_FILE ||
  path.join(process.env.STATE_DIR || path.resolve(process.cwd(), "data"), "off-state.json");

const BOT_SCOPE = "*"; // رمز إيقاف البوت في جدول Postgres (لا يتعارض مع أسماء الأوامر)
const MAX_ID_LEN = 64;

const _botOff = new Set();
const _cmdOff = new Map();

const asId = (v) => {
  const s = String(v ?? "").trim();
  return s && s.length <= MAX_ID_LEN ? s : null;
};

export function commandKey(command) {
  const name = typeof command === "string" ? command : command?.config?.name;
  const key = String(name ?? "").trim().toLowerCase();
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
  return { botOff: _botOff.has(tid), commands: [..._cmdOff.get(tid) ?? []].sort() };
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

let _queue = Promise.resolve(); // يُسلسل الكتابات فلا تتداخل أو تتعاكس

function snapshot() {
  const cmds = {};
  for (const [tid, set] of _cmdOff) cmds[tid] = [...set];
  return { bot: [..._botOff], cmds };
}

async function writeFileSnapshot() {
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await mkdir(path.dirname(STATE_FILE), { recursive: true });
  await writeFile(tmp, JSON.stringify(snapshot()), "utf8");
  await rename(tmp, STATE_FILE);
}

async function persistOp(tid, scope, off) {
  try {
    const db = await ensurePostgresSchema();
    if (db) {
      if (off) {
        await db.query(
          "INSERT INTO sunkenbot_off_state (thread_id, scope) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [tid, scope],
        );
      } else {
        await db.query("DELETE FROM sunkenbot_off_state WHERE thread_id = $1 AND scope = $2", [tid, scope]);
      }
      return true;
    }
  } catch (e) {
    console.warn("[OFF] تعذر الحفظ في PostgreSQL، سيُستخدم الملف المحلي:", e?.code || e?.message || e);
  }
  try {
    await writeFileSnapshot();
    return true;
  } catch (e) {
    console.error("[OFF] ⚠️ لم تُحفظ الحالة (تبقى في الذاكرة فقط):", e?.message || e);
    return false;
  }
}

function persist(tid, scope, off) {
  const run = _queue.then(() => persistOp(tid, scope, off));
  _queue = run.catch(() => false);
  return run;
}

export async function setBotOff(threadID, off) {
  const tid = asId(threadID);
  if (!tid) return { changed: false, persisted: true };
  if (!applyBot(tid, !!off)) return { changed: false, persisted: true };
  return { changed: true, persisted: await persist(tid, BOT_SCOPE, !!off) };
}

export async function setCommandOff(threadID, command, off) {
  const tid = asId(threadID);
  const key = commandKey(command);
  if (!tid || !key || key === BOT_SCOPE) return { changed: false, persisted: true };
  if (!applyCmd(tid, key, !!off)) return { changed: false, persisted: true };
  return { changed: true, persisted: await persist(tid, key, !!off) };
}

function loadRow(tid, scope) {
  const t = asId(tid);
  const s = asId(scope);
  if (!t || !s) return;
  if (s === BOT_SCOPE) applyBot(t, true);
  else applyCmd(t, s.toLowerCase(), true);
}

export async function loadOffState() {
  let loaded = false;
  try {
    const db = await ensurePostgresSchema();
    if (db) {
      const { rows } = await db.query("SELECT thread_id, scope FROM sunkenbot_off_state");
      for (const r of rows) loadRow(r.thread_id, r.scope);
      loaded = true;
    }
  } catch (e) {
    console.warn("[OFF] تعذر القراءة من PostgreSQL:", e?.code || e?.message || e);
  }
  if (!loaded) {
    try {
      const raw = JSON.parse(await readFile(STATE_FILE, "utf8"));
      if (Array.isArray(raw?.bot)) for (const tid of raw.bot) loadRow(tid, BOT_SCOPE);
      if (raw?.cmds && typeof raw.cmds === "object") {
        for (const [tid, list] of Object.entries(raw.cmds)) {
          if (Array.isArray(list)) for (const k of list) loadRow(tid, k);
        }
      }
    } catch (e) {
      if (e?.code !== "ENOENT") console.warn("[OFF] ملف الحالة غير صالح، سيُتجاهل:", e?.message || e);
    }
  }
  let cmdCount = 0;
  for (const s of _cmdOff.values()) cmdCount += s.size;
  console.log(`[OFF] ✅ استُعيدت الحالات | مجموعات موقوفة: ${_botOff.size} | أوامر معطّلة: ${cmdCount}`);
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
  return role >= 2;
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
