import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "node:url";
import { rustStatus } from "../utils/rustBridge.js";
// CRITICAL-02 FIX: كان "..\\..\\..\\" يخرج من جذر المشروع — صحّحنا إلى "../.."
// src/cmds/up.js  →  src/  →  project_root/cache
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = path.join(MODULE_DIR, "..", "..", "cache");
const AI_DIRS    = ["ai_sessions_gptx"];
const MEDIA_DIRS = [];
const GLOBAL_SESSIONS = [];
function readFirstExisting(paths) {
    for (const p of paths) {
        try {
            const val = fs.readFileSync(p, "utf8").trim();
            if (val && val !== "max") return Number(val);
            if (val === "max") return null; 
        } catch (_) {  }
    }
    return undefined; 
}
function getContainerMemory() {
    let usage = readFirstExisting(["/sys/fs/cgroup/memory.current"]);
    let limit = readFirstExisting(["/sys/fs/cgroup/memory.max"]);
    if (usage === undefined) usage = readFirstExisting(["/sys/fs/cgroup/memory/memory.usage_in_bytes"]);
    if (limit === undefined) limit = readFirstExisting(["/sys/fs/cgroup/memory/memory.limit_in_bytes"]);
    if (typeof limit === "number" && limit > 1e15) limit = null;
    if (typeof usage !== "number") return null; 
    return { usage, limit: typeof limit === "number" ? limit : null };
}
function formatBytes(b) {
    if (b <= 0)      return "0 B";
    if (b < 1024)    return `${b} B`;
    if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
    return `${(b/1048576).toFixed(2)} MB`;
}
function formatUptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const pad = n => String(n).padStart(2, "0");
    const hhmmss = `${pad(h)}:${pad(m)}:${pad(s)}`;
    return d > 0 ? `${d}ي ${hhmmss}` : hhmmss;
}
function nowHHMMSS() {
    return new Date().toLocaleTimeString("en-GB", {
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        timeZone: process.env.TZ || "Europe/Berlin",
    });
}
function usageBar(pct) {
    const blocks = 10;
    const filled = Math.max(0, Math.min(blocks, Math.round((pct / 100) * blocks)));
    return "▓".repeat(filled) + "░".repeat(blocks - filled);
}
async function clearDir(dirPath) {
    let deleted = 0, freed = 0;
    try {
        if (!await fs.pathExists(dirPath)) return { deleted: 0, freed: 0 };
        const files = await fs.readdir(dirPath);
        for (const f of files) {
            if (["Readme.me","empty.txt",".gitkeep"].includes(f)) continue;
            const fp = path.join(dirPath, f);
            try {
                const st = await fs.stat(fp);
                if (st.isFile()) { await fs.unlink(fp); deleted++; freed += st.size; }
            } catch (_) {}
        }
    } catch (_) {}
    return { deleted, freed };
}
async function dirStats(dirPath) {
    let count = 0, size = 0;
    try {
        if (!await fs.pathExists(dirPath)) return { count: 0, size: 0 };
        const files = await fs.readdir(dirPath);
        for (const f of files) {
            if (["Readme.me","empty.txt",".gitkeep"].includes(f)) continue;
            try {
                const st = await fs.stat(path.join(dirPath, f));
                if (st.isFile()) { count++; size += st.size; }
            } catch (_) {}
        }
    } catch (_) {}
    return { count, size };
}
function clearGlobalSessions() {
    let total = 0;
    for (const key of GLOBAL_SESSIONS) {
        if (global[key] && typeof global[key] === "object") {
            total += Object.keys(global[key]).length;
            global[key] = {};
        }
    }
    return total;
}
function listCommandFiles() {
    // src/cmds/*.js + src/cmds/_modules/*.js فقط (MODULE_DIR = src/cmds)
    const out = [];
    const collect = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const f of fs.readdirSync(dir)) {
            const fp = path.join(dir, f);
            if (f.endsWith(".js") && fs.statSync(fp).isFile()) out.push(fp);
        }
    };
    try {
        collect(MODULE_DIR);
        collect(path.join(MODULE_DIR, "_modules"));
    } catch (_) {}
    return out;
}
function listSourceFiles() {
    // كل ملفات src/ (للعرض فقط)
    const srcRoot = path.join(MODULE_DIR, "..");
    const out = [];
    const walk = (dir) => {
        for (const f of fs.readdirSync(dir)) {
            const fp = path.join(dir, f);
            if (fs.statSync(fp).isDirectory()) walk(fp);
            else if (f.endsWith(".js")) out.push(fp);
        }
    };
    try { walk(srcRoot); } catch (_) {}
    return out;
}
function countCommandFiles() {
    try { return listCommandFiles().length; } catch (_) { return 0; }
}
function countSourceFiles() {
    try { return listSourceFiles().length; } catch (_) { return 0; }
}
async function doReload() {
    if (typeof global.reloadCommands === "function") {
        const errors = await global.reloadCommands() || [];
        return { ok: errors.length === 0, fileErrors: errors };
    }
    return { ok: false, err: "reloadCommands not available", fileErrors: [] };
}
export default {
  config: {
        name: "up",
        aliases: ["تحديث"],
        version: "3.0.0",
        author: "SunkenBot Developer",
        countDown: 10,
        role: 2,
        category: "إدارة وإشراف",
        description: "إعادة تحميل الأوامر (Hot Reload) + تنظيف الكاش + إحصاءات النظام",
        usage: ["{pn}تحديث — تنفيذ إعادة التحميل والتنظيف وعرض التقرير"],
        hidden: true, 
    },
    onStart: async function ({ message }) {
        const t0 = Date.now();
        const { ok: reloadOk, err: reloadErr, fileErrors } = await doReload();
        const fileCount   = countCommandFiles();
        const sourceCount = countSourceFiles();
        const eventsCount = global.eventCommands?.length || 0;
        let totalDeleted = 0, totalFreed = 0;
        const cleanLines = [];
        for (const dir of [...AI_DIRS, ...MEDIA_DIRS]) {
            const { deleted, freed } = await clearDir(path.join(CACHE_ROOT, dir));
            if (deleted > 0) {
                const label = AI_DIRS.includes(dir) ? "🤖" : "🎬";
                cleanLines.push(`  ${label} ${dir}: ${deleted} ملف (${formatBytes(freed)})`);
                totalDeleted += deleted;
                totalFreed   += freed;
            }
        }
        const clearedSessions = clearGlobalSessions();
        let remFiles = 0, remSize = 0;
        for (const dir of [...AI_DIRS, ...MEDIA_DIRS]) {
            const { count, size } = await dirStats(path.join(CACHE_ROOT, dir));
            remFiles += count; remSize += size;
        }
        if (typeof Bun !== "undefined" && typeof Bun.gc === "function") {
            try { Bun.gc(true); } catch (_) {}
        } else if (typeof global.gc === "function") {
            try { global.gc(); } catch (_) {}
        }
        const mem  = process.memoryUsage();
        const rss  = (mem.rss      / 1048576).toFixed(1);
        const heap = (mem.heapUsed / 1048576).toFixed(1);
        const ext  = (mem.external / 1048576).toFixed(1);
        const pingMs = await new Promise(resolve => {
            const start = process.hrtime.bigint();
            setImmediate(() => resolve(Math.round(Number(process.hrtime.bigint() - start) / 1_000_000)));
        });
        const uptimeStr = formatUptime(Math.floor(process.uptime()));
        const elapsed   = Date.now() - t0;
        const L = [];
        L.push("╔══════════════════════╗");
        L.push("║   ⚡ SunkenBot — UP   ║");
        L.push("╚══════════════════════╝");
        L.push(`🕐 ${nowHHMMSS()}`);
        L.push("");
        if (reloadOk) {
            L.push("✅ Hot Reload نجح");
        } else if (reloadErr) {
            L.push(`❌ فشل Reload: ${reloadErr.slice(0,60)}`);
        } else {
            L.push(`⚠️ Hot Reload انتهى مع أخطاء في ${fileErrors.length} ملف:`);
            for (const fe of fileErrors.slice(0, 5)) {
                L.push(`  ✗ ${fe.file}: ${fe.message.slice(0, 80)}`);
            }
            if (fileErrors.length > 5) L.push(`  … و${fileErrors.length - 5} ملف آخر`);
        }
        L.push(`   📂 أوامر: ${fileCount} ملف (cmds + _modules)`);
        L.push(`   📂 مصدر:  ${sourceCount} ملف (كل src/)`);
        L.push(`   📂 أحداث: ${eventsCount} مُسجَّلة`);
        L.push("");
        L.push("🗑️ التنظيف:");
        if (cleanLines.length > 0) {
            cleanLines.forEach(l => L.push(l));
            L.push(`  ✅ ${totalDeleted} ملف — ${formatBytes(totalFreed)} محررة`);
        } else {
            L.push("  ✅ الكاش نظيف");
        }
        if (clearedSessions > 0)
            L.push(`  🧠 جلسات RAM: ${clearedSessions} جلسة محذوفة`);
        L.push(`  💾 متبقٍ: ${remFiles} ملف (${formatBytes(remSize)})`);
        L.push("");
        L.push("🖥️ ذاكرة العملية (Node):");
        L.push(`  • RSS: ${rss} MB   • Heap: ${heap} MB   • External: ${ext} MB`);
        L.push("");
        const containerMem = getContainerMemory();
        L.push("📦 ذاكرة الـ Container:");
        if (containerMem) {
            const usedMB = containerMem.usage / 1048576;
            if (containerMem.limit) {
                const limitMB = containerMem.limit / 1048576;
                const pct = (containerMem.usage / containerMem.limit) * 100;
                let icon = "🟢";
                if (pct >= 90) icon = "🔴";
                else if (pct >= 75) icon = "🟠";
                else if (pct >= 60) icon = "🟡";
                L.push(`  ${usageBar(pct)} ${icon} ${pct.toFixed(1)}%`);
                L.push(`  • ${usedMB.toFixed(1)} MB / ${limitMB.toFixed(0)} MB`);
                if (pct >= 90) L.push(`  ⚠️ قريب جداً من حد OOM — خطر إعادة تشغيل قسري!`);
                else if (pct >= 75) L.push(`  ⚠️ استهلاك مرتفع — راقب الاتجاه`);
            } else {
                L.push(`  • مستخدَم: ${usedMB.toFixed(1)} MB (الحد غير محدَّد)`);
            }
        } else {
            L.push("  ⚠️ غير متاح (لا يوجد cgroup — تشغيل محلي على الأرجح)");
        }
        L.push("");
        L.push("📊 الأداء:");
        L.push(`  • Loop Lag: ${pingMs}ms   • زمن العملية: ${elapsed}ms`);
        L.push(`  • Uptime:   ${uptimeStr}`);
        const rs = rustStatus();
        L.push(rs.available ? "  • [RUST] ✅ loaded" : `  • [RUST] ⚠️ JS fallback (${rs.reason || "disabled"})`);
        message.reply(L.join("\n"));
    }
};
