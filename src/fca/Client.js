"use strict";
/**
 * src/fca/Client.js — v4.0
 * ───────────────────────────
 * تحسينات v4.0:
 *  - يقرأ AppState من: env → ذاكرة → ملف مشفَّر (بقاء بعد التحطُّم)
 *  - يحفظ بـ mergeAppStates (لا يُقلِّص jar)
 *  - يتحقق من الكوكيز المطلوبة قبل الحفظ
 */

import fs   from "fs-extra";
import path from "path";
import { createRequire }  from "node:module";
import { fileURLToPath }  from "node:url";

const require = createRequire(import.meta.url);
const fcaNx   = require("fcanew-r3nz75");
const login   = fcaNx.login ?? fcaNx.default ?? fcaNx;

import { readAppStateFromEnv, updateAppStateInMemory } from "./runtimeEnv.js";
import { dispatchMqttEvent }    from "../events/onMessage.js";
import { startCleanupInterval } from "../events/onReady.js";
import { createMqttConnectionManager } from "./MqttConnectionManager.js";
import { initBotLifecycle }    from "./bot-init.js";
import { persistAppState, mergeAppStates, readPersistedAppState, readPersistedAppStateFromDatabase } from "./appStatePersist.js";
import { startMonitoring } from "../core/monitor.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.join(MODULE_DIR, "..", "..");

// ── أسماء البوت ─────────────────────────────────────────────────────────────
const BOT_NAMES_FILE = path.join(PROJECT_ROOT, "botNames.json");

function loadBotNames() {
  try { if (fs.existsSync(BOT_NAMES_FILE)) return JSON.parse(fs.readFileSync(BOT_NAMES_FILE, "utf8")) || {}; }
  catch (_) {}
  return {};
}

function saveBotName(botIndex, name) {
  if (!name) return;
  try {
    const all = loadBotNames(); all[String(botIndex)] = name;
    const tmp = BOT_NAMES_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), "utf8");
    fs.renameSync(tmp, BOT_NAMES_FILE);
  } catch (_) {}
}

export function getBotName(botIndex) { return loadBotNames()[String(botIndex)] || null; }

// ── AppState — قراءة (env → ذاكرة → ملف مشفَّر) ───────────────────────────
export async function loadAppState() {
  // PostgreSQL is the durable source on Render Free. Merge dashboard cookies
  // underneath the persisted state so an older env snapshot cannot roll back refreshes.
  let envState = readAppStateFromEnv();
  try {
    const fromDatabase = await readPersistedAppStateFromDatabase();
    if (Array.isArray(fromDatabase) && fromDatabase.length) {
      const state = mergeAppStates(envState || [], fromDatabase);
      persistAppState(state, "startup-postgresql");
      console.warn("[APPSTATE] استعادة الحالة من PostgreSQL");
      return { state, index: 1, source: "postgresql" };
    }
  } catch (_) {}

  // First boot: seed Neon from APPSTATE configured in Render.
  if (envState) {
    persistAppState(envState, "startup-env");
    return { state: envState, index: 1, source: "APPSTATE" };
  }

  // Local encrypted file is only a fallback (ephemeral on Render Free).
  try {
    const fromFile = readPersistedAppState();
    if (Array.isArray(fromFile) && fromFile.length) {
      console.warn("[APPSTATE] استعادة من الملف المشفّر المحلي (نسخة احتياطية مؤقتة)");
      persistAppState(fromFile, "startup-local-fallback");
      return { state: fromFile, index: 1, source: "encrypted-file" };
    }
  } catch (_) {}

  return null;
}

export async function loadAllAppStates() {
  const account = await loadAppState();
  return account ? [account] : [];
}

// ── AppState — حفظ (merge + تشفير) ─────────────────────────────────────────
export function saveAppStateForBot(state, botIndex = 1, source = "runtime") {
  try {
    if (!Array.isArray(state) || state.length === 0) throw new Error("فارغ");
    const keys = new Set(state.map(c => String(c?.key ?? c?.name ?? "")));
    if (!keys.has("c_user") || !keys.has("xs")) throw new Error("cookies ناقصة");

    // تحديث في الذاكرة
    updateAppStateInMemory(state);

    // merge + تشفير على القرص (جديد v4.0)
    persistAppState(state, source);

    console.log(`[APPSTATE] ✅ حُفظ (${state.length} cookie | Bot-${botIndex} | ${source})`);
    return true;
  } catch (err) {
    console.warn(`[APPSTATE] ⚠️ ${err.message}`);
    return false;
  }
}

// ── خيارات fcanew-r3nz75 ─────────────────────────────────────────────────────────────
const GLOBAL_OPTIONS = {
  selfListen:     false,
  listenEvents:   true,
  forceLogin:     false,
  autoMarkRead:   true,
  updatePresence: false,
  autoReconnect:  true,
  online:         true,
};

// ── تسجيل الدخول ─────────────────────────────────────────────────────────────
export function loginBot(account) {
  const { state, index } = account;
  const label = `Bot-${index}`;
  console.log(`[LOGIN:${label}] 🔑 تسجيل الدخول بـ AppState...`);

  return new Promise((resolve, reject) => {
    login({ appState: state }, GLOBAL_OPTIONS, async (err, api) => {
      if (err) {
        const msg = err?.error || err?.message || String(err);
        console.error(`[LOGIN:${label}] ❌ فشل: ${msg}`);
        if (/checkpoint/i.test(msg))
          console.log(`[2FA:${label}] ⚡ أعد إنشاء APPSTATE من متصفح موثوق`);
        return reject(new Error(msg));
      }
      console.log(`[LOGIN:${label}] ✅ AppState نجح`);

      try {
        await initBotLifecycle(api, index, {
          saveAppState:               saveAppStateForBot,
          onMqttEvent:                (event, _api, threads) =>
            dispatchMqttEvent(_api, event, label, threads),
          onFirstBotReady:            () => startCleanupInterval(),
          getBotName, saveBotName, createMqttConnectionManager,
        });

        // MqttConnectionManager is the single connection/watchdog owner. A
        // second silence watchdog would mistake a quiet group for a dead socket.
        // ── مراقبة الصحة + تنبيه المشرف ───────────────────────────────────
        try {
          const stopMonitor = startMonitoring(api, index, label);
          api._stopMonitor = stopMonitor;
        } catch (_) {}

        resolve(api);
      } catch (e) {
        console.error(`[BOT:${label}] ❌ خطأ في التهيئة:`, e.message);
        reject(e);
      }
    });
  });
}

export const loginBotWithAppState = loginBot;
export { loadBotNames };
