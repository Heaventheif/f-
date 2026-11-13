"use strict";
import { existsSync } from "node:fs";
import path from "node:path";
function buildChecks(projectRoot, env) {
  return [
    {
      level: "warn",
      key: null,
      label: "FB credentials",
      test: () => Boolean(String(env.APPSTATE ?? "").trim()),
      message:
        "لا يوجد APPSTATE — أضفه كمتغير بيئة (مصفوفة JSON للكوكيز). تسجيل الدخول يعتمد على AppState فقط ولا يوجد بديل بالبريد وكلمة المرور. لتجاوز نسخة قديمة مخزَّنة في قاعدة البيانات اضبط APPSTATE_FORCE_ENV=true لإقلاع واحد.",
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
// checkEnv(projectRoot | envObject): a string is the project root (checked for
// config.json); an object is used as the environment. Returns { ok }.
export function checkEnv(arg = process.env) {
  const env = arg && typeof arg === "object" ? arg : process.env;
  const projectRoot = typeof arg === "string" ? arg : null;
  let hasCritical = false;
  const checks = buildChecks(projectRoot, env);
  if (projectRoot)
    checks.push({
      level: "info",
      key: null,
      label: "config.json",
      test: () => existsSync(path.join(projectRoot, "config.json")),
      message: "غير موجود — ستُستخدم الإعدادات الافتراضية",
    });
  for (const check of checks) {
    const ok = check.test ? check.test() : !!String(env[check.key] ?? "").trim();
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
  return { ok: !hasCritical };
}
