"use strict";
import fs from "fs-extra";
import path from "path";
import { buildRoleSets } from "../utils/roles.js";
import { buildBanSets } from "../utils/banList.js";
export function loadConfig(projectRoot) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, "config.json"), "utf8"));
    global.config = { ...global.config, ...cfg, Prefix: cfg.Prefix || ["."] };
  } catch {
    console.warn("[WARN] Using default config");
  }
  buildRoleSets();
  buildBanSets();
}

// ─── Plugin Descriptor ──────────────────────────────────────────
/** @type {import('../plugin-provider.js').XxPlugin} */
export const $plugin = {
  name: 'xx-config-index',
  meta: { category: 'config', path: 'src/config/index.js' },
  setup(_ctx) {
    // provides: loadConfig
  },
};
