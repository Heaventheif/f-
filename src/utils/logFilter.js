"use strict";

// Keep useful diagnostics while collapsing identical FCA/MQTT noise.
const original = {
  log: console.log.bind(console),
  info: (console.info || console.log).bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
const recent = new Map();
const intEnv = (v, d) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : d;
};
const windowMs = Math.max(250, intEnv(process.env.LOG_DEDUP_WINDOW_MS, 5000));
const noisyWindowMs = Math.max(windowMs, intEnv(process.env.FCA_LOG_DEDUP_WINDOW_MS, 10000));
const noisyPrefixes = /^(\[(?:MQTT|FCA|EXTENDER|SYNC|KEEP-ALIVE)(?::[^\]]+)?\])/;
const maxEntries = 2000;

function valueText(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function keyOf(args) {
  return args.map(valueText).join(" ").replace(/\s+/g, " ").trim();
}
function shouldDrop(args) {
  const key = keyOf(args);
  if (!key) return false;
  const now = Date.now();
  const interval = noisyPrefixes.test(key) ? noisyWindowMs : windowMs;
  const last = recent.get(key);
  // Fixed window: only an emitted line (re)starts the window, so a constant
  // stream still gets through once per interval.
  const drop = last != null && now - last < interval;
  if (!drop) recent.set(key, now);
  if (recent.size > maxEntries) {
    for (const [k, at] of recent) {
      if (now - at > interval) recent.delete(k);
      if (recent.size <= maxEntries) break;
    }
  }
  return drop;
}
for (const name of Object.keys(original)) {
  console[name] = (...args) => {
    if (!shouldDrop(args)) original[name](...args);
  };
}

try {
  const npmlog = await import("npmlog");
  const logger = npmlog.default || npmlog;
  if (logger && process.env.FCA_LOG_LEVEL !== "off") {
    logger.level = String(process.env.FCA_LOG_LEVEL || "error");
  }
} catch {}

export function restoreConsole() {
  for (const [name, fn] of Object.entries(original)) console[name] = fn;
}
