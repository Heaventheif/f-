"use strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

// write tmp → fsync → rename (+ نسخة .bak للاستعادة)
export function atomicWriteJson(file, data, { backup = true } = {}) {
  const dir = path.dirname(file); fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (backup && fs.existsSync(file)) { try { fs.copyFileSync(file, file + ".bak"); } catch { /* best effort */ } }
  fs.renameSync(tmp, file);
}
export function readJsonWithRecovery(file, fallback = null) {
  for (const f of [file, file + ".bak"]) {
    try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { /* try next */ }
  }
  return fallback;
}
