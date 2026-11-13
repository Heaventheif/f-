// Tiny HTTP toolkit for Bun.serve: router, envelope, typed-error -> status, body readers, headers.
import { AppError } from "../infra/errors.js";

// Status derives from the typed error code, never from message text.
export const STATUS = {
  bad_request: 400, bad_json: 400, bad_multipart: 400, invalid_param: 400, blocked_url: 400,
  unauthorized: 401, invalid_credentials: 401,
  forbidden: 403, forbidden_origin: 403,
  not_found: 404, method_not_allowed: 405, conflict: 409,
  payload_too_large: 413, too_large: 413, unsupported_media: 415,
  rate_limited: 429,
  internal: 500, not_implemented: 501, upstream: 502,
  bot_offline: 503, not_configured: 503, unavailable: 503,
  timeout: 504,
};
export const statusFor = (e) => e?.status ?? STATUS[e?.code] ?? 500;
const bad = (code, message, extra) => new AppError(code, message, extra);
export const httpError = bad;

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
export function ok(data = {}, { status = 200, headers } = {}) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}
export function fail(code, message, { status, data, headers } = {}) {
  const body = { ok: false, error: { code, message } };
  if (data !== undefined) body.data = data;
  return new Response(JSON.stringify(body), {
    status: status ?? STATUS[code] ?? 500,
    headers: { ...JSON_HEADERS, ...headers },
  });
}
// AppError -> envelope. Unknown errors never leak their message.
export function errorResponse(e, log = console) {
  if (e instanceof AppError) {
    const status = statusFor(e);
    if (status >= 500 && status !== 501 && status !== 503) log.error("[WEB]", e.code, e.message);
    const headers = e.meta?.retryAfterMs
      ? { "Retry-After": String(Math.ceil(e.meta.retryAfterMs / 1000)) }
      : undefined;
    return fail(e.code, e.message, { status, data: e.meta?.data, headers });
  }
  log.error("[WEB]", e?.stack || e?.message || e);
  return fail("internal", "حدث خطأ داخلي", { status: 500 });
}

// ---- IP ----
export function clientIp(req, hops, socketIp) {
  const fallback = socketIp || "unknown";
  if (!(hops > 0)) return fallback;
  const xff = (req.headers.get("x-forwarded-for") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!xff.length) return fallback;
  return xff[Math.max(0, xff.length - hops)];
}

// ---- Origin / CSRF ----
export function checkOrigin(req, url) {
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === url.host;
    } catch {
      return false;
    }
  }
  // Browsers always send Origin on POST; no Origin and no fetch-metadata is not a browser.
  return site === "same-origin";
}

// ---- Bodies ----
export async function readCapped(req, limit) {
  const declared = Number(req.headers.get("content-length"));
  if (declared > limit) throw bad("payload_too_large", "حجم الطلب كبير جدًا");
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      reader.cancel().catch(() => {});
      throw bad("payload_too_large", "حجم الطلب كبير جدًا");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
export async function readJson(req, limit = 256 * 1024) {
  const ct = req.headers.get("content-type") || "";
  if (!/^application\/json\b/i.test(ct)) throw bad("unsupported_media", "يجب أن يكون المحتوى JSON");
  const buf = await readCapped(req, limit);
  let v;
  try {
    v = JSON.parse(buf.toString("utf8"));
  } catch {
    throw bad("bad_json", "JSON غير صالح");
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad("bad_json", "JSON غير صالح");
  return v;
}
export async function readForm(req, limit) {
  const ct = req.headers.get("content-type") || "";
  if (!/^multipart\/form-data\b/i.test(ct)) throw bad("unsupported_media", "يجب أن يكون المحتوى multipart");
  const buf = await readCapped(req, limit);
  try {
    return await new Response(buf, { headers: { "content-type": ct } }).formData();
  } catch {
    throw bad("bad_multipart", "نموذج الرفع غير صالح");
  }
}

// ---- Headers ----
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
export function withSecurityHeaders(res, { api = false, html = false } = {}) {
  const h = new Headers(res.headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  if (html) h.set("Content-Security-Policy", CSP);
  else h.set("Content-Security-Policy", "frame-ancestors 'none'; sandbox");
  if (api || html) h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
export function contentDisposition(name, type = "attachment") {
  const clean = String(name || "file").replace(/[\r\n"\\]/g, "_").slice(0, 150) || "file";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_").replace(/%/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

// Stream a file with Content-Length; cancelling the client cancels the reader; cleanup runs once.
export function streamFile(filePath, headers, cleanup = () => {}) {
  let cleaned = false;
  const clean = () => {
    if (cleaned) return;
    cleaned = true;
    Promise.resolve(cleanup()).catch(() => {});
  };
  const file = Bun.file(filePath);
  const reader = file.stream().getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          clean();
        } else controller.enqueue(value);
      } catch (e) {
        controller.error(e);
        clean();
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
      clean();
    },
  });
  return new Response(body, { headers: { ...headers, "Content-Length": String(file.size) } });
}

// ---- Router ----
export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler, opts = {}) {
    const names = [];
    const re = new RegExp(
      "^" + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), "([^/]+)")).replace(/\/$/, "") + "/?$",
    );
    this.routes.push({ method, re, names, handler, opts, pattern });
    return this;
  }
  get(p, h, o) { return this.add("GET", p, h, o); }
  post(p, h, o) { return this.add("POST", p, h, o); }
  // -> {route, params} | {allowed:[methods]} | null
  match(method, pathname) {
    const m = method === "HEAD" ? "GET" : method;
    const allowed = [];
    for (const r of this.routes) {
      const x = r.re.exec(pathname);
      if (!x) continue;
      if (r.method !== m) { allowed.push(r.method); continue; }
      const params = {};
      r.names.forEach((n, i) => {
        try { params[n] = decodeURIComponent(x[i + 1]); } catch { params[n] = x[i + 1]; }
      });
      return { route: r, params };
    }
    return allowed.length ? { allowed } : null;
  }
}

// JSON body that may legitimately be absent (-> {}).
export async function readJsonOptional(req, limit = 256 * 1024) {
  if (!req.body || req.headers.get("content-length") === "0") return {};
  return readJson(req, limit);
}
