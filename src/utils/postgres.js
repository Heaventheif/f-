"use strict";
import pg from "pg";

let pool;
let schemaPromise;

export function getPostgresPool() {
  const connectionString = String(process.env.DATABASE_URL || "").trim();
  if (!connectionString) return null;
  if (!pool) {
    // Use TLS certificate verification for Neon. Do not disable verification.
    const isNeon = /\.neon\.tech(?=[:/]|$)/i.test(connectionString);
    pool = new pg.Pool({
      connectionString,
      ...(isNeon ? { ssl: { rejectUnauthorized: true } } : {}),
      max: Number.parseInt(process.env.PG_POOL_MAX || "3", 10),
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
      keepAlive: true,
    });
    pool.on("error", (error) => {
      console.warn("[POSTGRES] اتصال خامل واجه خطأ:", error?.code || error?.message || "unknown");
    });
  }
  return pool;
}

export async function ensurePostgresSchema() {
  const db = getPostgresPool();
  if (!db) return null;
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS sunkenbot_appstate (
          id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS sunkenbot_chess_games (
          id TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          thread_id TEXT NOT NULL,
          status TEXT NOT NULL,
          player_white TEXT,
          player_black TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`CREATE INDEX IF NOT EXISTS sunkenbot_chess_active_idx ON sunkenbot_chess_games (thread_id, status)`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS sunkenbot_broadcast_store (
          id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS sunkenbot_ai_sessions (
          collection_name TEXT NOT NULL,
          session_id TEXT NOT NULL,
          messages JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (collection_name, session_id)
        )
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS sunkenbot_bans (
          kind TEXT NOT NULL CHECK (kind IN ('user', 'group')),
          id TEXT NOT NULL,
          banned BOOLEAN NOT NULL,
          actor TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (kind, id)
        )
      `);
      return db;
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  return schemaPromise;
}

export async function closePostgresPool() {
  if (pool) {
    const current = pool;
    pool = null;
    schemaPromise = null;
    await current.end();
  }
}
