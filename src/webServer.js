"use strict";
/**
 * webServer.js — OPT-BUN-01
 * ──────────────────────────
 * تم استبدال Express 5 بـ Bun.serve الأصيل.
 *
 * المكاسب:
 *   • 2–4× throughput على نفس الـ hardware (Bun HTTP stack مبني على uSockets)
 *   • لا يوجد Express/http/https في الـ imports — تقليل حجم الحزمة
 *   • Bun.file() → streaming مباشر عبر io_uring بدون Node Streams bridge
 *   • timingSafeEqual على توكن /yt/* → يُغلق ثغرة التوقيت (timing attack)
 *   • fetch() المدمج في Bun للـ keep-alive بدلاً من http.get()
 *   • جميع الـ keep-alive timers محتفِظة بـ .unref() (HIGH-02/03)
 */

import { timingSafeEqual } from "node:crypto";
import fs                  from "fs-extra";
import vreden from "@vreden/youtube_scraper";
import { downloadYoutubeAudio, downloadYoutubeVideo } from "./utils/yyApi.js";
import {
  initializeBroadcast, listBroadcastGroups, createBroadcastCampaign,
  listBroadcastCampaigns, getBroadcastCampaign, controlBroadcastCampaign,
  broadcastLimits,
} from "./broadcastService.js";

// ── مقارنة توكن آمنة زمنياً (يُغلق timing-attack على /yt/*) ────────────────
function safeTokenEqual(a, b) {
  if (!a || !b) return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── JSON response helpers ─────────────────────────────────────────────────
const json = (data, status = 200) =>
  Response.json(data, { status });

// ── Streaming helper: pipe BunFile → Response مع cleanup ────────────────
function streamFile(filePath, headers) {
  // نحوّل Bun.file() إلى ReadableStream مع cleanup تلقائي في finally
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    try {
      const reader = Bun.file(filePath).stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    } catch (e) {
      try { await writer.abort(e); } catch (_) {}
    } finally {
      fs.remove(filePath).catch(() => {});
    }
  })();

  return new Response(readable, { headers });
}

// ── Rate-limiter بسيط (per-IP, نافذة 60 ث) ─────────────────────────────
function makeRateLimiter(windowMs, maxReqs) {
  const buckets = new Map();
  return function isLimited(key) {
    const now    = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      buckets.set(key, { start: now, count: 1 });
      return false;
    }
    bucket.count++;
    return bucket.count > maxReqs;
  };
}

// ── Keep-alive: استخدام fetch() المدمج في Bun بدلاً من http.get ──────────
function startKeepAlive(url, intervalMs, label) {
  setInterval(async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!r.ok) console.warn(`[KEEP-ALIVE:${label}] ⚠️ status: ${r.status}`);
      await r.body?.cancel();
    } catch (e) {
      if (e.name !== "TimeoutError")
        console.warn(`[KEEP-ALIVE:${label}] ⚠️ خطأ: ${e.message}`);
    }
  }, intervalMs).unref(); // HIGH-02/03 FIX: .unref() يمنع إبقاء العملية حية
}

// ── دالة التشغيل الرئيسية ─────────────────────────────────────────────────
function startWebServer() {
  const PORT             = parseInt(process.env.PORT || "10000");
  const YT_TOKEN         = process.env.INTERNAL_TOKEN || "";
  const YT_RATE_WINDOW   = 60_000;
  const YT_RATE_MAX      = parseInt(process.env.YT_RATE_LIMIT_MAX || "20");
  const ytRateLimited    = makeRateLimiter(YT_RATE_WINDOW, YT_RATE_MAX);

  // ── guard للـ /yt/* routes ────────────────────────────────────────────────
  function ytGuard(req) {
    if (!YT_TOKEN)
      return json({ error: "yt routes not configured (INTERNAL_TOKEN missing)" }, 503);
    const provided = req.headers.get("X-Internal-Token") || "";
    if (!safeTokenEqual(provided, YT_TOKEN))
      return json({ error: "unauthorized" }, 401);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
             || req.headers.get("cf-connecting-ip")
             || "unknown";
    if (ytRateLimited(ip))
      return json({ error: "rate limit exceeded, try again later" }, 429);
    return null; // OK — استمر
  }

  const BROADCAST_TOKEN = (process.env.BROADCAST_TOKEN || "").trim();
  const broadcastRateLimited = makeRateLimiter(60_000, 60);

  function broadcastGuard(req) {
    if (!BROADCAST_TOKEN || BROADCAST_TOKEN.length < 32)
      return json({ error: "خدمة Broadcast غير مفعلة: اضبط BROADCAST_TOKEN بطول 32 حرفاً على الأقل" }, 503);
    const provided = req.headers.get("X-Broadcast-Token") || "";
    if (!safeTokenEqual(provided, BROADCAST_TOKEN)) return json({ error: "رمز الدخول غير صحيح" }, 401);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
             || req.headers.get("cf-connecting-ip") || "unknown";
    if (broadcastRateLimited(ip)) return json({ error: "طلبات كثيرة؛ حاول بعد قليل" }, 429);
    return null;
  }

  const broadcastHtml = fs.readFileSync(new URL("./broadcast.html", import.meta.url), "utf8");

  // ── router رئيسي ──────────────────────────────────────────────────────────
  const server = Bun.serve({
    port: PORT,
    idleTimeout: 60,
    maxRequestBodySize: 110 * 1024 * 1024,     // ثواني — Bun.serve يدعمها مباشرة

    async fetch(req) {
      const { pathname } = new URL(req.url);
      const method       = req.method;

      // ── GET / ─────────────────────────────────────────────────────────────
      if (method === "GET" && pathname === "/") {
        const html = `<!DOCTYPE html><html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><title>${global.config?.botName ?? "SunkenBot"}</title></head>
<body style="font-family:sans-serif;padding:30px;background:#0d1117;color:#c9d1d9">
  <h2>🤖 ${global.config?.botName ?? "SunkenBot"}</h2>
  <p>الحالة: <b style="color:#3fb950">✅ يعمل</b></p>
  <p>⏱️ Uptime: ${Math.floor(process.uptime())} ثانية</p>
  <p>📦 الأوامر: ${global.commands?.size ?? 0}</p>
  <p>🔗 البوت: ${global.botApi ? "متصل" : "جاري الاتصال..."}</p>
  <p><a href="/broadcast" style="color:#58a6ff">📣 فتح لوحة Broadcast</a></p>
</body></html>`;
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // ── GET /health  GET /api/health ──────────────────────────────────────
      // NOTE: يُعيد {"status":"ok"} فقط — لا uptime ولا معلومات داخلية
      if (method === "GET" && (pathname === "/health" || pathname === "/api/health")) {
        return json({ status: "ok" });
      }

      // ── Broadcast dashboard and API ───────────────────────────────────────
      if (method === "GET" && (pathname === "/broadcast" || pathname === "/broadcast/")) {
        return new Response(broadcastHtml, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      }

      if (pathname.startsWith("/api/broadcast")) {
        const deny = broadcastGuard(req);
        if (deny) return deny;
        try {
          if (method === "GET" && pathname === "/api/broadcast/limits") {
            await initializeBroadcast();
            return json(broadcastLimits());
          }
          if (method === "GET" && pathname === "/api/broadcast/groups") {
            const groups = await listBroadcastGroups();
            return json({ groups });
          }
          if (method === "GET" && pathname === "/api/broadcast/campaigns") {
            const campaigns = await listBroadcastCampaigns();
            return json({ campaigns });
          }
          if (method === "POST" && pathname === "/api/broadcast") {
            const form = await req.formData();
            const text = String(form.get("text") || "");
            let targetIds;
            try { targetIds = JSON.parse(String(form.get("targetIds") || "[]")); }
            catch { return json({ error: "قائمة المجموعات غير صالحة" }, 400); }
            if (!Array.isArray(targetIds)) return json({ error: "قائمة المجموعات غير صالحة" }, 400);
            const files = form.getAll("files").filter(v => v && typeof v.arrayBuffer === "function" && typeof v.name === "string" && v.name);
            const campaign = await createBroadcastCampaign({ text, targetIds, files });
            return json({ campaign }, 201);
          }
          const campaignMatch = pathname.match(/^\/api\/broadcast\/campaigns\/([0-9a-f-]{36})$/i);
          if (method === "GET" && campaignMatch) {
            const campaign = await getBroadcastCampaign(campaignMatch[1]);
            return campaign ? json({ campaign }) : json({ error: "الحملة غير موجودة" }, 404);
          }
          const actionMatch = pathname.match(/^\/api\/broadcast\/campaigns\/([0-9a-f-]{36})\/(pause|resume|cancel|retry)$/i);
          if (method === "POST" && actionMatch) {
            const campaign = await controlBroadcastCampaign(actionMatch[1], actionMatch[2]);
            return json({ campaign });
          }
          return json({ error: "المسار غير موجود" }, 404);
        } catch (e) {
          console.error("[BROADCAST]", e?.stack || e?.message || e);
          const message = String(e?.message || "حدث خطأ داخلي");
          const status = /غير موجودة/.test(message) ? 404
            : /لا يمكن|ليست متوقفة|لا توجد وجهات|إجراء غير معروف|اختر|أدخل|الحد الأقصى|غير متاحة|غير صالح|فارغ/.test(message) ? 400
            : /البوت غير متصل/.test(message) ? 503 : 500;
          return json({ error: message.slice(0, 500) }, status);
        }
      }

      // ── POST /yt/search ───────────────────────────────────────────────────
      if (method === "POST" && pathname === "/yt/search") {
        const deny = ytGuard(req);
        if (deny) return deny;
        try {
          const body  = await req.json().catch(() => ({}));
          const query = (body?.query || "").trim();
          const limit = Math.min(parseInt(body?.limit || 10), 15);
          if (!query) return json({ error: "query مطلوب" }, 400);
          const result = await vreden.search(query);
          if (!result?.status || !Array.isArray(result.results)) {
            return json({ error: "لا توجد نتائج" }, 404);
          }
          const results = result.results.slice(0, limit).map((item) => ({
            url: item.url || (item.videoId ? `https://www.youtube.com/watch?v=${item.videoId}` : null),
            title: item.title || "YouTube video",
            duration: item.duration?.seconds || item.duration || 0,
            uploader: item.author?.name || item.author || "",
          })).filter((r) => r.url);
          return json({ results });
        } catch (e) {
          console.error("[YT/search]", e.message);
          return json({ error: e.message?.slice(0, 300) }, 500);
        }
      }

      // ── POST /yt/audio ────────────────────────────────────────────────────
      if (method === "POST" && pathname === "/yt/audio") {
        const deny = ytGuard(req);
        if (deny) return deny;
        let tmpPath = null;
        try {
          const body = await req.json().catch(() => ({}));
          const url  = (body?.url || "").trim();
          if (!url) return json({ error: "url مطلوب" }, 400);
          const dl = await downloadYoutubeAudio(url, "mp3");
          tmpPath = dl.filePath;
          return streamFile(tmpPath, {
            "Content-Type":        "audio/mpeg",
            "Content-Disposition": `attachment; filename="${encodeURIComponent(dl.title)}.mp3"`,
            "X-Title":     encodeURIComponent(dl.title),
          });
        } catch (e) {
          if (tmpPath) fs.remove(tmpPath).catch(() => {});
          console.error("[YT/audio]", e.message);
          return json({ error: e.message?.slice(0, 300) }, 500);
        }
      }

      // ── POST /yt/video ────────────────────────────────────────────────────
      if (method === "POST" && pathname === "/yt/video") {
        const deny = ytGuard(req);
        if (deny) return deny;
        let tmpPath = null;
        try {
          const body = await req.json().catch(() => ({}));
          const url  = (body?.url || "").trim();
          if (!url) return json({ error: "url مطلوب" }, 400);
          const dl = await downloadYoutubeVideo(url, 720);
          tmpPath = dl.filePath;
          return streamFile(tmpPath, {
            "Content-Type":        "video/mp4",
            "Content-Disposition": `attachment; filename="${encodeURIComponent(dl.title)}.mp4"`,
            "X-Title":     encodeURIComponent(dl.title),
          });
        } catch (e) {
          if (tmpPath) fs.remove(tmpPath).catch(() => {});
          console.error("[YT/video]", e.message);
          return json({ error: e.message?.slice(0, 300) }, 500);
        }
      }

      return new Response("Not Found", { status: 404 });
    },

    error(err) {
      console.error("[BunServe]", err.message);
      return json({ error: "internal server error" }, 500);
    },
  });

  console.log(`[SUCCESS] 🌐 Bun.serve جاهز على المنفذ ${PORT}`);
  if (YT_TOKEN)
    console.log("[SUCCESS] 🎵 YouTube routes جاهزة (/yt/search, /yt/audio, /yt/video)");

  // احتفظ بمرجع للسيرفر (كان global.expressApp)
  global.bunServer = server;

  // ── Keep-Alive لـ Render ──────────────────────────────────────────────────
  const externalUrl = (process.env.RENDER_EXTERNAL_URL || "").trim().replace(/\/+$/, "");
  if (externalUrl) {
    startKeepAlive(externalUrl + "/health", 10 * 60_000, "Render");
    console.log(`[KEEP-ALIVE] ✅ بنغ ذاتي مفعّل لـ ${externalUrl}`);
  }

  // ── Keep-Alive لـ HuggingFace ─────────────────────────────────────────────
  const hfBase = (process.env.HF_SPACE_URL || "").trim().replace(/\/+$/, "");
  if (hfBase) {
    startKeepAlive(hfBase + "/ping", 5 * 60_000, "HF");
  }
}

export { startWebServer };
