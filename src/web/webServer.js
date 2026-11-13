"use strict";
// Bun.serve wrapper + createWebApp() DI seam (bot, store, now, env, ...) used by tests.
import { readFile } from "node:fs/promises";
import { AppError } from "../infra/errors.js";
import { RateLimiter } from "../infra/limiter.js";
import { getStore } from "../state/kv.js";
import { getHealth } from "../core/monitor.js";
import { searchYoutube } from "../utils/youtubeSearch.js";
import { serveHostedFile } from "../utils/tempHost.js";
import { downloadYoutubeAudio, downloadYoutubeVideo } from "../utils/yyApi.js";
import { fetchText } from "../net/safeFetch.js";
import { createAuth } from "./auth.js";
import { Router, ok, fail, errorResponse, clientIp, checkOrigin, withSecurityHeaders } from "./http.js";
import { createRequestService } from "./requestService.js";
import { createBroadcastService } from "./broadcastService.js";
import { registerRequestRoutes } from "./routes/requests.js";
import { registerBroadcastRoutes } from "./routes/broadcast.js";
import { registerMiscRoutes } from "./routes/misc.js";

const SAFE = new Set(["GET", "HEAD"]);

export function createWebApp({
  bot,
  store,
  now = Date.now,
  env = process.env,
  log = console,
  health = getHealth,
  broadcastOptions = {},
  requestOptions = {},
  ytTools = {
    searchYoutube,
    serveHostedFile,
    downloadAudio: (u) => downloadYoutubeAudio(u, "mp3"),
    downloadVideo: (u) => downloadYoutubeVideo(u, 720),
  },
} = {}) {
  const getBot = () => (typeof bot === "function" ? bot() : bot ?? global.botApi);
  const hops = Number.isInteger(Number(env.TRUSTED_PROXY_HOPS)) && env.TRUSTED_PROXY_HOPS !== "" && env.TRUSTED_PROXY_HOPS != null ? Number(env.TRUSTED_PROXY_HOPS) : 1;
  const auth = createAuth({ store, now, env, log });
  const requests = createRequestService({ getBot, ...requestOptions });
  const broadcast = createBroadcastService({ store, getBot, now, env, log, ...broadcastOptions });
  const ytMax = Math.max(1, parseInt(env.YT_RATE_LIMIT_MAX || "10", 10) || 10);
  const mk = (max) => new RateLimiter({ max, windowMs: 60_000, now });
  const limiters = { req_read: mk(60), req_write: mk(30), bc_read: mk(120), bc_write: mk(20), yt: mk(ytMax) };

  const textCache = new Map();
  const loadText = async (name) => {
    if (!textCache.has(name)) textCache.set(name, await readFile(new URL(`./${name}`, import.meta.url), "utf8"));
    return textCache.get(name);
  };

  const router = new Router();
  const deps = { auth, requests, broadcast, health, loadText, botName: () => global.config?.botName ?? "SunkenBot", env, ytTools };
  registerMiscRoutes(router, deps);
  registerRequestRoutes(router, deps);
  registerBroadcastRoutes(router, deps);

  async function dispatch(req, ctx) {
    let url;
    try { url = new URL(req.url); } catch { return fail("bad_request", "عنوان غير صالح"); }
    const m = router.match(req.method, url.pathname);
    if (!m) return url.pathname.startsWith("/api/") || url.pathname.startsWith("/yt/") ? fail("not_found", "المسار غير موجود") : new Response("Not Found", { status: 404 });
    if (m.allowed) return fail("method_not_allowed", "الطريقة غير مسموحة", { headers: { Allow: [...new Set([...m.allowed, "HEAD"])].join(", ") } });
    const { route, params } = m;
    const o = route.opts;
    const ip = clientIp(req, hops, ctx.ip);
    try {
      if (!SAFE.has(req.method) && o.csrf !== false && !checkOrigin(req, url)) throw new AppError("forbidden_origin", "طلب غير مسموح");
      if (o.pre) await o.pre({ req, url, ip });
      const needsAuth = o.auth ?? /^\/api\/(requests|broadcast)/.test(route.pattern);
      if (needsAuth) {
        if (!auth.configured()) throw new AppError("not_configured", "لوحة التحكم غير مهيأة: اضبط DASHBOARD_PASSWORD (12 حرفًا على الأقل)");
        if (!(await auth.check(auth.tokenFromCookie(req.headers.get("cookie"))))) throw new AppError("unauthorized", "يلزم تسجيل الدخول");
      }
      if (o.rate) {
        const r = limiters[o.rate].allow(`${o.rate}:${ip}`);
        if (!r.ok) throw new AppError("rate_limited", "تجاوزت الحد المسموح، حاول لاحقًا", { meta: { retryAfterMs: r.retryAfterMs } });
      }
      return await route.handler({ req, url, params, ip });
    } catch (e) {
      return errorResponse(e, log);
    }
  }

  async function handle(req, ctx = {}) {
    let res = await dispatch(req, ctx);
    const path = new URL(req.url, "http://x").pathname;
    const html = res.headers.get("content-type")?.startsWith("text/html");
    res = withSecurityHeaders(res, { api: path.startsWith("/api/") || path === "/health", html });
    if (req.method === "HEAD") res = new Response(null, { status: res.status, headers: res.headers });
    return res;
  }

  return { handle, auth, requests, broadcast, router };
}

function startKeepAlive(url, intervalMs, label) {
  setInterval(async () => {
    try {
      await fetchText(url, { timeoutMs: 20_000, maxBytes: 64 * 1024, allowPrivate: true });
    } catch (e) {
      if (e?.code !== "timeout") console.warn(`[KEEP-ALIVE:${label}] ⚠️ ${e?.code || e?.message}`);
    }
  }, intervalMs).unref();
}

async function startWebServer() {
  const PORT = parseInt(process.env.PORT || "10000");
  const store = await getStore();
  const app = createWebApp({ bot: () => global.botApi, store });
  if (!app.auth.configured()) console.warn("[WEB] dashboard disabled: set DASHBOARD_PASSWORD (>=12 chars)");
  app.broadcast.start();
  const server = Bun.serve({
    port: PORT,
    idleTimeout: 60,
    maxRequestBodySize: 110 * 1024 * 1024,
    fetch: (req, srv) => app.handle(req, { ip: srv.requestIP(req)?.address }),
    error(err) {
      console.error("[BunServe]", err.message);
      return fail("internal", "internal server error");
    },
  });
  console.log(`[SUCCESS] 🌐 Bun.serve جاهز على المنفذ ${PORT}`);
  global.bunServer = server;
  const externalUrl = (process.env.RENDER_EXTERNAL_URL || "").trim().replace(/\/+$/, "");
  if (externalUrl) {
    startKeepAlive(externalUrl + "/health", 10 * 6e4, "Render");
    console.log(`[KEEP-ALIVE] ✅ بنغ ذاتي مفعّل لـ ${externalUrl}`);
  }
  const hfBase = (process.env.HF_SPACE_URL || "").trim().replace(/\/+$/, "");
  if (hfBase) startKeepAlive(hfBase + "/ping", 5 * 6e4, "HF");
}
export { startWebServer };
