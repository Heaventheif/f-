"use strict";

const SECRET_KEYS = /^(appstate|cookie|token|authorization|password|secret|api[_-]?key|database_url|mongo_uri)$/i;

function isDevEnabled() {
  return String(process.env.DEV || "").trim().toLowerCase() === "on";
}

function redact(value, key = "") {
  if (SECRET_KEYS.test(String(key))) return "[REDACTED]";
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]));
  }
  if (typeof value === "string" && value.length > 1000) return `${value.slice(0, 1000)}…[truncated]`;
  return value;
}

export function bugLog(_scope, _message, _details) {
  // مُعطَّل — لا يطبع أي شيء في الإنتاج
}

export function readAppStateFromEnv({ required = false } = {}) {
  const raw = process.env.APPSTATE;
  if (raw == null || raw.trim() === "") {
    const message = "APPSTATE is missing; provide a valid JSON cookie array.";
    if (required) throw new Error(message);
    bugLog("APPSTATE", message);
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("APPSTATE must be a non-empty JSON array.");
    const normalized = parsed.map((cookie, index) => {
      if (!cookie || typeof cookie !== "object") throw new Error(`APPSTATE cookie ${index} is not an object.`);
      const key = String(cookie.key ?? cookie.name ?? "").trim();
      const value = String(cookie.value ?? "");
      if (!key) throw new Error(`APPSTATE cookie ${index} has no key/name.`);
      return { ...cookie, key, value };
    });
    bugLog("APPSTATE", "Loaded APPSTATE from environment", { cookieCount: normalized.length });
    return normalized;
  } catch (error) {
    const message = `Invalid APPSTATE JSON: ${error.message}`;
    if (required) throw new Error(message, { cause: error });
    console.warn(`[APPSTATE] ${message}`);
    return null;
  }
}

export function updateAppStateInMemory(nextState) {
  if (!Array.isArray(nextState) || nextState.length === 0) throw new TypeError("Updated APPSTATE must be a non-empty array.");
  process.env.APPSTATE = JSON.stringify(nextState);
  globalThis.appState = nextState;
  return process.env.APPSTATE;
}

export { isDevEnabled, redact };
export default { bugLog, readAppStateFromEnv, updateAppStateInMemory, isDevEnabled, redact };
