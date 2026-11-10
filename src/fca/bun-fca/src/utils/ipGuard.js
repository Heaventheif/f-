"use strict";

const fs = require("fs");
const path = require("path");
const logger = require("../../func/logger");

const ENDPOINTS = [
  "https://api.ipify.org?format=json",
  "https://ipinfo.io/json"
];

function stateFile() {
  const dir = process.env.BUN_FCA_STATE_DIR || path.join(process.cwd(), ".bun-fca");
  return { dir, file: path.join(dir, "last_login_ip.json") };
}

async function lookupIP(client) {
  for (const url of ENDPOINTS) {
    try {
      const res = await client.get(url, { timeout: 5000, headers: { Accept: "application/json" } });
      const ip = res && res.data && (res.data.ip || res.data.query);
      if (typeof ip === "string" && ip) return { ip, country: res.data.country || null, region: res.data.region || null };
    } catch (_) {   }
  }
  return null;
}

async function checkLoginIP(client, userID) {
  const mode = String(process.env.BUN_FCA_IP_GUARD || "warn").toLowerCase();
  if (mode === "off" || mode === "0" || mode === "false") return { ok: true, changed: false, ip: null, previous: null };
  const now = await lookupIP(client);
  if (!now) {
    logger("ipGuard: could not determine public IP (continuing)", "warn");
    return { ok: true, changed: false, ip: null, previous: null };
  }
  const { dir, file } = stateFile();
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch (_) {}
  const key = String(userID || "default");
  const prev = all[key] && all[key].ip ? all[key] : null;
  const changed = !!prev && prev.ip !== now.ip;
  if (changed) {
    const msg = `ipGuard: login IP changed ${prev.ip} -> ${now.ip}. Logging into the same account from different IPs/locations is a top cause of "automated behaviour", checkpoints and suspensions. Use ONE host with a fixed IP (or a static proxy via the 'proxy' option).`;
    if (mode === "block") {
      logger(msg + " Login refused (BUN_FCA_IP_GUARD=block). Set BUN_FCA_IP_GUARD=warn to override.", "error");
      return { ok: false, changed: true, ip: now.ip, previous: prev.ip };
    }
    logger(msg, "warn");
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    all[key] = { ip: now.ip, country: now.country, region: now.region, at: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(all, null, 2));
  } catch (_) {}
  return { ok: true, changed, ip: now.ip, previous: prev ? prev.ip : null };
}

module.exports = { checkLoginIP, lookupIP };