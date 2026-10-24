"use strict";
/**
 * Startup environment validator.
 * Logs clear warnings for missing/misconfigured env vars grouped by severity.
 * Call once at startup before any service initialisation.
 *
 * AppState is dashboard-managed only (added via /dashboard's "AppState" tab,
 * provided through APPSTATE — login credentials are read from the environment.
 */
function buildChecks(projectRoot) {
  return [
    {
      level: "warn",
      key: null,
      label: "FB credentials",
      test: () => Boolean(process.env.APPSTATE?.trim()),
      message:
        "لا يوجد أي حساب مضاف بعد — افتح لوحة التحكم (/dashboard) وأضف حساب فيسبوك من تبويب AppState " +
        "(تسجيل الدخول يعتمد على AppState فقط، لا يوجد بديل بالبريد وكلمة المرور، ولا يُقرأ من متغيرات البيئة).",
    },
    {
      level: "warn",
      key: "HF_SPACE_URL",
      label: "HF_SPACE_URL",
      message: "أوامر chess/gemini/groq/manga/novel/pin/song/tts لن تعمل",
    },
    {
      level: "warn",
      key: "INTERNAL_TOKEN",
      label: "INTERNAL_TOKEN",
      message: "طلبات hf-space ستُرفض بـ 401، وواجهات /yt/* ستبقى معطّلة (503)",
    },

  ];
}
export function checkEnv(projectRoot) {
  let hasCritical = false;
  for (const check of buildChecks(projectRoot)) {
    const ok = check.test
      ? check.test()
      : !!(process.env[check.key] || "").trim();
    if (ok) continue;
    if (check.level === "critical") {
      console.error(`[ENV] ❌ CRITICAL — ${check.label}: ${check.message}`);
      hasCritical = true;
    } else if (check.level === "warn") {
      console.warn(`[ENV] ⚠️  ${check.label}: ${check.message}`);
    } else {
      console.log(`[ENV] ℹ️  ${check.label}: ${check.message}`);
    }
  }
  if (hasCritical) {
    console.error("[ENV] أضف APPSTATE صالحاً (مصفوفة JSON) إلى متغيرات البيئة قبل التشغيل");
  }
}
