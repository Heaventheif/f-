"use strict";
import "./src/app/bootstrap.js"; // TZ + globals; must stay first
import "./src/utils/logFilter.js";
import path from "path";
import { installProcessGuards } from "./src/app/processGuards.js";
import { superviseLogin } from "./src/app/supervisor.js";
import { checkEnv } from "./src/utils/envCheck.js";
import { closePostgresPool } from "./src/utils/postgres.js";
import "./src/utils/send.js";
import { startWebServer } from "./src/web/webServer.js";
import { loadConfig } from "./src/config/index.js";
import { loadCommands } from "./src/core/Loader.js";
import { PROJECT_ROOT, loadAppState, loginBot, stopAllSessions } from "./src/fca/Client.js";
import { cleanupOrphanTempFiles } from "./src/utils/tempCleanup.js";
import { loadBans } from "./src/utils/banStore.js";
import { loadOffState } from "./src/utils/offState.js";

checkEnv(PROJECT_ROOT);
const COMMANDS_DIR = path.join(PROJECT_ROOT, "src", "cmds");
const LOGIN_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS) || 6;
const LOGIN_TIMEOUT_MS = Number(process.env.LOGIN_TIMEOUT_MS) || 90_000;

let shuttingDown = false;
async function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[SHUTDOWN] ${reason} — إيقاف الجلسة...`);
  const force = setTimeout(() => process.exit(code), 1e4);
  force.unref?.();
  // Each step is isolated so one failure never blocks the rest.
  const steps = [
    () => stopAllSessions(),
    () => global.flushUsersData?.(),
    () => global.scheduler?.destroy?.(),
    () => global.bunServer?.stop?.(),
    async () => (await import("./src/utils/translator.js")).flushTranslatorCache(),
    () => closePostgresPool(),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (e) {
      console.warn("[SHUTDOWN] step failed:", e?.message || e);
    }
  }
  process.exit(code);
}

installProcessGuards({ onFatal: () => shutdown(1, "fatal error").catch(() => {}) });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => void shutdown(0, sig));

async function startBot() {
  await loadConfig(PROJECT_ROOT);
  await startWebServer();
  await cleanupOrphanTempFiles();
  await loadCommands(COMMANDS_DIR);
  await loadBans();
  await loadOffState();
  console.log("[BOT] 🚀 تسجيل الدخول بحساب واحد...");
  try {
    await superviseLogin({
      maxAttempts: LOGIN_ATTEMPTS,
      timeoutMs: LOGIN_TIMEOUT_MS + 30_000, // backstop; loginBot has its own timeout
      isStopped: () => shuttingDown,
      isFatal: (e) => e?.code === "no_appstate" || e?.code === "auth_failed",
      onFail: (e, n) =>
        console.error(`[BOT] ❌ فشل الدخول (${n}/${LOGIN_ATTEMPTS}):`, e?.message || e),
      attempt: async () => {
        // Re-read each attempt: the env/DB state may have been refreshed.
        const account = await loadAppState();
        if (!account) {
          const { AppError } = await import("./src/infra/errors.js");
          throw new AppError("no_appstate", "لا يوجد APPSTATE — أضف APPSTATE في متغيرات البيئة.");
        }
        return loginBot(account);
      },
    });
    console.log("[BOT] ✅ البوت متصل وجاهز.");
  } catch (err) {
    // A web server with a dead bot is worse than a restart.
    console.error("[BOT] ❌ تعذر تسجيل الدخول نهائيًا — إنهاء العملية:", err?.message || err);
    await shutdown(1, "login failed");
  }
}

startBot().catch(async (err) => {
  console.error("[BOT] ❌ فشل حرج أثناء بدء التشغيل:", err?.stack || err?.message || err);
  await shutdown(1, "startup failure");
});
