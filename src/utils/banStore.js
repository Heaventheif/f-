"use strict";
/**
 * banStore.js — حفظ الحظر عبر إعادة التشغيل.
 * ─────────────────────────────────────────────
 * قبل هذا الملف كان الحظر يعيش في الذاكرة فقط (Set) ويضيع عند كل إعادة تشغيل.
 *
 * المصدر الدائم:
 *   1) PostgreSQL (جدول sunkenbot_bans) إن وُجد DATABASE_URL.
 *   2) ملف JSON محلي كبديل (BANS_FILE أو $STATE_DIR/bans.json) — مؤقت على Render Free.
 *
 * كل صف يحمل banned=true|false. القيمة false تعمل كـ«شاهد إزالة» (tombstone):
 * تُلغي حظراً مكتوباً في config.json، وإلا لعاد الحظر بعد إعادة التشغيل.
 */
import fs from "node:fs";
import path from "node:path";
import { ensurePostgresSchema } from "./postgres.js";

const BANS_FILE = process.env.BANS_FILE ||
  path.join(process.env.STATE_DIR || path.resolve(process.cwd(), "data"), "bans.json");

const SETS = { user: "_bannedUsers", group: "_bannedGroups" };

function applyRow(kind, id, banned) {
  const set = global[SETS[kind]];
  if (!set || !id) return;
  if (banned) set.add(String(id)); else set.delete(String(id));
}

function readFileRows() {
  try {
    const raw = JSON.parse(fs.readFileSync(BANS_FILE, "utf8"));
    return Array.isArray(raw?.rows) ? raw.rows : [];
  } catch { return []; }
}

function writeFileRow(kind, id, banned, actor) {
  const rows = readFileRows().filter(r => !(r.kind === kind && r.id === id));
  rows.push({ kind, id, banned, actor: actor ?? null, at: new Date().toISOString() });
  const tmp = `${BANS_FILE}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(BANS_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ rows }, null, 2), "utf8");
  fs.renameSync(tmp, BANS_FILE);
}

/** يُستدعى مرة عند الإقلاع بعد buildBanSets(): يطبّق الحظر المحفوظ فوق config.json. */
export async function loadBans() {
  let rows = null;
  try {
    const db = await ensurePostgresSchema();
    if (db) rows = (await db.query("SELECT kind, id, banned FROM sunkenbot_bans")).rows;
  } catch (e) {
    console.warn("[BANS] تعذر القراءة من PostgreSQL:", e?.code || e?.message || e);
  }
  if (!rows) rows = readFileRows();
  for (const r of rows) if (SETS[r.kind]) applyRow(r.kind, r.id, !!r.banned);
  console.log(`[BANS] ✅ استُعيد ${rows.length} سجل حظر | مستخدمون: ${global._bannedUsers?.size ?? 0} | مجموعات: ${global._bannedGroups?.size ?? 0}`);
}

/**
 * يحفظ تغيير حظر. لا يرمي أبداً: فشل الحفظ لا يجب أن يعطّل أمر `ban`
 * (الحظر يبقى نافذاً في الذاكرة) لكنه يُسجَّل بوضوح.
 */
export async function persistBanChange(kind, id, banned, actor) {
  if (!SETS[kind] || !id) return false;
  const key = String(id);
  const who = actor == null ? null : String(actor);
  try {
    const db = await ensurePostgresSchema();
    if (db) {
      await db.query(
        `INSERT INTO sunkenbot_bans (kind, id, banned, actor, updated_at) VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (kind, id) DO UPDATE SET banned = EXCLUDED.banned, actor = EXCLUDED.actor, updated_at = NOW()`,
        [kind, key, banned, who],
      );
      return true;
    }
  } catch (e) {
    console.warn("[BANS] تعذر الحفظ في PostgreSQL، سيُستخدم الملف المحلي:", e?.code || e?.message || e);
  }
  try {
    writeFileRow(kind, key, banned, who);
    return true;
  } catch (e) {
    console.error("[BANS] ⚠️ لم يُحفظ الحظر (يبقى في الذاكرة فقط):", e?.message || e);
    return false;
  }
}
