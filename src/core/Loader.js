"use strict";
import fs from "fs-extra";
import path from "path";
import { pathToFileURL } from "url";

const HANDLER_KEYS = ["onStart", "run", "execute", "main", "handle", "onMessage", "init", "call"];

function resolveModule(raw, file) {
  const mod = (raw.default && typeof raw.default === "object") ? raw.default
    : (typeof raw.default === "function")                       ? raw.default
    : raw;
  if (typeof mod === "function") {
    const name = path.basename(file, ".js").toLowerCase();
    return { name, mod: { run: mod }, handler: mod, onChat: null, onReply: null };
  }
  const handlerKey   = HANDLER_KEYS.find(k => typeof mod[k] === "function");
  const namedHandler = !handlerKey ? HANDLER_KEYS.find(k => typeof raw[k] === "function") : null;
  if (!handlerKey && !namedHandler && !mod.onChat && !raw.onChat) return null;
  const resolved = namedHandler ? { ...raw, ...mod } : mod;
  const rawName  = resolved.config?.name || path.basename(file, ".js");
  const name     = String(rawName).toLowerCase();
  return {
    name,
    mod:     resolved,
    handler: resolved[handlerKey || namedHandler] || null,
    onChat:  resolved.onChat  || raw.onChat  || null,
    onReply: resolved.onReply || raw.onReply || null,
  };
}

function collectCommandFiles(commandsDir) {
  const out = [];
  if (!fs.existsSync(commandsDir)) return out;
  for (const file of fs.readdirSync(commandsDir)) {
    const fullPath = path.join(commandsDir, file);
    if (file.endsWith(".js") && fs.statSync(fullPath).isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function loadOverrides(commandsDir) {
  const overridesPath = path.join(commandsDir, "..", "..", "cmd-overrides.json");
  global.cmdOverridesPath = path.resolve(overridesPath);
  try {
    if (fs.existsSync(overridesPath)) {
      return JSON.parse(fs.readFileSync(overridesPath, "utf8"));
    }
  } catch (_) {}
  return {};
}

export async function loadCommands(commandsDir) {
  const overrides  = loadOverrides(commandsDir);
  const fileErrors = [];
  const filePaths  = collectCommandFiles(commandsDir);
  const stamp      = Date.now();

  console.log(`[CMDS] 📦 بدء تحميل ${filePaths.length} ملف (متوازي)...`);

  const results = await Promise.allSettled(
    filePaths.map(p => import(`${pathToFileURL(p).href}?update=${stamp}`))
  );

  // نبني الخرائط الجديدة في الذاكرة أولاً ثم نُبدّلها دفعةً واحدة (atomic swap)
  // هذا يمنع نافذة الفراغ التي تحدث عند clear() ثم الانتظار حتى إعادة التحميل
  const newCommands     = new Map();
  const newEventCmds    = [];

  for (let i = 0; i < filePaths.length; i++) {
    const p      = filePaths[i];
    const file   = path.basename(p);
    const result = results[i];

    if (result.status === "rejected") {
      console.warn(`[CMDS]   ↳ ${file} ❌ ${result.reason?.message}`);
      fileErrors.push({ file, message: result.reason?.message });
      continue;
    }

    try {
      // Aggregator modules may export multiple independently-configured commands.
      // Each command retains its own name, aliases, role and cooldown settings.
      const candidates = Array.isArray(result.value.commands)
        ? result.value.commands.map(mod => ({
            name: String(mod?.config?.name || "").toLowerCase(),
            mod,
            onChat: mod?.onChat || null,
            onReply: mod?.onReply || null,
          })).filter(item => item.name)
        : [resolveModule(result.value, file)].filter(Boolean);
      if (!candidates.length) { console.log(`[CMDS]   ↳ ${file} ⏭️`); continue; }

      for (const resolved of candidates) {
        const { name, mod, onChat, onReply } = resolved;
        if (!mod.config) mod.config = {};

        const ov = overrides[name];
        if (ov) {
          if (typeof ov.enabled === "boolean") mod.config.enabled = ov.enabled;
          if (typeof ov.hidden  === "boolean") mod.config.hidden  = ov.hidden;
        }

        newCommands.set(name, mod);
        (mod.config?.aliases || []).forEach(a => newCommands.set(String(a).toLowerCase(), mod));

        if (onReply) { if (!mod.onReply) mod.onReply = onReply; }
        if (onChat)  { if (!mod.onChat)  mod.onChat  = onChat;  newEventCmds.push(mod); }
        console.log(`[CMDS]   ↳ ${file} ✅ (${name})`);
      }
    } catch (err) {
      console.warn(`[CMDS]   ↳ ${file} ❌ ${err.message}`);
      fileErrors.push({ file, message: err.message });
    }
  }

  // تبديل ذري: الرسائل الواردة أثناء التحميل تجد global.commands كاملاً دائماً
  // استبدال المرجع بإسناد واحد: لا نافذة يكون فيها global.commands فارغًا/ناقصًا.
  // (كل القرّاء — Router وhelp وwebServer — يقرؤون global.commands عند كل استدعاء.)
  global.commands      = newCommands;
  global.eventCommands = newEventCmds;

  console.log(`[INFO] تم تحميل ${global.commands.size} أمر من أصل ${filePaths.length} ملف`);
  return fileErrors;
}

export { HANDLER_KEYS };
