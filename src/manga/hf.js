// HF bridge target: the internal token is only ever sent to an https host on the allowlist.
import { getHfBaseOrNull, getInternalToken } from "../utils/hfClient.js";
import { AppError } from "../infra/errors.js";

const DEFAULT_HOSTS = ["hf.space", "huggingface.co"];

export function hfAllowedHosts(env = process.env) {
  const extra = String(env.HF_ALLOWED_HOSTS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_HOSTS, ...extra];
}

// Returns { base, host, headers } or null when unset / not https / not allowlisted.
export function hfTarget(env = process.env, base = getHfBaseOrNull(), token = getInternalToken()) {
  if (!base) return null;
  let u;
  try {
    u = new URL(base);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:") return null;
  if (!hfAllowedHosts(env).some((a) => host === a || host.endsWith("." + a))) return null;
  return {
    base: base.replace(/\/+$/, ""),
    host,
    headers: token ? { "X-Internal-Token": token } : {},
  };
}

export function requireHf() {
  const t = hfTarget();
  if (!t) throw new AppError("not_configured", "hf_not_configured");
  return t;
}
