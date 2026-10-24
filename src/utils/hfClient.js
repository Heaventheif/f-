"use strict";
function getHfBase() {
  const url = (process.env.HF_SPACE_URL || "").trim();
  if (!url) {
    throw new Error("HF_SPACE_URL غير مضبوط في متغيرات البيئة (Environment Variables)");
  }
  return url.replace(/\/+$/, "");
}
/**
 * نسخة لا ترمي خطأ — تُعيد null بدل ذلك، مفيدة عند رغبتك بمعالجة
 * الغياب برسالة مخصصة للمستخدم بدل استثناء عام.
 */
function getHfBaseOrNull() {
  try { return getHfBase(); } catch (_) { return null; }
}
function getInternalToken() {
  return process.env.INTERNAL_TOKEN || "";
}
export { getHfBase, getHfBaseOrNull, getInternalToken  };
