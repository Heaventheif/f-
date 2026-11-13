import fs from "node:fs";
import { fetchJson } from "../../net/safeFetch.js";
import { LRU } from "../../infra/lru.js";
import { SingleFlight } from "../../infra/limiter.js";
import { AppError } from "../../infra/errors.js";
import { hfTarget } from "../../manga/hf.js";
import { askChoice } from "../../manga/reply.js";
import { deliverImages, failureSummary } from "../../manga/deliver.js";
import {
  COMIC_HOST, parseComicArgs, findMangaInList, suggestSimilar, matchChapter, titleOf, linkOf,
  isComicPageUrl, isComicImageUrl,
} from "../../manga/comicLogic.js";

const BASE_URL = `https://${COMIC_HOST}`;
const MAX_IMAGES = 80;
const FEED_PAGE_SIZE = 200;
const MAX_FEED_PAGES = 10;
const HEADERS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", "Accept-Language": "ar,en-US;q=0.7,en;q=0.3" };
const listCache = new LRU({ maxEntries: 60, maxBytes: 16 * 1024 * 1024, ttlMs: 5 * 60e3 });
const labelCache = new LRU({ maxEntries: 200, ttlMs: 30 * 60e3 });
const flight = new SingleFlight();

async function feed(path) {
  let all = [];
  for (let page = 0, start = 1; page < MAX_FEED_PAGES; page++, start += FEED_PAGE_SIZE) {
    const d = await fetchJson(`${BASE_URL}/feeds/posts/summary/-/${path}?alt=json&max-results=${FEED_PAGE_SIZE}&start-index=${start}`, { headers: HEADERS, allowHosts: [COMIC_HOST], timeoutMs: 15000, retries: 1 });
    const entries = d?.feed?.entry || [];
    all = all.concat(entries);
    if (entries.length < FEED_PAGE_SIZE) break;
  }
  return all;
}
const cachedFeed = (key, path) => listCache.get(key) ? Promise.resolve(listCache.get(key)) : flight.run(key, async () => { const v = await feed(path); listCache.set(key, v); return v; });

async function hfPost(route, body, timeoutMs) {
  const t = hfTarget();
  if (!t) throw new AppError("not_configured", "hf_not_configured");
  return fetchJson(`${t.base}${route}`, { method: "POST", body, headers: t.headers, allowHosts: [t.host], timeoutMs });
}
async function getLabel(url) {
  const hit = labelCache.get(url);
  if (hit) return hit;
  const d = await hfPost("/comic/label", { series_url: url }, 20000);
  if (d?.label) labelCache.set(url, d.label);
  return d?.label || null;
}

function errorText(e) {
  switch (e?.code) {
    case "timeout": return "❌ انتهت المهلة. حاول مرة أخرى.";
    case "not_configured": return "⚠️ هذا الأمر غير مهيأ حالياً.";
    case "blocked_url": return "❌ رابط غير مسموح.";
    case "rate_limited": return "⏳ طلبات كثيرة، حاول لاحقاً.";
    case "upstream": return "❌ الخادم لا يستجيب حالياً. حاول لاحقاً.";
    default: return "❌ حدث خطأ غير متوقع.";
  }
}

async function sendChapter({ api, event, mangaTitle, chapter }) {
  const { threadID, messageID } = event;
  const reply = (t) => global.safeSend(api, t, threadID, null, messageID);
  const chapterUrl = linkOf(chapter);
  const chapterTitle = titleOf(chapter);
  if (!isComicPageUrl(chapterUrl)) return reply("❌ رابط الفصل غير صالح.");
  const d = await hfPost("/comic/images", { chapter_url: chapterUrl }, 25000);
  const images = (d?.images || []).filter((u) => typeof u === "string" && isComicImageUrl(u));
  if (!images.length) return reply(`❌ لم يتم العثور على صور في هذا الفصل.\n• العنوان: ${chapterTitle}`);
  const r = await deliverImages({
    urls: images, cap: MAX_IMAGES, batchSize: 15, delayMs: 1500, headers: { ...HEADERS, Referer: chapterUrl },
    allowHosts: ["blogspot.com", "googleusercontent.com", "ggpht.com", "blogger.googleusercontent.com"],
    send: (files, info) => global.safeSend(api, {
      body: info.isFirst ? `📖 ${mangaTitle} • ${chapterTitle}` : `(${info.batch}/${info.batches})`,
      attachment: files.map((f) => fs.createReadStream(f)),
    }, threadID, null, messageID),
  });
  if (!r.sent && !r.aborted) return reply("❌ فشل تحميل صور هذا الفصل. حاول مرة أخرى لاحقاً.");
  const note = failureSummary(r);
  if (note) await global.safeSend(api, `${mangaTitle} • ${chapterTitle}\n${note}`, threadID, null, undefined);
}

export default {
  config: {
    name: "comic",
    aliases: ["كوميك"],
    role: 0,
    countDown: 15,
    category: "مانجا وروايات",
    description: "كشط وإرسال صور فصل من أرشيف كوميكس فيرس (arcomixverse)",
    usage: [
      "{pn}comic <اسم السلسلة> — عرض آخر الفصول المتاحة",
      "{pn}comic <اسم السلسلة> <رقم الفصل> — إرسال فصل محدد، مثال: {pn}comic moon knight 7.5",
      "{pn}comic <اسم السلسلة> annual <رقم> — إرسال عدد سنوي محدد",
    ],
  },
  onStart: async ({ api, event, args, message }) => {
    const { threadID, messageID } = event;
    const reply = (t) => global.safeSend(api, t, threadID, null, messageID);
    if (!args?.length) {
      return reply("⚠️ الاستخدام:\n• .comic <اسم السلسلة> [رقم الفصل]\n• .comic <اسم السلسلة>  ← لعرض آخر الفصول\n\n📌 أمثلة:\n• .comic kill all immortals 1\n• .comic moon knight 7.5\n• .comic absolute batman annual 1");
    }
    const { name, chapterQuery } = parseComicArgs(args);
    if (!name) return reply("❌ اسم السلسلة فارغ.");
    try {
      const series = await cachedFeed("series", "Series");
      const manga = findMangaInList(series, name);
      if (!manga) {
        const sug = suggestSimilar(series, name, 8);
        return reply(`❌ لم يتم العثور على السلسلة: "${name}".\n${sug.length ? `\n📚 هل تقصد أحد هذه السلاسل؟\n${sug.map((e, i) => `  ${i + 1}. ${titleOf(e)}`).join("\n")}` : ""}`);
      }
      const mangaUrl = linkOf(manga);
      const mangaTitle = titleOf(manga);
      if (!isComicPageUrl(mangaUrl)) return reply("❌ رابط السلسلة غير صالح.");
      const label = await getLabel(mangaUrl);
      if (!label) return reply("❌ تعذّر قراءة معرّف السلسلة من الصفحة.");
      const chapters = await cachedFeed(`label:${label}`, encodeURIComponent(label));
      if (!chapters.length) return reply(`❌ لا توجد فصول منشورة بعد لـ "${mangaTitle}".`);
      if (!chapterQuery) {
        const lines = chapters.slice(0, 12).map((c, i) => `  ${i + 1}. ${titleOf(c)}`);
        return reply(`📖 ${mangaTitle}\n🔖 ${chapters.length} فصل متاح\n\n🆕 آخر الفصول:\n${lines.join("\n")}\n\n📌 لإرسال فصل: .comic ${name} <رقم أو annual 1 ...>`);
      }
      const { match, ambiguous, candidates } = matchChapter(chapters, chapterQuery);
      if (ambiguous) {
        const opts = candidates.slice(0, 10);
        const ok = await askChoice({
          api, message, event, header: `⚠️ "${chapterQuery}" يطابق أكثر من فصل في "${mangaTitle}":`, labels: opts.map(titleOf),
          onPick: (i, ev) => sendChapter({ api, event: ev, mangaTitle, chapter: opts[i] }).catch((e) => global.safeSend(api, errorText(e), ev.threadID, null, ev.messageID)),
        });
        if (!ok) await reply(`⚠️ "${chapterQuery}" يطابق أكثر من فصل:\n${opts.map((c) => `• ${titleOf(c)}`).join("\n")}\n\nحدّد بدقة (مثال: annual 1).`);
        return;
      }
      if (!match) {
        return reply(`❌ لا يوجد فصل يطابق "${chapterQuery}" في "${mangaTitle}".\n📚 أمثلة على العناوين: ${chapters.slice(0, 10).map(titleOf).join("، ")} ...`);
      }
      await sendChapter({ api, event, mangaTitle, chapter: match });
    } catch (e) {
      console.error("[comic]", e?.code || "", e?.message);
      await reply(errorText(e)).catch(() => {});
    }
  },
};
