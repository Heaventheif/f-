"use strict";
// Single reader of HF_SPACE_URL / INTERNAL_TOKEN. https only; the token is
// never attached to a non-https base.
export function getHfConfig(env = process.env) {
  const raw = String(env.HF_SPACE_URL || "").trim().replace(/\/+$/, "");
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  return { base: raw, token: String(env.INTERNAL_TOKEN || "") };
}
function getHfBase() {
  const cfg = getHfConfig();
  if (!cfg) throw new Error("HF_SPACE_URL غير مضبوط أو ليس https");
  return cfg.base;
}
function getHfBaseOrNull() {
  return getHfConfig()?.base ?? null;
}
function getInternalToken() {
  return getHfConfig()?.token ?? "";
}
export { getHfBase, getHfBaseOrNull, getInternalToken };
