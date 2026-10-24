"use strict";
/**
 * src/fca/bot-init.js
 * ────────────────────
 * تهيئة البوت بعد تسجيل الدخول عبر fcanew-r3nz75.
 * مستقل تماماً — يستخدم fcanew-r3nz75 فقط.
 */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// fcanew-r3nz75 exports
let _attachThreadInfoRealtimeSync = null;
try {
  const fcaNx = require("fcanew-r3nz75");
  _attachThreadInfoRealtimeSync = fcaNx.attachThreadInfoRealtimeSync ?? null;
} catch (_) {}

// ── SessionExtender (اختياري) ─────────────────────────────────────────────────
let _createSessionExtender = null;
try {
  const mod = await import("./session-extender.js").catch(() => null);
  _createSessionExtender = mod?.createSessionExtender ?? null;
} catch (_) {}

// ────────────────────────────────────────────────────────────────────────────
// startMqttListener
// ────────────────────────────────────────────────────────────────────────────
export async function startMqttListener(api, opts = {}) {
  const { label, botIndex, onEvent, createMqttConnectionManager } = opts;

  if (api.__mqttManager) return api.__mqttManager.reconnect("duplicate_start");

  if (typeof createMqttConnectionManager !== "function") {
    console.error(`[MQTT:${label}] ❌ createMqttConnectionManager غير مُمرَّر`);
    return null;
  }

  const acceptedThreads = api._acceptedThreads || (api._acceptedThreads = new Set());

  const manager = createMqttConnectionManager(api, {
    label,
    botIndex,
    onState: (health) => {
      api.__mqttHealth = health;
      global._mqttHealthByBot = global._mqttHealthByBot || new Map();
      global._mqttHealthByBot.set(botIndex, health);
    },
    onEvent: (event) => {
      if (global._pausedBots?.has(botIndex)) return;
      try { onEvent?.(event, api, acceptedThreads); }
      catch (err) { console.error(`[EVENT:${label}]`, err.message); }
    },
  });

  api.__mqttManager    = manager;
  api.__forceReconnect = (r = "manual") => manager.reconnect(r);
  api.__stopWatchdog   = () => manager.stop();
  api.__mqttHealth     = manager.health();

  manager.on("ping_ok",    () => {});
  manager.on("auth_failed", (h) =>
    console.error(`[MQTT:${label}] 🔒 AppState محجوب:`, h.lastError || "auth_failed"));
  manager.on("cooldown", (h) =>
    console.warn(`[MQTT:${label}] ⏳ cooldown حتى ${h.cooldownUntil}`));

  manager.start();
  console.log(`[SUCCESS] ${label} مدير MQTT نشط`);
  return manager;
}

// ────────────────────────────────────────────────────────────────────────────
// initBotLifecycle
// ────────────────────────────────────────────────────────────────────────────
export async function initBotLifecycle(api, botIndex, opts = {}) {
  const {
    saveAppState             = () => {},
    onMqttEvent              = () => {},
    onFirstBotReady          = () => {},
    getBotName               = () => null,
    saveBotName              = () => {},
    createMqttConnectionManager,
  } = opts;

  const label      = `Bot-${botIndex}`;
  const isFirstBot = botIndex === 1;

  // ── إيقاف دورة الحياة ───────────────────────────────────────────────────
  api.__lifecycleStopped    = false;
  api.__stopSessionLifecycle = async () => {
    if (api.__lifecycleStopped) return;
    api.__lifecycleStopped = true;
    clearTimeout(api.__appStateSaveTimer);
    try { api._sessionExtender?.stop(); } catch (_) {}
    try { await api.__mqttManager?.stop(); } catch (_) {}
  };

  // ── خيارات MQTT ──────────────────────────────────────────────────────────
  try {
    api.setOptions({
      listenEvents:   true,
      updatePresence: false,
      autoReconnect:  true,
      autoMarkRead:   true,
      listenTyping:   false,
    });
  } catch (_) {}

  console.log(`[LOGIN:${label}] ✅ الاتصال بفيسبوك مستقر`);

  // ── تسجيل global ─────────────────────────────────────────────────────────
  global.botApis.push(api);
  api.__botIndex = botIndex;
  if (isFirstBot) global.botApi = api;
  api.__botName = getBotName(botIndex);

  // ── جلب اسم الحساب ──────────────────────────────────────────────────────
  ;(async () => {
    try {
      const uid = api.getCurrentUserID?.();
      if (!uid) return;
      api.__botFbId = String(uid);
      const info = await new Promise((res, rej) =>
        api.getUserInfo(uid, (err, r) => err ? rej(err) : res(r))
      );
      const name = info?.[uid]?.name;
      if (name) {
        api.__botName = name;
        saveBotName(botIndex, name);
        console.log(`[NAME:${label}] 🏷️ ${name} (${uid})`);
      }
    } catch (e) {
      console.warn(`[NAME:${label}] ⚠️`, e.message);
    }
  })();

  // ── Thread-info realtime sync ─────────────────────────────────────────────
  if (typeof _attachThreadInfoRealtimeSync === "function") {
    try {
      _attachThreadInfoRealtimeSync(api);
      console.log(`[SYNC:${label}] ✅ Thread-info realtime sync نشط`);
    } catch (e) {
      console.warn(`[SYNC:${label}] ⚠️`, e.message);
    }
  }

  // ── SessionExtender ───────────────────────────────────────────────────────
  if (typeof _createSessionExtender === "function") {
    try {
      const extender = _createSessionExtender({
        api,
        botIndex,
        checkIntervalMs:    6 * 60 * 60 * 1_000,
        refreshThresholdMs: 14 * 24 * 60 * 60 * 1_000,
        onAppStateSave: (s) => saveAppState(s, botIndex, "keep-alive"),
        onExtended: ({ count }) => {
          try {
            const s = api.getAppState?.();
            if (s?.length) saveAppState(s, botIndex, "extended");
          } catch (_) {}
          console.log(`[EXTENDER:${label}] 📦 تمديد #${count}`);
        },
      });
      extender.start();
      api._sessionExtender = extender;
      console.log(`[EXTENDER:${label}] ✅ SessionExtender نشط`);
    } catch (e) {
      console.warn(`[EXTENDER:${label}] ⚠️`, e.message);
    }
  }

  // ── حفظ AppState الطازج ──────────────────────────────────────────────────
  const freshState = api.getAppState?.();
  if (freshState?.length) {
    saveAppState(freshState, botIndex, "post-login");
    if (isFirstBot) global.appState = freshState;
  }

  // ── حفظ دوري (كل 60-120 دقيقة) ──────────────────────────────────────────
  ;(function scheduleAppStateSave() {
    const delay = (60 + Math.random() * 60) * 60_000;
    api.__appStateSaveTimer = setTimeout(() => {
      try {
        const s = api.getAppState?.();
        if (s?.length) {
          saveAppState(s, botIndex, "scheduled");
          if (isFirstBot) global.appState = s;
        }
      } catch (_) {}
      if (!api.__lifecycleStopped) scheduleAppStateSave();
    }, delay);
    api.__appStateSaveTimer.unref?.();
  })();

  // ── MQTT ──────────────────────────────────────────────────────────────────
  await startMqttListener(api, {
    label, botIndex, createMqttConnectionManager,
    onEvent: onMqttEvent,
  });

  if (isFirstBot) onFirstBotReady();
}
