import { rm } from "node:fs/promises";
import { AppError } from "../../infra/errors.js";
import { assertSafeUrl } from "../../utils/ssrfGuard.js";
import { safeEqual, COOKIE } from "../auth.js";
import { ok, fail, readJson, contentDisposition, streamFile } from "../http.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const html = (body) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
const ASSETS = { "client.js": "client.js", "requests.js": "requests.client.js", "broadcast.js": "broadcast.client.js" };

export function registerMiscRoutes(router, { auth, health, loadText, botName, env, yt, ytTools }) {
  // ---- landing + health ----
  router.get("/", async () => html(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>${esc(botName())}</title></head><body style="font-family:sans-serif;padding:30px;background:#0d1117;color:#c9d1d9"><h2>${esc(botName())}</h2><p><a href="/broadcast" style="color:#58a6ff">Broadcast</a> · <a href="/requests" style="color:#58a6ff">Requests</a></p></body></html>`), { html: true });

  const healthRoute = async () => {
    const h = health();
    if (!h?.mqtt) return fail("bot_offline", "البوت غير متصل", { status: 503, data: h });
    return ok(h);
  };
  router.get("/health", healthRoute);
  router.get("/api/health", healthRoute);

  // ---- pages + static ----
  const page = (name) => async () => {
    if (!auth.configured()) return new Response("Dashboard password is not configured (DASHBOARD_PASSWORD, >=12 chars).", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    return html(await loadText(name));
  };
  router.get("/broadcast", page("broadcast.html"), { html: true });
  router.get("/requests", page("requests.html"), { html: true });
  router.get("/static/:name", async ({ params }) => {
    if (!ASSETS[params.name]) throw new AppError("not_found", "غير موجود");
    return new Response(await loadText(ASSETS[params.name]), { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" } });
  });

  // ---- session ----
  const secureReq = (req, url) => url.protocol === "https:" || req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  router.get("/api/dashboard/session", async ({ req }) => {
    if (!auth.configured()) throw new AppError("not_configured", "لوحة التحكم غير مهيأة: اضبط DASHBOARD_PASSWORD (12 حرفًا على الأقل)");
    return ok({ authenticated: await auth.check(auth.tokenFromCookie(req.headers.get("cookie"))) });
  }, {});
  router.post("/api/dashboard/login", async ({ req, url, ip }) => {
    const b = await readJson(req, 4096);
    const token = await auth.login(ip, b.password ?? b.pin);
    return ok({ authenticated: true }, { headers: { "Set-Cookie": auth.cookie(token, secureReq(req, url)) } });
  });
  router.post("/api/dashboard/logout", async ({ req, url }) => {
    await auth.logout(auth.tokenFromCookie(req.headers.get("cookie")));
    return ok({ authenticated: false }, { headers: { "Set-Cookie": auth.cookie("", secureReq(req, url), true) } });
  });

  // ---- hosted files ----
  router.get("/f/:name", async ({ req, params }) => ytTools.serveHostedFile(params.name, req), { raw: true });

  // ---- /yt/* (token-guarded, server to server) ----
  const guard = ({ req }) => {
    const token = String(env.INTERNAL_TOKEN || "");
    if (!token) throw new AppError("not_configured", "yt routes not configured (INTERNAL_TOKEN missing)");
    if (!safeEqual(req.headers.get("X-Internal-Token") || "", token)) throw new AppError("unauthorized", "unauthorized");
  };
  const ytOpts = { csrf: false, auth: false, rate: "yt", pre: guard };
  const safeUrl = async (raw) => {
    const u = String(raw || "").trim();
    if (!u) throw new AppError("bad_request", "url مطلوب");
    if (u.length > 2048) throw new AppError("bad_request", "url طويل جدًا");
    try { await assertSafeUrl(u); } catch (e) { throw new AppError("blocked_url", "رابط غير مسموح", { cause: e }); }
    return u;
  };

  router.post("/yt/search", async ({ req }) => {
    const b = await readJson(req);
    const query = String(b.query ?? "").trim();
    if (!query || query.length > 200) throw new AppError("bad_request", "query مطلوب (حتى 200 حرف)");
    const limit = b.limit === undefined ? 10 : Number(b.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 15) throw new AppError("bad_request", "limit بين 1 و15");
    const r = await ytTools.searchYoutube(query);
    if (!r?.status || !Array.isArray(r.results)) throw new AppError("not_found", "لا توجد نتائج");
    const results = r.results.slice(0, limit).map((i) => ({
      url: i.url || (i.videoId ? `https://www.youtube.com/watch?v=${i.videoId}` : null),
      title: i.title || "YouTube video",
      duration: i.duration?.seconds || i.seconds || i.duration || 0,
      uploader: i.author?.name || i.author || "",
    })).filter((x) => x.url);
    const res = ok({ results });
    return new Response(JSON.stringify({ ok: true, data: { results }, results }), { status: res.status, headers: res.headers }); // legacy top-level `results` kept for old consumers
  }, ytOpts);

  const download = (kind) => async ({ req }) => {
    const b = await readJson(req);
    const url = await safeUrl(b.url);
    let dl;
    try {
      dl = kind === "audio" ? await ytTools.downloadAudio(url) : await ytTools.downloadVideo(url);
    } catch (e) {
      if (e instanceof AppError) throw e;
      console.error(`[YT/${kind}]`, e?.message);
      throw new AppError("upstream", "فشل التنزيل");
    }
    const cleanup = () => rm(dl.filePath, { recursive: true, force: true });
    try {
      const title = String(dl.title || "download");
      return streamFile(dl.filePath, {
        "Content-Type": kind === "audio" ? "audio/mpeg" : "video/mp4",
        "Content-Disposition": contentDisposition(`${title}.${kind === "audio" ? "mp3" : "mp4"}`),
        "X-Title": encodeURIComponent(title),
      }, cleanup);
    } catch (e) {
      await cleanup().catch(() => {});
      throw e;
    }
  };
  router.post("/yt/audio", download("audio"), { ...ytOpts, raw: true });
  router.post("/yt/video", download("video"), { ...ytOpts, raw: true });
}
