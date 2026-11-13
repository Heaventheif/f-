"use strict";
import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const fcaNx = require("fcanew-r3nz75");
const login = fcaNx.login ?? fcaNx.default ?? fcaNx;
import { readAppStateFromEnv, updateAppStateInMemory } from "./runtimeEnv.js";
import { dispatchMqttEvent } from "../events/onMessage.js";
import { startCleanupInterval } from "../events/onReady.js";
import { createMqttConnectionManager } from "./MqttConnectionManager.js";
import { initBotLifecycle } from "./bot-init.js";
import { adaptApi } from "./fcaCompat.js";
import {
  persistAppState,
  readPersistedAppState,
  readPersistedAppStateRecordFromDatabase,
  chooseStartupState,
  saveAppStateToDatabase,
  flushAppStatePersistence,
  BOOT_ENV_HASH,
} from "./appStatePersist.js";
import { startMonitoring } from "../core/monitor.js";
import { KeyedMutex, SingleFlight } from "../infra/limiter.js";
import { AppError } from "../infra/errors.js";
import { superviseLogin, withTimeout } from "../app/supervisor.js";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.join(MODULE_DIR, "..", "..");
const BOT_NAMES_FILE = path.join(process.env.STATE_DIR || PROJECT_ROOT, "botNames.json");
async function loadBotNames() {
  try {
    return JSON.parse(await readFile(BOT_NAMES_FILE, "utf8")) || {};
  } catch (_) {
    return {};
  }
}
const _namesMutex = new KeyedMutex();
async function saveBotName(botIndex, name) {
  if (!name) return;
  try {
    await _namesMutex.run("botNames", async () => {
      const all = await loadBotNames();
      if (all[String(botIndex)] === name) return;
      all[String(botIndex)] = name;
      // Unique tmp name + rename: readers never see a half-written file.
      const tmp = `${BOT_NAMES_FILE}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(BOT_NAMES_FILE), { recursive: true });
      try {
        await writeFile(tmp, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
        await rename(tmp, BOT_NAMES_FILE);
      } catch (e) {
        await unlink(tmp).catch(() => {});
        throw e;
      }
    });
  } catch (e) {
    console.warn("[BOTNAMES] تعذر الحفظ:", e?.message || e);
  }
}
export async function getBotName(botIndex) {
  return (await loadBotNames())[String(botIndex)] || null;
}
// الافتراضي: القراءة من متغير البيئة APPSTATE فقط (بدون دمج مع PostgreSQL أو الملف المحلي).
// للرجوع للسلوك القديم (دمج/استعادة من القاعدة) اضبط APPSTATE_USE_DB=true.
// إذا كان APPSTATE فارغاً أو غير صالح نرجع للنسخة المخزَّنة كاحتياط.
export async function loadAppState() {
  const useDb = /^(1|true|yes|on)$/i.test(String(process.env.APPSTATE_USE_DB || "").trim());
  if (!useDb) {
    const envState = readAppStateFromEnv();
    const keys = new Set((envState || []).map((c) => String(c?.key ?? c?.name ?? "")));
    if (envState && keys.has("c_user") && keys.has("xs")) {
      console.warn(`[APPSTATE] ✅ استخدام APPSTATE من متغير البيئة فقط (${envState.length} cookie)`);
      return { state: envState, index: 1, source: "env-only" };
    }
    console.warn("[APPSTATE] ⚠️ APPSTATE في البيئة غير صالح/فارغ — محاولة الاستعادة من النسخة المخزَّنة");
  }
  return loadAppStateMerged();
}
async function loadAppStateMerged() {
  const envState = readAppStateFromEnv();
  const record = await readPersistedAppStateRecordFromDatabase();
  const forceEnv = /^(1|true|yes|on)$/i.test(String(process.env.APPSTATE_FORCE_ENV || "").trim());
  const choice = chooseStartupState({
    envState,
    dbState: record?.state,
    dbEnvHash: record ? record.envHash : void 0,
    forceEnv,
  });
  if (choice) {
    const label = {
      "no-db-row": "أول إقلاع: APPSTATE من البيئة",
      "no-env": "استعادة من PostgreSQL",
      forced: "APPSTATE_FORCE_ENV: قيمة البيئة تتغلب",
      "env-changed": "اكتُشف APPSTATE جديد في البيئة — يتغلب على المخزَّن",
      "env-unchanged": "استعادة من PostgreSQL (البيئة لم تتغير)",
      "legacy-row": "استعادة من PostgreSQL (صف قديم بلا بصمة)",
    }[choice.reason];
    console.warn(`[APPSTATE] ${label}`);
    await persistAppState(choice.state, `startup-${choice.reason}`);
    if (record && record.envHash !== BOOT_ENV_HASH) {
      try {
        await flushAppStatePersistence();
        await saveAppStateToDatabase(choice.state);
      } catch (e) {
        console.warn("[APPSTATE] تعذر تدوين بصمة البيئة:", e?.message || e);
      }
    }
    return { state: choice.state, index: 1, source: choice.source };
  }
  try {
    const fromFile = await readPersistedAppState();
    if (Array.isArray(fromFile) && fromFile.length) {
      console.warn("[APPSTATE] استعادة من الملف المشفّر المحلي (نسخة احتياطية مؤقتة)");
      await persistAppState(fromFile, "startup-local-fallback");
      return { state: fromFile, index: 1, source: "encrypted-file" };
    }
  } catch (_) {}
  return null;
}
export async function loadAllAppStates() {
  const account = await loadAppState();
  return account ? [account] : [];
}
export async function saveAppStateForBot(state, botIndex = 1, source = "runtime") {
  try {
    if (!Array.isArray(state) || state.length === 0) throw new Error("فارغ");
    const keys = new Set(state.map((c) => String(c?.key ?? c?.name ?? "")));
    if (!keys.has("c_user") || !keys.has("xs")) throw new Error("cookies ناقصة");
    updateAppStateInMemory(state);
    // persistAppState dedups by content hash and logs only when something changed.
    return await persistAppState(state, source);
  } catch (err) {
    console.warn(`[APPSTATE] ⚠️ ${err.message}`);
    return false;
  }
}
const GLOBAL_OPTIONS = {
  selfListen: false,
  listenEvents: true,
  forceLogin: false,
  autoMarkRead: true,
  updatePresence: false,
  autoReconnect: false, // MqttConnectionManager is the single reconnect owner
  online: true,
  autoListen: false,
};
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS) || 90_000;
const RELOGIN_DELAY_MS = Number(process.env.RELOGIN_DELAY_MS) || 5 * 6e4;
const _relogin = new SingleFlight();
const _reloginTimers = new Map();

function fcaLogin(state, label) {
  return new Promise((resolve, reject) => {
    login({ appState: state }, GLOBAL_OPTIONS, (err, api) => {
      if (err) {
        const msg = err?.error || err?.message || String(err);
        console.error(`[LOGIN:${label}] ❌ فشل: ${msg}`);
        if (/checkpoint/i.test(msg))
          console.log(`[2FA:${label}] ⚡ أعد إنشاء APPSTATE من متصفح موثوق`);
        const fatal = /checkpoint|login_blocked|not logged in/i.test(msg);
        return reject(new AppError(fatal ? "auth_failed" : "upstream", msg, { cause: err }));
      }
      resolve(api);
    });
  });
}

export async function loginBot(account, { timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const { state, index } = account;
  const label = `Bot-${index}`;
  console.log(`[LOGIN:${label}] 🔑 تسجيل الدخول بـ AppState...`);
  let timedOut = false;
  const pending = fcaLogin(state, label);
  let api;
  try {
    api = await withTimeout(() => pending, timeoutMs, `fca login ${label}`);
  } catch (e) {
    timedOut = e?.code === "timeout";
    // A login that completes after we gave up must not leave a live session behind.
    if (timedOut)
      pending.then((late) => late?.logout?.(() => {}), () => {}).catch(() => {});
    throw e;
  }
  console.log(`[LOGIN:${label}] ✅ AppState نجح`);
  adaptApi(api);
  try {
    await initBotLifecycle(api, index, {
      saveAppState: saveAppStateForBot,
      onMqttEvent: (event, _api, threads) => dispatchMqttEvent(_api, event, label, threads),
      onFirstBotReady: () => startCleanupInterval(),
      getBotName,
      saveBotName,
      createMqttConnectionManager,
      onAuthFailed: () => scheduleRelogin(api, index),
    });
    try {
      api._stopMonitor = startMonitoring(api, index, label);
    } catch (e) {
      console.warn(`[MONITOR:${label}] تعذر التشغيل:`, e?.message || e);
    }
    return api;
  } catch (e) {
    console.error(`[BOT:${label}] ❌ خطأ في التهيئة:`, e.message);
    await teardownApi(api);
    throw e;
  }
}

async function teardownApi(api) {
  if (!api) return;
  try {
    api._stopMonitor?.();
  } catch (_) {}
  try {
    await api.__stopSessionLifecycle?.();
  } catch (_) {}
  const i = global.botApis.indexOf(api);
  if (i >= 0) global.botApis.splice(i, 1);
  if (global.botApi === api) global.botApi = null;
}

// Stop every session and pending relogin timer (graceful shutdown).
export async function stopAllSessions() {
  for (const t of _reloginTimers.values()) clearTimeout(t);
  _reloginTimers.clear();
  for (const api of [...global.botApis]) {
    await teardownApi(api);
    try {
      api._scheduler?.destroy();
    } catch (_) {}
    try {
      api.__sessionLock?.release();
    } catch (_) {}
  }
}

// AUTH_FAILED: wait (FB blocks are time-limited), then re-login from the freshest
// stored AppState. Only one relogin runs at a time.
function scheduleRelogin(oldApi, index) {
  if (_reloginTimers.has(index)) return;
  const t = setTimeout(() => {
    _reloginTimers.delete(index);
    void reloginBot(oldApi, index);
  }, RELOGIN_DELAY_MS);
  t.unref?.();
  _reloginTimers.set(index, t);
}

export function reloginBot(oldApi, index) {
  return _relogin.run(`relogin-${index}`, async () => {
    if (oldApi.__lifecycleStopped) return null;
    if (oldApi.__mqttManager?.health().state !== "AUTH_FAILED") return null;
    const label = `Bot-${index}`;
    console.warn(`[RELOGIN:${label}] 🔁 إعادة تسجيل الدخول بعد AUTH_FAILED`);
    try {
      const api = await superviseLogin({
        maxAttempts: 4,
        timeoutMs: LOGIN_TIMEOUT_MS + 3e4,
        isFatal: (e) => e?.code === "no_appstate" || e?.code === "auth_failed",
        attempt: async () => {
          const account = await loadAppState();
          if (!account) throw new AppError("no_appstate", "no appstate");
          // Old session must be down before a new one starts listening.
          await teardownApi(oldApi);
          return loginBot({ ...account, index });
        },
      });
      console.log(`[RELOGIN:${label}] ✅ تمت إعادة الاتصال`);
      return api;
    } catch (e) {
      // The old session is already torn down; a live web server with a dead bot is
      // worse than a restart by the platform supervisor.
      console.error(`[RELOGIN:${label}] ❌ فشلت إعادة الدخول — إنهاء العملية:`, e?.message || e);
      process.exit(1);
    }
  });
}
export const loginBotWithAppState = loginBot;
export { loadBotNames };
