"use strict";

const fs = require("fs");
const path = require("path");

const STORE_DIR = path.join(process.cwd(), "Fca_Database");
const STORE_FILE = path.join(STORE_DIR, "appstate-backups.json");

let cache = null;
let dirty = false;
let flushTimer = null;
let primed = false;

const MAX_ENTRIES_PER_TYPE = 12;

function prime() {
  if (primed) return;
  primed = true;
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") cache = parsed;
    }
  } catch (_) {
    cache = null;
  }
  if (!cache || typeof cache !== "object") cache = {};
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushSync();
  }, 250);
  if (flushTimer.unref) flushTimer.unref();
}

function flushSync() {
  if (!dirty || !cache) return;
  try {
    if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
    const tmp = STORE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, STORE_FILE);
    dirty = false;
  } catch (_) {

  }
}

function trimHistory(list) {
  while (list.length > MAX_ENTRIES_PER_TYPE) list.shift();
}

async function upsertBackup(userID, type, data) {
  try {
    prime();
    const uid = String(userID || "unknown");
    const t = String(type || "appstate");
    if (!cache[uid]) cache[uid] = {};
    if (!Array.isArray(cache[uid][t])) cache[uid][t] = [];
    cache[uid][t].push({
      data: typeof data === "string" ? data : JSON.stringify(data),
      updatedAt: new Date().toISOString()
    });
    trimHistory(cache[uid][t]);
    scheduleFlush();
    return true;
  } catch (_) {
    return false;
  }
}

async function getLatestBackup(userID, type) {
  try {
    prime();
    const uid = String(userID || "unknown");
    const t = String(type || "appstate");
    const list = cache[uid] && cache[uid][t];
    if (!Array.isArray(list) || !list.length) return null;
    const last = list[list.length - 1];
    return last ? last.data : null;
  } catch (_) {
    return null;
  }
}

async function getLatestBackupAny(type) {
  try {
    prime();
    const t = String(type || "appstate");
    let newest = null;
    let newestAt = "";
    for (const uid of Object.keys(cache)) {
      const list = cache[uid] && cache[uid][t];
      if (!Array.isArray(list) || !list.length) continue;
      const last = list[list.length - 1];
      if (last && last.updatedAt && last.updatedAt > newestAt) {
        newestAt = last.updatedAt;
        newest = last.data;
      }
    }
    return newest;
  } catch (_) {
    return null;
  }
}

function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flushSync();
}

module.exports = {
  upsertBackup,
  getLatestBackup,
  getLatestBackupAny,
  flushNow,
  STORE_FILE,
};