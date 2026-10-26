"use strict";
/**
 * Startup environment validator.
 * Logs clear warnings for missing/misconfigured env vars grouped by severity.
 * Call once at startup before any service initialisation.
 *
 * AppState is provided through the APPSTATE environment variable (cookie JSON array).
 */
function buildChecks(projectRoot) {
  return [
    {
      level: "warn",
      key: null,
      label: "FB credentials",
      test: () => Boolean(process.env.APPSTATE?.trim()),
      message:
        "لا يوجد APPSTATE — أضفه كمتغير بيئة (مصفوفة JSON للكوكيز). " +
        "تسجيل الدخول يعتمد على AppState فقط ولا يوجد بديل بالبريد وكلمة المرور. " +
        "لتجاوز نسخة قديمة مخزَّنة في قاعدة البيانات اضبط APPSTATE_FORCE_ENV=true لإقلاع واحد.",
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
