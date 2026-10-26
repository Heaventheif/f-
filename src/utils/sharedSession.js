"use strict";
/**
 * sharedSession.js
 * Persistent AI conversation context backed by PostgreSQL/Neon via DATABASE_URL.
 * RAM is a best-effort fallback only and is lost when the process restarts.
 */
import { ensurePostgresSchema } from "./postgres.js";

const _ram = new Map();
const ramKey = (collection, id) => `${collection}::${id}`;

export async function loadCtx(collectionName, id, limit = 20) {
  const key = ramKey(collectionName, id);
  try {
    const db = await ensurePostgresSchema();
    if (db) {
      const result = await db.query(
        "SELECT messages FROM sunkenbot_ai_sessions WHERE collection_name = $1 AND session_id = $2",
        [String(collectionName), String(id)],
      );
      const value = result.rows?.[0]?.messages;
      if (value !== undefined && value !== null) {
        _ram.set(key, value);
        return Array.isArray(value) ? value.slice(-limit) : value;
      }
      return [];
    }
  } catch (error) {
    console.warn(`[SESSION] PostgreSQL load failed (${error?.code || error?.message || "unknown"}); using RAM fallback`);
  }
  return (_ram.get(key) || []).slice(-limit);
}

export async function saveCtx(collectionName, id, messages, limit = 20) {
  const key = ramKey(collectionName, id);
  // Sessions may be either message arrays or small structured state objects.
  // Keep the existing limit for histories, but preserve objects such as {active:true}.
  const sliced = Array.isArray(messages) ? messages.slice(-limit) : (messages && typeof messages === "object" ? messages : messages);
  _ram.set(key, sliced);
  try {
    const db = await ensurePostgresSchema();
    if (!db) return false;
    await db.query(
      `INSERT INTO sunkenbot_ai_sessions (collection_name, session_id, messages, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (collection_name, session_id)
       DO UPDATE SET messages = EXCLUDED.messages, updated_at = NOW()`,
      [String(collectionName), String(id), JSON.stringify(sliced)],
    );
    return true;
  } catch (error) {
    console.warn(`[SESSION] PostgreSQL save failed (${error?.code || error?.message || "unknown"}); context is only in RAM`);
    return false;
  }
}

export async function clearCtx(collectionName, id) {
  const key = ramKey(collectionName, id);
  _ram.delete(key);
  try {
    const db = await ensurePostgresSchema();
    if (!db) return false;
    await db.query(
      "DELETE FROM sunkenbot_ai_sessions WHERE collection_name = $1 AND session_id = $2",
      [String(collectionName), String(id)],
    );
    return true;
  } catch (error) {
    console.warn(`[SESSION] PostgreSQL delete failed (${error?.code || error?.message || "unknown"})`);
    return false;
  }
}
