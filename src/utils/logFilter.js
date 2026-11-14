"use strict";

// Keep useful diagnostics while collapsing identical FCA/MQTT noise.
const original = {
  log: console.log.bind(console),
  info: (console.info || console.log).bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};
const recent = new Map();
const windowMs = Math.max(250, Number.parseInt(process.env.LOG_DEDUP_WINDOW_MS || "5000", 10));
const noisyWindowMs = Math.max(windowMs, Number.parseInt(process.env.FCA_LOG_DEDUP_WINDOW_MS || "10000", 10));
const noisyPrefixes = /^(\[(?:MQTT|FCA|EXTENDER|SYNC|KEEP-ALIVE)(?::[^\]]+)?\])/;
const maxEntries = 2000;

function valueText(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
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
  recent.set(key, now);
  if (recent.size > maxEntries) {
    for (const [k, at] of recent) {
      if (now - at > interval) recent.delete(k);
      if (recent.size <= maxEntries) break;
    }
  }
  return last != null && now - last < interval;
}
for (const name of Object.keys(original)) {
  console[name] = (...args) => {
    if (!shouldDrop(args)) original[name](...args);
  };
}

export function restoreConsole() {
  for (const [name, fn] of Object.entries(original)) console[name] = fn;
}
