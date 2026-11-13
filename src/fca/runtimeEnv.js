"use strict";
const SECRET_KEYS =
  /^(appstate|cookie|token|authorization|password|secret|api[_-]?key|database_url|mongo_uri)$/i;
function isDevEnabled() {
  return (
    String(process.env.DEV || "")
      .trim()
      .toLowerCase() === "on"
  );
}
const ID_KEYS = /^(threadID|senderID|userID|uid|author)$/i;
function maskId(value) {
  const text = String(value ?? "");
  return text.length > 4 ? `***${text.slice(-4)}` : text;
}
function redactText(value) {
  return String(value ?? "")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(appstate|cookie|set-cookie|token|authorization|password|secret|api[_-]?key|access_token|c_user|xs|datr|fb_dtsg)\s*[:=]\s*[^\s,;&]+/gi,
      "$1=[REDACTED]",
    )
    // JSON-style secrets: "token":"abc"
    .replace(
      /("(?:appstate|cookie|token|authorization|password|secret|api[_-]?key|access_token|c_user|xs|datr|fb_dtsg)"\s*:\s*)"[^"]*"/gi,
      '$1"[REDACTED]"',
    );
}
function redact(value, key = "") {
  if (SECRET_KEYS.test(String(key))) return "[REDACTED]";
  if (ID_KEYS.test(String(key)) && (typeof value === "string" || typeof value === "number"))
    return maskId(value);
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([childKey, childValue]) => [childKey, redact(childValue, childKey)]),
    );
  }
  if (typeof value === "string" && value.length > 1e3) return `${value.slice(0, 1e3)}…[truncated]`;
  return value;
}
export function bugLog(_scope, _message, _details) {}
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
    if (!Array.isArray(parsed) || parsed.length === 0)
      throw new Error("APPSTATE must be a non-empty JSON array.");
    const normalized = parsed.map((cookie, index) => {
      if (!cookie || typeof cookie !== "object")
        throw new Error(`APPSTATE cookie ${index} is not an object.`);
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
// Live cookies are kept in module memory only. Writing them to process.env would
// leak them into every child process and crash report.
let _memoryState = null;
export function updateAppStateInMemory(nextState) {
  if (!Array.isArray(nextState) || nextState.length === 0)
    throw new TypeError("Updated APPSTATE must be a non-empty array.");
  _memoryState = nextState;
  globalThis.appState = nextState;
  return nextState;
}
export function getAppStateInMemory() {
  return _memoryState;
}
export { isDevEnabled, redact, redactText, maskId };
export default {
  bugLog,
  readAppStateFromEnv,
  updateAppStateInMemory,
  getAppStateInMemory,
  isDevEnabled,
  redact,
  redactText,
  maskId,
};
