"use strict";
import { readdir, stat, readFile } from "node:fs/promises";
import path from "path";
import { pathToFileURL } from "url";
// Barrel helper: imports ./_modules/<name>.js next to the barrel; a broken module is
// reported loudly (and surfaced via loadCommands errors) without losing the others.
export async function discoverCommands(baseUrl, names) {
  const out = [];
  const errors = (globalThis.__barrelErrors ??= []);
  await Promise.all(
    names.map(async (n, i) => {
      try {
        if (!/^[\w-]+$/.test(n)) throw new Error("bad module name");
        const m = await import(new URL(`./_modules/${n}.js`, baseUrl).href);
        out[i] = m.default ?? m;
      } catch (e) {
        console.error(`[CMDS] ❌ تعذر تحميل الوحدة ${n}: ${e?.message}`);
        errors.push({ file: `_modules/${n}.js`, message: e?.message });
      }
    }),
  );
  return out.filter(Boolean);
}
// Structural validation of a command's config; returns a list of problems.
export function validateConfig(mod) {
  const c = mod?.config ?? {};
  const bad = [];
  if (c.role !== undefined && ![0, 1, 2].includes(Number(c.role))) bad.push("role must be 0, 1 or 2");
  if (c.countDown !== undefined && !(Number(c.countDown) >= 0)) bad.push("countDown must be >= 0");
  if (c.aliases !== undefined && !(Array.isArray(c.aliases) && c.aliases.every((a) => typeof a === "string" && a.trim())))
    bad.push("aliases must be an array of non-empty strings");
  if (c.timeoutMs !== undefined && !(Number(c.timeoutMs) > 0)) bad.push("timeoutMs must be > 0");
  return bad;
}
const HANDLER_KEYS = ["onStart", "run", "execute"];
const LEGACY_HANDLER_KEYS = ["onMessage", "init", "call"];
function resolveModule(raw, file) {
  const mod =
    raw.default && typeof raw.default === "object"
      ? raw.default
      : typeof raw.default === "function"
        ? raw.default
        : raw;
  if (typeof mod === "function") {
    const name2 = path.basename(file, ".js").toLowerCase();
    return { name: name2, mod: { run: mod }, handler: mod, onChat: null, onReply: null };
  }
  for (const legacyKey of LEGACY_HANDLER_KEYS) {
    if (typeof mod[legacyKey] === "function" || typeof raw[legacyKey] === "function")
      console.warn(
        `[LOADER] ${path.basename(file)}: المفتاح "${legacyKey}" لم يعد يُعامل كمعالج أساسي — استخدم onStart/run/execute.`,
      );
  }
  const handlerKey = HANDLER_KEYS.find((k) => typeof mod[k] === "function");
  const namedHandler = !handlerKey ? HANDLER_KEYS.find((k) => typeof raw[k] === "function") : null;
  if (!handlerKey && !namedHandler && !mod.onChat && !raw.onChat) return null;
  const resolved = namedHandler ? { ...raw, ...mod } : mod;
  const rawName = resolved.config?.name || path.basename(file, ".js");
  const name = String(rawName).toLowerCase();
  return {
    name,
    mod: resolved,
    handler: resolved[handlerKey || namedHandler] || null,
    onChat: resolved.onChat || raw.onChat || null,
    onReply: resolved.onReply || raw.onReply || null,
  };
}
async function collectCommandFiles(commandsDir) {
  const out = [];
  let files;
  try {
    files = await readdir(commandsDir);
  } catch {
    return out;
  }
  for (const file of [...files].sort()) {
    const fullPath = path.join(commandsDir, file);
    if (file.endsWith(".js") && !file.startsWith("_")) {
      try {
        if ((await stat(fullPath)).isFile()) out.push(fullPath);
      } catch (_) {}
    }
  }
  return out;
}
async function loadOverrides(commandsDir) {
  const overridesPath = path.join(commandsDir, "..", "..", "cmd-overrides.json");
  global.cmdOverridesPath = path.resolve(overridesPath);
  try {
    return JSON.parse(await readFile(overridesPath, "utf8"));
  } catch (_) {
    return {};
  }
}
export async function loadCommands(commandsDir) {
  const overrides = await loadOverrides(commandsDir);
  const fileErrors = [];
  globalThis.__barrelErrors = [];
  const filePaths = await collectCommandFiles(commandsDir);
  console.log(`[CMDS] 📦 بدء تحميل ${filePaths.length} ملف (متوازي)...`);
  const results = await Promise.allSettled(filePaths.map((p) => import(pathToFileURL(p).href)));
  const newCommands = new Map();
  const newEventCmds = [];
  for (let i = 0; i < filePaths.length; i++) {
    const p = filePaths[i];
    const file = path.basename(p);
    const result = results[i];
    if (result.status === "rejected") {
      console.warn(`[CMDS]   ↳ ${file} ❌ ${result.reason?.message}`);
      fileErrors.push({ file, message: result.reason?.message });
      continue;
    }
    try {
      const candidates = Array.isArray(result.value.commands)
        ? result.value.commands
            .map((mod) => ({
              name: String(mod?.config?.name || "").toLowerCase(),
              mod,
              onChat: mod?.onChat || null,
              onReply: mod?.onReply || null,
            }))
            .filter((item) => item.name)
        : [resolveModule(result.value, file)].filter(Boolean);
      if (!candidates.length) {
        console.log(`[CMDS]   ↳ ${file} ⏭️`);
        continue;
      }
      for (const resolved of candidates) {
        const { name, mod, onChat, onReply } = resolved;
        if (!mod.config) mod.config = {};
        const problems = validateConfig(mod);
        if (problems.length) {
          console.error(`[CMDS] ❌ ${file} (${name}): ${problems.join("; ")} — تم تخطيه`);
          fileErrors.push({ file, message: `${name}: ${problems.join("; ")}` });
          continue;
        }
        const ov = overrides[name];
        if (ov) {
          if (typeof ov.enabled === "boolean") mod.config.enabled = ov.enabled;
          if (typeof ov.hidden === "boolean") mod.config.hidden = ov.hidden;
        }
        // Deterministic: files load in sorted order and the first owner of a name wins.
        const keys = [name, ...(mod.config.aliases || []).map((a) => String(a).toLowerCase())];
        let claimed = 0;
        for (const key of keys) {
          const owner = newCommands.get(key);
          if (owner && owner !== mod) {
            const msg = `اسم/اختصار مكرر "${key}" في ${file} — يحتفظ به ${owner.config?.name}`;
            console.error(`[CMDS] ❌ ${msg}`);
            fileErrors.push({ file, message: msg });
          } else if (!owner) {
            newCommands.set(key, mod);
            claimed++;
          }
        }
        if (!claimed) continue;
        if (onReply) {
          if (!mod.onReply) mod.onReply = onReply;
        }
        if (onChat) {
          if (!mod.onChat) mod.onChat = onChat;
          if (!newEventCmds.includes(mod)) newEventCmds.push(mod);
        }
        console.log(`[CMDS]   ↳ ${file} ✅ (${name})`);
      }
    } catch (err) {
      console.warn(`[CMDS]   ↳ ${file} ❌ ${err.message}`);
      fileErrors.push({ file, message: err.message });
    }
  }
  fileErrors.push(...(globalThis.__barrelErrors || []));
  global.commands = newCommands;
  global.eventCommands = newEventCmds;
  console.log(`[INFO] تم تحميل ${global.commands.size} أمر من أصل ${filePaths.length} ملف`);
  return fileErrors;
}
export { HANDLER_KEYS };
