// MangaSource chain: each source is { name, langs, find(ctx) -> match|null, chapter(ctx, match) -> data }.
// data = { source, title, chapter, imageUrls, headers?, allowHosts, noteUrl? }
import { fetchJson } from "../net/safeFetch.js";
import { AppError } from "../infra/errors.js";
import { firecrawlClient, parseFirecrawlKeys, FirecrawlClientError } from "../utils/firecrawlClient.js";
import { hfTarget } from "./hf.js";
import { MangaDexClient, cleanQuery, pickBestManga, bestTitle, resolveChapter } from "./mangadex.js";
import {
  buildMangalikChapterUrl, buildMangalikOnePieceChapterUrl, buildMangalikSearchTerms, buildMangalikSearchUrl,
  buildStarzOnePieceChapterUrl, extractReaderImages, findMangalikChapterRedirect, getFirecrawlHtml,
  isOnePieceTitle, parseMangalikSearchResults, pickBestMangalik,
} from "../utils/mangaScrapers.js";

const notFound = (what, msg = "not_found") => new AppError("not_found", msg, { meta: { what } });

// ---- MangaDex ----------------------------------------------------------------
export function mangaDexSource(client = new MangaDexClient()) {
  return {
    name: "mangadex",
    langs: null,
    client,
    async find(ctx) {
      const q = cleanQuery(ctx.name);
      if (!q) return null;
      const lang = ctx.lang || "ar";
      const { manga } = pickBestManga(q, await client.search(q), lang);
      return manga ? { id: manga.id, title: bestTitle(manga), manga } : null;
    },
    async chapter(ctx, m) {
      const lang = ctx.lang || "ar";
      const sel = await resolveChapter(client, m.id, ctx.chapter, lang);
      if (!sel) throw notFound("chapter");
      const imageUrls = await client.pages(sel.id, { dataSaver: true });
      if (!imageUrls.length) throw notFound("pages", "no_pages");
      return { source: "MangaDex", title: m.title, chapter: ctx.chapter, imageUrls, allowHosts: ["mangadex.org", "mangadex.network"] };
    },
  };
}

// ---- Firecrawl-backed (Starz / Mangalik) ---------------------------------------
export async function scrapeHtml(url, { scrape = (u, o) => firecrawlClient.scrape(u, o) } = {}) {
  let resp;
  try {
    resp = await scrape(url, { timeout: 60000 });
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e instanceof FirecrawlClientError || e?.name === "FirecrawlClientError") {
      const code = e.code === "FIRECRAWL_TIMEOUT" ? "timeout" : e.code === "FIRECRAWL_NOT_CONFIGURED" ? "not_configured" : "upstream";
      throw new AppError(code, e.code, { cause: e, status: e.statusCode || undefined });
    }
    throw new AppError("upstream", "scrape_failed", { cause: e });
  }
  const data = resp?.data && typeof resp.data === "object" ? resp.data : resp;
  const status = Number(data?.metadata?.statusCode ?? data?.statusCode ?? resp?.metadata?.statusCode) || null;
  if (status && status >= 400) throw new AppError("not_found", `source_http_${status}`, { status, meta: { what: "chapter" } });
  const html = getFirecrawlHtml(resp);
  if (!html) throw new AppError("upstream", "empty_html");
  return html;
}

// budget: { take(uid) } charged once per command run (ctx._charged) before the first scrape.
async function charge(ctx, budget) {
  if (ctx._charged) return;
  if (!parseFirecrawlKeys().length) throw new AppError("not_configured", "firecrawl_missing");
  await budget?.take(ctx.userID);
  ctx._charged = true;
}

export function starzSource({ budget, scrape } = {}) {
  return {
    name: "starz",
    langs: ["ar"],
    async find(ctx) {
      return isOnePieceTitle(ctx.name) ? { title: "One Piece" } : null;
    },
    async chapter(ctx) {
      const url = buildStarzOnePieceChapterUrl(ctx.chapter);
      if (!url) throw new AppError("bad_args", "invalid_chapter");
      await charge(ctx, budget);
      const html = await scrapeHtml(url, { scrape });
      const imageUrls = extractReaderImages(html, url, "StarzManga");
      if (!imageUrls.length) throw notFound("pages", "no_pages");
      return { source: "StarzManga", title: "One Piece", chapter: ctx.chapter, imageUrls, headers: { Referer: url }, allowHosts: ["starzmanga.com", "manga-starz.net"], noteUrl: url };
    },
  };
}

export function mangalikSource({ budget, scrape } = {}) {
  return {
    name: "mangalik",
    langs: ["ar"],
    async find(ctx) {
      return { title: ctx.name };
    },
    async chapter(ctx) {
      await charge(ctx, budget);
      const title = ctx.name;
      let lastErr = null;
      const tryUrl = async (url, shownTitle) => {
        const html = await scrapeHtml(url, { scrape });
        const imageUrls = extractReaderImages(html, url, "Mangalik");
        if (!imageUrls.length) throw notFound("pages", "no_pages");
        return { source: "Mangalik", title: shownTitle, chapter: ctx.chapter, imageUrls, headers: { Referer: url }, allowHosts: ["mangalik.net"], noteUrl: url };
      };
      if (isOnePieceTitle(title)) {
        try { return await tryUrl(buildMangalikOnePieceChapterUrl(ctx.chapter), "One Piece"); } catch (e) { lastErr = e; }
      }
      let manga = null;
      try {
        for (const term of buildMangalikSearchTerms(title)) {
          const html = await scrapeHtml(buildMangalikSearchUrl(term), { scrape });
          const hit = pickBestMangalik(title, parseMangalikSearchResults(html));
          if (hit.manga) { manga = hit.manga; break; }
        }
      } catch (e) { lastErr = e; }
      if (manga) {
        const urls = [];
        if (/[._-]/.test(ctx.chapter)) {
          try { urls.push(findMangalikChapterRedirect(await scrapeHtml(manga.url, { scrape }), manga.url, ctx.chapter)); } catch (e) { lastErr = e; }
        }
        urls.push(buildMangalikChapterUrl(manga.url, ctx.chapter));
        for (const u of [...new Set(urls.filter(Boolean))]) {
          try { return await tryUrl(u, manga.title || title); } catch (e) { lastErr = e; }
        }
      }
      throw lastErr instanceof AppError ? lastErr : notFound(manga ? "chapter" : "manga");
    },
  };
}

// ---- 3asq bridge (Arabic only, via HF) ---------------------------------------------
export function bridgeSource({ target = () => hfTarget(), poll = { intervalMs: 2000, timeoutMs: 120000 }, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), getJson = fetchJson } = {}) {
  return {
    name: "3asq",
    langs: ["ar"],
    async find(ctx) {
      return target() && ctx.chapter ? { title: ctx.name } : null;
    },
    async chapter(ctx) {
      const t = target();
      if (!t) throw new AppError("not_configured", "hf_not_configured");
      const opts = { headers: t.headers, allowHosts: [t.host], timeoutMs: 15000, signal: ctx.signal };
      const job = await getJson(`${t.base}/manga-bridge/jobs`, { ...opts, method: "POST", body: { source: "3asq", manga: ctx.name, chapter: ctx.chapter } });
      if (!job?.job_id) throw new AppError("upstream", "no_job");
      const deadline = Date.now() + poll.timeoutMs;
      for (;;) {
        const st = await getJson(`${t.base}/manga-bridge/jobs/${encodeURIComponent(job.job_id)}`, opts);
        if (st.status === "done") {
          const n = Number(st.image_count) || 0;
          if (!n) throw notFound("pages", "no_pages");
          const imageUrls = Array.from({ length: n }, (_, i) => `${t.base}/manga-bridge/jobs/${encodeURIComponent(job.job_id)}/image/${i}`);
          return { source: "3asq", title: ctx.name, chapter: ctx.chapter, imageUrls, headers: t.headers, allowHosts: [t.host] };
        }
        if (st.status === "error") throw notFound("chapter", "bridge_error");
        if (Date.now() > deadline) throw new AppError("timeout", "bridge_poll");
        await sleep(poll.intervalMs);
      }
    },
  };
}

// ---- chain ------------------------------------------------------------------------
// deliver(data) -> result { sent, aborted, ... }. A source is abandoned for the next ONLY while
// nothing has been delivered; after a partial delivery the chain stops (no re-send from page 1).
export async function runChain(sources, ctx, deliver) {
  const errors = [];
  const lang = ctx.lang || "ar";
  for (const src of sources) {
    if (src.langs && !src.langs.includes(lang)) continue;
    try {
      const match = await src.find(ctx);
      if (!match) { errors.push({ source: src.name, error: notFound("manga") }); continue; }
      const data = await src.chapter(ctx, match);
      const result = await deliver(data);
      if (result.sent > 0 || result.aborted) return { data, result, errors };
      errors.push({ source: src.name, error: new AppError("upstream", "no_images_delivered") });
    } catch (e) {
      errors.push({ source: src.name, error: e instanceof AppError ? e : new AppError("upstream", "unexpected", { cause: e }) });
    }
  }
  throw summarizeErrors(errors);
}

export function summarizeErrors(errors) {
  const pick = (code) => errors.find((x) => x.error.code === code)?.error;
  const e =
    pick("rate_limited") || pick("not_configured") && errors.every((x) => x.error.code === "not_configured" || x.error.code === "not_found") && pick("not_configured") ||
    pick("timeout") || pick("upstream") ||
    errors.find((x) => x.error.meta?.what === "chapter")?.error ||
    errors[0]?.error || notFound("manga");
  const out = new AppError(e.code, e.message, { cause: e, meta: e.meta });
  out.errors = errors;
  return out;
}

export function chainErrorMessage(e, ctx) {
  const lang = ctx.lang || "ar";
  const label = { ar: "العربية", en: "الإنجليزية", ja: "اليابانية" }[lang] || lang;
  switch (e?.code) {
    case "not_found":
      return e.meta?.what === "chapter" || e.meta?.what === "pages"
        ? `❌ الفصل ${ctx.chapter} غير متوفر بـ${label}.`
        : "❌ لم يتم العثور على مانجا بهذا الاسم.";
    case "rate_limited":
      return "⏳ تجاوزت الحد اليومي للمصادر الإضافية أو الطلبات كثيرة. حاول لاحقاً.";
    case "timeout":
    case "upstream":
      return "❌ تعذر الاتصال بخادم المانجا.\nحاول لاحقاً.";
    case "not_configured":
      return "⚠️ هذا المصدر غير مهيأ حالياً.";
    default:
      return "❌ حدث خطأ غير متوقع أثناء جلب الفصل.";
  }
}

export function buildChain(kind, deps = {}) {
  const dex = deps.dex || mangaDexSource();
  const starz = starzSource(deps);
  const lik = mangalikSource(deps);
  const bridge = bridgeSource(deps.bridge);
  return kind === "mangalik" ? [starz, lik, dex, bridge] : [dex, bridge];
}
