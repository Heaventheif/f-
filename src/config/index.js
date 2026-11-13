"use strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseConfig } from "../app/config.js";
import { buildRoleSets } from "../utils/roles.js";
import { buildBanSets } from "../utils/banList.js";
// Reads config.json, validates it via app/config (throws listing every problem)
// and merges the normalized values over the runtime defaults.
export async function loadConfig(projectRoot) {
  let raw = {};
  try {
    raw = JSON.parse(await readFile(path.join(projectRoot, "config.json"), "utf8"));
  } catch (e) {
    if (e?.code !== "ENOENT") throw new Error(`config.json unreadable: ${e.message}`);
    console.warn("[WARN] config.json not found, using defaults");
  }
  const cfg = parseConfig(raw);
  global.config = { ...global.config, ...raw, ...cfg };
  buildRoleSets();
  buildBanSets();
  return global.config;
}
