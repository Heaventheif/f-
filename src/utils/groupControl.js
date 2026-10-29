"use strict";

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const pausedGroups = new Set();
const disabledCommands = new Map();
let writeQueue = Promise.resolve();

function stateFilePath() {
  const configured = String(process.env.GROUP_CONTROL_FILE || "").trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.env.STATE_DIR || path.resolve(process.cwd(), "data"), "group-controls.json");
}

function normalizeId(value) {
  if (value === null || value === undefined) return null;
  const id = String(value).trim();
  return id ? id : null;
}

function snapshot() {
  const disabled = {};
  for (const [groupID, names] of disabledCommands) {
    if (names.size) disabled[groupID] = [...names].sort();
  }
  return {
    version: 1,
    pausedGroups: [...pausedGroups].sort(),
    disabledCommands: disabled
  };
}

async function readPostgresState() {
  if (!String(process.env.DATABASE_URL || "").trim()) return { available: false, payload: null };
  try {
    const { ensurePostgresSchema } = await import("./postgres.js");
    const db = await ensurePostgresSchema();
    if (!db) return { available: false, payload: null };
    const result = await db.query("SELECT payload FROM sunkenbot_group_controls WHERE id = 1");
    return { available: true, payload: result.rows?.[0]?.payload ?? null };
  } catch (error) {
    console.warn("[GROUP CONTROL] تعذّرت قراءة PostgreSQL؛ سيُستخدم الملف المحلي:", error?.code || error?.message || error);
    return { available: false, payload: null };
  }
}

async function writePostgresState(contents) {
  if (!String(process.env.DATABASE_URL || "").trim()) return false;
  try {
    const { ensurePostgresSchema } = await import("./postgres.js");
    const db = await ensurePostgresSchema();
    if (!db) return false;
    await db.query(`INSERT INTO sunkenbot_group_controls (id, payload, updated_at)
      VALUES (1, $1::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`, [contents]);
    return true;
  } catch (error) {
    console.warn("[GROUP CONTROL] تعذّر حفظ PostgreSQL؛ سيُستخدم الملف المحلي:", error?.code || error?.message || error);
    return false;
  }
}

function persistState() {
  const contents = JSON.stringify(snapshot(), null, 2);
  const destination = stateFilePath();
  const write = async () => {
    if (await writePostgresState(contents)) return;
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, destination);
  };
  const current = writeQueue.then(write, write);
  writeQueue = current.catch(() => {});
  return current.then(
    () => true,
    error => {
      console.error("[GROUP CONTROL] تعذّر حفظ الحالة:", error?.message || error);
      return false;
    }
  );
}

function validStoredId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function restoreState(value) {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  if (Array.isArray(parsed.pausedGroups)) {
    for (const id of parsed.pausedGroups) {
      if (validStoredId(id)) pausedGroups.add(id);
    }
  }
  if (parsed.disabledCommands && typeof parsed.disabledCommands === "object" && !Array.isArray(parsed.disabledCommands)) {
    for (const [groupID, names] of Object.entries(parsed.disabledCommands)) {
      if (!validStoredId(groupID) || !Array.isArray(names)) continue;
      const validNames = new Set(names
        .filter(validStoredId)
        .map(name => name.trim().toLowerCase()));
      if (validNames.size) disabledCommands.set(groupID, validNames);
    }
  }
  return true;
}

export async function loadGroupControlState() {
  pausedGroups.clear();
  disabledCommands.clear();
  const database = await readPostgresState();
  if (database.payload != null) {
    try {
      if (restoreState(database.payload)) return true;
    } catch (error) {
      console.warn("[GROUP CONTROL] بيانات PostgreSQL غير صالحة؛ ستُستخدم النسخة المحلية:", error?.message || error);
    }
  }
  try {
    const contents = await readFile(stateFilePath(), "utf8");
    const restored = restoreState(contents);
    if (restored && database.available) await persistState();
    return restored;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("[GROUP CONTROL] حالة محفوظة غير مقروءة؛ بدء التشغيل بحالة فارغة:", error?.message || error);
    }
    return false;
  }
}

export function isGroupPaused(groupID) {
  const id = normalizeId(groupID);
  return id !== null && pausedGroups.has(id);
}

export function isCommandDisabled(groupID, commandID) {
  const id = normalizeId(groupID);
  const command = normalizeId(commandID)?.toLowerCase();
  return id !== null && command !== null && (disabledCommands.get(id)?.has(command) ?? false);
}

export async function setGroupPaused(groupID, paused) {
  const id = normalizeId(groupID);
  if (!id) return { changed: false, persisted: false };
  const had = pausedGroups.has(id);
  if (had === Boolean(paused)) return { changed: false, persisted: true };
  if (paused) pausedGroups.add(id);
  else pausedGroups.delete(id);
  return { changed: true, persisted: await persistState() };
}

export async function setCommandDisabled(groupID, commandID, disabled) {
  const id = normalizeId(groupID);
  const command = normalizeId(commandID)?.toLowerCase();
  if (!id || !command) return { changed: false, persisted: false };
  let names = disabledCommands.get(id);
  const had = names?.has(command) ?? false;
  if (had === Boolean(disabled)) return { changed: false, persisted: true };
  if (disabled) {
    if (!names) {
      names = new Set();
      disabledCommands.set(id, names);
    }
    names.add(command);
  } else if (names) {
    names.delete(command);
    if (!names.size) disabledCommands.delete(id);
  }
  return { changed: true, persisted: await persistState() };
}

export function resolveCommandId(name, commands = global.commands) {
  const key = normalizeId(name)?.toLowerCase();
  if (!key || !commands || typeof commands.get !== "function") return null;
  const command = commands.get(key);
  if (!command || !command.config || typeof command.config !== "object") return null;
  const canonical = normalizeId(command.config.name)?.toLowerCase();
  return canonical ? { id: canonical, command } : null;
}

export function parseRoutedCommand(body) {
  const text = String(body ?? "").trim();
  if (!text) return null;
  const prefixes = (global.config?.Prefix || [""]).map(String).sort((a, b) => b.length - a.length);
  let resolvedText = null;
  for (const prefix of prefixes) {
    if (prefix === "" || text.startsWith(prefix)) {
      resolvedText = prefix ? text.slice(prefix.length).trim() : text;
      break;
    }
  }
  if (resolvedText === null) return null;
  const parts = resolvedText.split(/\s+/).filter(Boolean);
  return parts.length ? { name: parts[0].toLowerCase(), args: parts.slice(1) } : null;
}

export function isBotResumeRequest(event, botIndex = null) {
  if (event?.isGroup !== true || !normalizeId(event.threadID)) return false;
  if (!["message", "message_reply"].includes(event.type)) return false;
  if (!normalizeId(event.senderID)) return false;
  const parsed = parseRoutedCommand(event.body);
  if (!parsed || parsed.name !== "on" || parsed.args.length !== 1 || parsed.args[0].toLowerCase() !== "bot") return false;
  try {
    return (global.getUserRole?.(event.senderID, botIndex) ?? 0) >= 2;
  } catch {
    return false;
  }
}

export function isGroupControlRequest(event, botIndex = null) {
  if (event?.isGroup !== true || !normalizeId(event.threadID) || !normalizeId(event.senderID)) return false;
  const parsed = parseRoutedCommand(event.body);
  if (!parsed || !["off", "on"].includes(parsed.name)) return false;
  try {
    return (global.getUserRole?.(event.senderID, botIndex) ?? 0) >= 2;
  } catch {
    return false;
  }
}
