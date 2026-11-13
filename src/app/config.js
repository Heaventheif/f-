// Validated, frozen configuration. Fails fast with ALL problems listed.
import { readFileSync } from "node:fs";

const str = (v) => (v == null ? v : String(v));
export function parseConfig(raw, env = process.env) {
  const errors = [];
  const c = raw && typeof raw === "object" ? raw : {};
  const ids = (k) => {
    const a = c[k] ?? [];
    if (!Array.isArray(a)) { errors.push(`${k} must be an array`); return []; }
    return a.map(str).filter(Boolean); // IDs are strings: >2^53 safe
  };
  const prefixRaw = c.Prefix ?? ["."];
  const Prefix = (Array.isArray(prefixRaw) ? prefixRaw : [prefixRaw]).map(String);
  if (Prefix.some((p) => p === "") && c.allowEmptyPrefix !== true)
    errors.push('Prefix "" makes every message a command; set allowEmptyPrefix:true to confirm');
  const cfg = {
    botName: String(c.botName ?? "SunkenBot"),
    Prefix,
    admins: ids("admins"),
    moderators: ids("moderators"),
    developers: ids("developers"),
    vips: ids("vips"),
    bannedUsers: ids("bannedUsers"),
    bannedGroups: ids("bannedGroups"),
    port: Number(env.PORT || c.port || 3000),
    stateDir: env.STATE_DIR || c.stateDir || "/tmp",
  };
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) errors.push("invalid port");
  if (errors.length) throw new Error("Invalid config:\n - " + errors.join("\n - "));
  return Object.freeze(cfg);
}
export function loadConfig(path = "./config.json", env = process.env) {
  let raw = {};
  try { raw = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) {
    if (e.code !== "ENOENT") throw new Error(`config.json unreadable: ${e.message}`);
  }
  return parseConfig(raw, env);
}
