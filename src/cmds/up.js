import { readdir, stat } from "node:fs/promises";
import { pathExists } from "../utils/fsCompat.js";
import path from "path";
import { fileURLToPath } from "node:url";
import { collectSystemUsage, formatBytes } from "../utils/systemUsage.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = path.join(MODULE_DIR, "..", "..", "cache");
const AI_DIRS = ["ai_sessions_gptx"];

function nowHHMMSS() {
  return new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZone: process.env.TZ || "Europe/Berlin",
  });
}
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds % 86400 / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const secs = Math.floor(seconds % 60);
  const clock = [hours, minutes, secs].map(n => String(n).padStart(2, "0")).join(":");
  return days ? `${days}ي ${clock}` : clock;
}
async function clearDir(dirPath) {
  let deleted = 0, freed = 0;
  try {
    if (!await fs.pathExists(dirPath)) return { deleted, freed };
    for (const file of await fs.readdir(dirPath)) {
      if (["Readme.me", "empty.txt", ".gitkeep"].includes(file)) continue;
      const fullPath = path.join(dirPath, file);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isFile()) { await fs.unlink(fullPath); deleted++; freed += stat.size; }
      } catch {}
    }
  } catch {}
  return { deleted, freed };
}
async function dirStats(dirPath) {
  let count = 0, size = 0;
  try {
    if (!await fs.pathExists(dirPath)) return { count, size };
    for (const file of await fs.readdir(dirPath)) {
      if (["Readme.me", "empty.txt", ".gitkeep"].includes(file)) continue;
      try {
        const stat = await fs.stat(path.join(dirPath, file));
        if (stat.isFile()) { count++; size += stat.size; }
      } catch {}
    }
  } catch {}
  return { count, size };
}
async function countFiles(directory, recursive = false) {
  let count = 0;
  const walk = async current => {
    try {
      for (const file of await readdir(current)) {
        const fullPath = path.join(current, file);
        const entryStat = await stat(fullPath);
        if (entryStat.isDirectory() && recursive) await walk(fullPath);
        else if (entryStat.isFile() && file.endsWith(".js")) count++;
      }
    } catch {}
  };
  await walk(directory);
  return count;
}
function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "غير متاح";
}

export default {
  config: {
    name: "up", version: "4.0.0", author: "SunkenBot Developer",
    countDown: 10, role: 2, category: "إدارة وإشراف",
    description: "قياس استهلاك النظام الفعلي وتنظيف كاش الذكاء الاصطناعي",
    usage: ["{pn}up — قياس موارد التشغيل الفعلية"], hidden: true,
  },
  onStart: async function ({ message }) {
    const started = Date.now();
    let totalDeleted = 0, totalFreed = 0;
    for (const dir of AI_DIRS) {
      const result = await clearDir(path.join(CACHE_ROOT, dir));
      totalDeleted += result.deleted;
      totalFreed += result.freed;
    }
    let remainingFiles = 0, remainingBytes = 0;
    for (const dir of AI_DIRS) {
      const stats = await dirStats(path.join(CACHE_ROOT, dir));
      remainingFiles += stats.count;
      remainingBytes += stats.size;
    }

    const usage = await collectSystemUsage(250, MODULE_DIR);
    const lines = [
      "╔══════════════════════╗",
      "║   ⚡ SunkenBot — UP   ║",
      "╚══════════════════════╝",
      `🕐 ${nowHHMMSS()}  •  Uptime: ${formatUptime(Math.floor(process.uptime()))}`,
      "",
      "🧠 استهلاك عملية Bun (قياس حالي):",
      `  • RSS: ${formatBytes(usage.processMemory.rss)}  • Heap: ${formatBytes(usage.processMemory.heapUsed)}  • External: ${formatBytes(usage.processMemory.external)}`,
      "📦 ذاكرة الحاوية (cgroup):",
    ];
    if (usage.containerMemory) {
      const { used, limit } = usage.containerMemory;
      const pct = limit ? used / limit * 100 : null;
      lines.push(limit
        ? `  • ${formatBytes(used)} / ${formatBytes(limit)} (${formatPercent(pct)})`
        : `  • ${formatBytes(used)} مستخدمة؛ حد الذاكرة غير متاح`);
    } else lines.push("  • غير متاحة في بيئة التشغيل هذه");

    lines.push("", `⚙️ CPU (عينة فعلية ${usage.sampleMs.toFixed(0)}ms):`);
    lines.push(`  • عملية Bun: ${formatPercent(usage.processCpuPercent)} من نواة واحدة`);
    lines.push(`  • الحاوية: ${usage.containerCpuPercent === null ? "عداد cgroup غير متاح" : formatPercent(usage.containerCpuPercent)}`);

    lines.push("", "💽 مساحة نظام الملفات عند المشروع:");
    if (usage.disk) {
      const diskPct = usage.disk.total > 0n
        ? Number(usage.disk.used * 10000n / usage.disk.total) / 100
        : null;
      lines.push(`  • مستخدم ${formatBytes(usage.disk.used)} / ${formatBytes(usage.disk.total)} (${formatPercent(diskPct)})`);
      lines.push(`  • متاح ${formatBytes(usage.disk.free)}`);
    } else lines.push("  • غير متاحة");

    lines.push("", "🌐 عدادات الشبكة الظاهرة للحاوية:");
    if (usage.network) {
      lines.push(`  • منذ بدء الواجهة: RX ${formatBytes(usage.network.rx)}  • TX ${formatBytes(usage.network.tx)}`);
      if (usage.networkDelta) lines.push(`  • خلال عينة القياس: RX ${formatBytes(usage.networkDelta.rx)}  • TX ${formatBytes(usage.networkDelta.tx)}`);
      lines.push("  • هذه عدادات الواجهة منذ تشغيل الحاوية، وليست إجمالي استهلاك Render الشهري.");
    } else lines.push("  • عدادات الواجهة غير متاحة");

    const perf = global.perfManager?.getMetrics?.();
    if (perf) lines.push("", "📊 أداء الأوامر منذ بدء العملية:",
      `  • متوسط الاستجابة: ${perf.avgResponseTimeMs}ms  • الأخطاء المسجلة: ${perf.errorCount}`);
    lines.push("", "🗑️ تنظيف الكاش:",
      totalDeleted ? `  • حُذف ${totalDeleted} ملف، واستُعيد ${formatBytes(totalFreed)}` : "  • لا توجد ملفات كاش لحذفها",
      `  • المتبقي: ${remainingFiles} ملف (${formatBytes(remainingBytes)})`,
      "",
      `📂 الأوامر: ${await countFiles(MODULE_DIR)} ملف  •  المصدر: ${await countFiles(path.join(MODULE_DIR, ".."), true)} ملف  •  الأحداث: ${global.eventCommands?.length || 0}`,
      `⏱️ زمن إعداد التقرير: ${Date.now() - started}ms`);

    await message.reply(lines.join("\n"));
  },
};
