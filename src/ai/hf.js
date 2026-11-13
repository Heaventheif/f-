// Client for the internal HF Space (gemini / groq / stt / tts endpoints).
import { fetchJson } from "../net/safeFetch.js";
import { AppError } from "../infra/errors.js";
import { getHfConfig } from "../utils/hfClient.js";

export async function hfPost(path, body, { timeoutMs = 45_000, fj = fetchJson } = {}) {
  const cfg = getHfConfig();
  if (!cfg) throw new AppError("not_configured", "HF_SPACE_URL missing or not https");
  const host = new URL(cfg.base).hostname;
  return fj(cfg.base + path, {
    method: "POST",
    body,
    timeoutMs,
    allowHosts: [host],
    maxBytes: 16 * 1024 * 1024,
    headers: cfg.token ? { "X-Internal-Token": cfg.token } : {},
  });
}
export async function hfGet(path, { timeoutMs = 15_000, fj = fetchJson } = {}) {
  const cfg = getHfConfig();
  if (!cfg) throw new AppError("not_configured", "HF_SPACE_URL missing or not https");
  return fj(cfg.base + path, {
    timeoutMs,
    allowHosts: [new URL(cfg.base).hostname],
    headers: cfg.token ? { "X-Internal-Token": cfg.token } : {},
  });
}
export const aiErrorText = (e) =>
  e?.code === "not_configured"
    ? "❌ خدمة الذكاء الاصطناعي غير مضبوطة."
    : e?.status === 429
      ? "❌ الخدمة مشغولة حالياً (حد الطلبات). انتظر قليلاً."
      : e?.code === "timeout"
        ? "❌ انتهت المهلة، حاول مجدداً."
        : "❌ الخادم غير متاح حالياً، حاول لاحقاً.";
