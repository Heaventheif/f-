"use strict";
import crypto from "node:crypto";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { ensurePostgresSchema } from "../utils/postgres.js";
import { KeyedMutex } from "../infra/limiter.js";
export const EXPIRY_WARNING_MS = 14 * 24 * 60 * 60 * 1e3;
export const EXPIRY_CRITICAL_MS = 3 * 24 * 60 * 60 * 1e3;
const REQUIRED_COOKIES = ["c_user", "xs"];
const SESSION_COOKIES = ["c_user", "xs", "fr", "sb", "datr", "wd", "locale"];
const CRITICAL_COOKIES = ["c_user", "xs"];
export const STATE_FILE =
  process.env.FB_STATE_PATH ||
  path.join(process.env.STATE_DIR || path.resolve(process.cwd(), "data"), "appstate.enc");
const ALGO = "aes-256-gcm";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1e3;
const _sha256 = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
const MIN_KEY_LEN = 32;
const _persistMutex = new KeyedMutex();

function _secret() {
  return (
    process.env.FCA_STATE_KEY || process.env.STATE_ENCRYPT_KEY || process.env.APPSTATE_SECRET || ""
  );
}
// Legacy v1 key: bare SHA-256 of the secret (still accepted for decrypting).
function _legacyKey(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}
// v2 key: scrypt with a per-payload random salt (cached by salt; scrypt is slow on purpose).
const _keyCache = new Map();
function _v2Key(secret, salt) {
  const id = salt.toString("base64");
  let k = _keyCache.get(id);
  if (!k) {
    k = crypto.scryptSync(secret, salt, 32);
    if (_keyCache.size > 8) _keyCache.clear();
    _keyCache.set(id, k);
  }
  return k;
}
function _requireSecret() {
  const k = _secret();
  if (k.length < MIN_KEY_LEN) {
    const err = new Error(
      `encryption key missing or shorter than ${MIN_KEY_LEN} chars (FCA_STATE_KEY / STATE_ENCRYPT_KEY / APPSTATE_SECRET)`,
    );
    err.code = "APPSTATE_KEY_INVALID";
    throw err;
  }
  return k;
}
// HMAC (not a bare hash) so the stored fingerprint cannot be used to test guesses of the cookie string.
export function computeEnvHash(raw, secret = _secret()) {
  const text = String(raw || "").trim();
  if (!text || secret.length < MIN_KEY_LEN) return null;
  const key = Buffer.from(crypto.hkdfSync("sha256", secret, "sunkenbot", "envhash-v2", 32));
  return crypto.createHmac("sha256", key).update(text, "utf8").digest("hex");
}
export const legacyEnvHash = (raw) => {
  const text = String(raw || "").trim();
  return text ? _sha256(text) : null;
};
export const BOOT_ENV_HASH = computeEnvHash(process.env.APPSTATE);
const LEGACY_BOOT_ENV_HASH = legacyEnvHash(process.env.APPSTATE);

let _inMemoryState = null;
let _inMemoryHash = null;
let _lastSaveTimestamp = 0;
let _dbSaveChain = Promise.resolve();
export async function saveAppStateToDatabase(state = _inMemoryState) {
  if (!_validateAppState(state)) return false;
  const db = await ensurePostgresSchema();
  if (!db) return false;
  const encrypted = _encryptJson(_normalizeAppState(state));
  const payload = { ...encrypted, envHash: BOOT_ENV_HASH };
  await db.query(
    `INSERT INTO sunkenbot_appstate (id, payload, updated_at) VALUES (1, $1::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
    [JSON.stringify(payload)],
  );
  return true;
}
export async function loadAppStateRecordFromDatabase() {
  const db = await ensurePostgresSchema();
  if (!db) return null;
  const result = await db.query("SELECT payload FROM sunkenbot_appstate WHERE id = 1");
  const payload = result.rows?.[0]?.payload;
  if (!payload) return null;
  return { state: _decryptJson(payload), envHash: payload.envHash };
}
export async function readPersistedAppStateRecordFromDatabase() {
  try {
    const rec = await loadAppStateRecordFromDatabase();
    if (!rec || !_validateAppState(rec.state)) return null;
    return { state: _normalizeAppState(rec.state), envHash: rec.envHash };
  } catch (error) {
    console.warn(
      `[APPSTATE] تعذر الاستعادة من PostgreSQL (${error?.code || error?.message || "unknown"})`,
    );
    return null;
  }
}
export async function readPersistedAppStateFromDatabase() {
  return (await readPersistedAppStateRecordFromDatabase())?.state ?? null;
}
export function chooseStartupState({
  envState,
  dbState,
  dbEnvHash,
  bootEnvHash = BOOT_ENV_HASH,
  legacyBootEnvHash = LEGACY_BOOT_ENV_HASH,
  forceEnv = false,
}) {
  const hasEnv = _validateAppState(envState);
  const hasDb = _validateAppState(dbState);
  if (!hasEnv && !hasDb) return null;
  if (!hasDb) return { state: envState, source: "APPSTATE", reason: "no-db-row" };
  if (!hasEnv) return { state: dbState, source: "postgresql", reason: "no-env" };
  // Rows written before the HMAC fingerprint carry a plain SHA-256: treat a match as unchanged.
  const sameEnv = dbEnvHash === bootEnvHash || dbEnvHash === legacyBootEnvHash;
  const envIsNew = forceEnv || (dbEnvHash !== void 0 && !sameEnv);
  if (envIsNew) {
    return {
      state: mergeAppStates(dbState, envState),
      source: "postgresql+new-env",
      reason: forceEnv ? "forced" : "env-changed",
    };
  }
  return {
    state: mergeAppStates(envState, dbState),
    source: "postgresql",
    reason: dbEnvHash === void 0 ? "legacy-row" : "env-unchanged",
  };
}
export async function readPersistedAppState() {
  return _atomicRead(STATE_FILE);
}
// Throws APPSTATE_KEY_INVALID: callers must surface it, never persist plaintext or skip silently.
function _encryptJson(obj) {
  const secret = _requireSecret();
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, _v2Key(secret, salt), iv);
  cipher.setAAD(Buffer.from("sunkenbot-appstate:v2"));
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  return {
    v: 2,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
    ts: Date.now(),
  };
}
function _decryptJson(p) {
  if (!p || (p.v !== 1 && p.v !== 2)) {
    console.error("[APPSTATE] ❌ صيغة الحمولة المشفّرة غير معروفة");
    return null;
  }
  const secret = _secret();
  if (secret.length < MIN_KEY_LEN) {
    console.error("[APPSTATE] ❌ تعذر فك التشفير: مفتاح التشفير غير مضبوط أو أقصر من 32 حرفاً");
    return null;
  }
  try {
    const key = p.v === 2 ? _v2Key(secret, Buffer.from(p.salt, "base64")) : _legacyKey(secret);
    const dec = crypto.createDecipheriv(ALGO, key, Buffer.from(p.iv, "base64"));
    if (p.v === 2) dec.setAAD(Buffer.from("sunkenbot-appstate:v2"));
    dec.setAuthTag(Buffer.from(p.tag, "base64"));
    return JSON.parse(
      Buffer.concat([dec.update(Buffer.from(p.data, "base64")), dec.final()]).toString("utf8"),
    );
  } catch (e) {
    console.error(
      `[APPSTATE] ❌ فشل فك التشفير (المفتاح تغيّر أو البيانات تالفة): ${e?.message || e}`,
    );
    return null;
  }
}
// Exposed for tests only.
export const _crypto = { encrypt: _encryptJson, decrypt: _decryptJson };
async function _atomicWrite(filePath, obj) {
  const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const payload = _encryptJson(obj);
    await writeFile(tmp, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
    await rename(tmp, filePath);
    return true;
  } catch (e) {
    try {
      await unlink(tmp);
    } catch (_) {}
    console.error(`[APPSTATE] ❌ فشل الحفظ المشفَّر على القرص: ${e.message}`);
    return false;
  }
}
async function _atomicRead(filePath) {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    if (!raw || typeof raw.ts !== "number") return null;
    if (Date.now() - raw.ts > MAX_AGE_MS) {
      console.warn("[APPSTATE] ⚠️ ملف الحالة أقدم من 7 أيام — تجاهله");
      return null;
    }
    return _decryptJson(raw);
  } catch {
    return null;
  }
}
// Cookie identity is name + domain + path (same name on different domains/paths is a different cookie).
const cookieId = (c) =>
  `${String(c?.key ?? c?.name ?? "")}|${String(c?.domain ?? ".facebook.com").toLowerCase()}|${c?.path ?? "/"}`;
const hasName = (c) => String(c?.key ?? c?.name ?? "") !== "";
const isDefined = (v) => v !== undefined && v !== null;
export function mergeAppStates(existing, incoming) {
  const map = new Map();
  for (const c of existing || []) {
    if (hasName(c)) map.set(cookieId(c), { ...c });
  }
  for (const c of incoming || []) {
    if (!hasName(c)) continue;
    const id = cookieId(c);
    const prev = map.get(id);
    if (!prev) {
      map.set(id, { ...c });
      continue;
    }
    // Incoming wins field by field, but missing fields never erase what we already know
    // (notably `expires`).
    const next = { ...prev };
    for (const [k, v] of Object.entries(c)) if (isDefined(v)) next[k] = v;
    map.set(id, next);
  }
  return [...map.values()];
}
export async function resolveAppState(envState, _botIndex = 1) {
  if (_validateAppState(envState)) {
    const normalized = _normalizeAppState(envState);
    _updateMemoryCache(normalized);
    return { state: normalized, source: "env" };
  }
  if (_inMemoryState && _validateAppState(_inMemoryState)) {
    console.warn("[APPSTATE] ⚠️ البيئة فارغة — استخدام نسخة الذاكرة");
    return { state: _inMemoryState, source: "memory" };
  }
  const fromFile = await _atomicRead(STATE_FILE);
  if (fromFile && _validateAppState(fromFile)) {
    console.warn("[APPSTATE] ⚠️ استعادة من الملف المشفَّر (نجا من تحطُّم)");
    _updateMemoryCache(_normalizeAppState(fromFile));
    return { state: fromFile, source: "encrypted-file" };
  }
  console.error("[APPSTATE] ❌ لا يوجد AppState صالح");
  return { state: null, source: null };
}
export function persistAppState(state, source = "auto") {
  // One writer at a time: read-merge-write must not interleave.
  return _persistMutex.run("persist", () => _persistLocked(state, source));
}
let _lastSuccessfulCheckAt = 0;
export function getPersistInfo() {
  return { lastSuccessfulCheckAt: _lastSuccessfulCheckAt, lastSaveAt: _lastSaveTimestamp };
}
async function _persistLocked(state, source) {
  if (!_validateAppState(state)) {
    console.warn(`[APPSTATE] ⚠️ persistAppState: حالة غير صالحة (${source})`);
    return false;
  }
  if (_secret().length < MIN_KEY_LEN) {
    console.error(
      `[APPSTATE] ❌ رفض الحفظ (${source}): مفتاح التشفير غير مضبوط أو أقصر من ${MIN_KEY_LEN} حرفاً — لن تُحفظ الجلسة.`,
    );
    return false;
  }
  const onDisk = await _atomicRead(STATE_FILE);
  const existing = mergeAppStates(onDisk, _inMemoryState);
  const normalized = _normalizeAppState(mergeAppStates(existing, state));
  const newHash = _hashState(normalized);
  const diskHash = onDisk ? _hashState(_normalizeAppState(onDisk)) : null;
  _lastSuccessfulCheckAt = Date.now();
  if (newHash === _inMemoryHash && newHash === diskHash) return false;
  _updateMemoryCache(normalized, newHash);
  // Cookies live in module memory + encrypted storage only; never in process.env
  // (child processes would inherit them).
  globalThis.appState = normalized;
  const saved = await _atomicWrite(STATE_FILE, normalized);
  if (saved) _lastSaveTimestamp = Date.now();
  _dbSaveChain = _dbSaveChain
    .catch(() => {})
    .then(async () => {
      const dbSaved = await saveAppStateToDatabase(normalized);
      if (dbSaved) console.log(`[APPSTATE] 💾 حُفظت نسخة مشفّرة في PostgreSQL (${source})`);
    })
    .catch((error) => {
      console.warn(
        `[APPSTATE] تعذر الحفظ في PostgreSQL (${error?.code || error?.message || "unknown"})`,
      );
    });
  console.log(
    `[APPSTATE] 💾 حُفظ (${normalized.length} cookie | ${source}${saved ? " | 🔒local" : ""})`,
  );
  return true;
}
export async function flushAppStatePersistence() {
  await _dbSaveChain;
}
export function extendCookieExpiry(state, extraDays = 60) {
  if (!Array.isArray(state)) return state;
  const extendUntil = Date.now() + extraDays * 864e5;
  return state.map((cookie) => {
    if (!cookie.expires || cookie.expires === "Infinity" || cookie.expires === Infinity)
      return cookie;
    const expMs =
      cookie.expires instanceof Date
        ? cookie.expires.getTime()
        : typeof cookie.expires === "string"
          ? new Date(cookie.expires).getTime()
          : typeof cookie.expires === "number"
            ? cookie.expires < 1e12
              ? cookie.expires * 1e3
              : cookie.expires
            : NaN;
    if (isNaN(expMs) || expMs <= 0) return cookie;
    if (expMs < extendUntil) return { ...cookie, expires: Math.floor(extendUntil / 1e3) };
    return cookie;
  });
}
export function checkAppStateExpiry(appState, warningMs = EXPIRY_WARNING_MS) {
  if (!Array.isArray(appState))
    return {
      expiring: false,
      critical: false,
      minTtlMs: Infinity,
      expiresAt: null,
      expiringSoon: [],
      criticalCookies: [],
    };
  const now = Date.now();
  let minTtl = Infinity,
    minExp = null;
  const expiringSoon = [],
    criticalList = [];
  for (const cookie of appState) {
    const name = String(cookie?.key ?? cookie?.name ?? "");
    const exp = cookie?.expires;
    if (!exp || exp === "Infinity" || exp === Infinity) continue;
    const expMs =
      exp instanceof Date
        ? exp.getTime()
        : typeof exp === "string"
          ? new Date(exp).getTime()
          : typeof exp === "number"
            ? exp < 1e12
              ? exp * 1e3
              : exp
            : NaN;
    if (isNaN(expMs) || expMs <= 0) continue;
    const ttl = expMs - now;
    if (ttl < minTtl) {
      minTtl = ttl;
      minExp = new Date(expMs);
    }
    if (ttl < warningMs && SESSION_COOKIES.includes(name)) {
      expiringSoon.push(`${name}(${Math.round(ttl / 864e5)}d)`);
      if (ttl < EXPIRY_CRITICAL_MS && CRITICAL_COOKIES.includes(name)) criticalList.push(name);
    }
  }
  if (criticalList.length > 0)
    console.error(`[APPSTATE] 🚨 كوكيز حرجة قريبة الانتهاء: ${criticalList.join(", ")}`);
  else if (expiringSoon.length > 0)
    console.warn(`[APPSTATE] ⏰ كوكيز تقترب من الانتهاء: ${expiringSoon.join(", ")}`);
  return {
    expiring: minTtl < warningMs,
    critical: criticalList.length > 0,
    minTtlMs: minTtl === Infinity ? Infinity : Math.max(0, minTtl),
    expiresAt: minExp,
    expiringSoon,
    criticalCookies: criticalList,
  };
}
export function getSessionInfo(appState) {
  if (!Array.isArray(appState)) return null;
  const find = (names) => {
    for (const n of names) {
      const c = appState.find((c2) => (c2?.key ?? c2?.name) === n);
      if (c) return c.value;
    }
    return null;
  };
  return {
    uid: find(["c_user", "i_user"]),
    cookieCount: appState.length,
    hasFr: !!find(["fr"]),
    hasXs: !!find(["xs"]),
    lastSaved: _lastSaveTimestamp ? new Date(_lastSaveTimestamp).toISOString() : null,
  };
}
function _validateAppState(state) {
  if (!Array.isArray(state) || state.length === 0) return false;
  const keys = new Set(state.map((c) => String(c?.key ?? c?.name ?? "")));
  return REQUIRED_COOKIES.every((k) => keys.has(k));
}
function _normalizeAppState(state) {
  return state
    .map((cookie) => {
      const key = String(cookie?.key ?? cookie?.name ?? "").trim();
      return {
        key,
        value: String(cookie?.value ?? ""),
        domain: cookie?.domain ?? ".facebook.com",
        path: cookie?.path ?? "/",
        secure: cookie?.secure ?? true,
        httpOnly: cookie?.httpOnly ?? false,
        expires: cookie?.expires ?? "Infinity",
      };
    })
    .filter((c) => c.key);
}
function _hashState(state) {
  try {
    const sorted = [...state].sort((x, y) => (cookieId(x) < cookieId(y) ? -1 : 1));
    return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
  } catch {
    return null;
  }
}
function _updateMemoryCache(state, hash = null) {
  _inMemoryState = state;
  _inMemoryHash = hash ?? _hashState(state);
}
