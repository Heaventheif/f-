"use strict";
import http from "../../utils/fetchHttp.js";
import cache from "../../utils/cache.js";
import { downloadWithLimit } from "../../utils/concurrentDownload.js";
import { sleep, downloadImageToTemp, removeFiles, sendImageBatches } from "../../utils/mangaDelivery.js";
const API_BASE       = "https://api.mangadex.org";
export const MAX_PER_GROUP = 14;
const SEARCH_TTL     = 30 * 60 * 1000;   
const AGGREGATE_TTL  = 10 * 60 * 1000;   
const MIN_MATCH_SCORE = 0.60;            
const LANG_PRIORITY = ["ar", "en", "ja"];
const LANG_ALIASES = {
  ar: "ar", arabic: "ar", عربي: "ar", عربية: "ar",
  en: "en", eng: "en", english: "en", انجليزي: "en", إنجليزي: "en",
  ja: "ja", jp: "ja", japanese: "ja", ياباني: "ja",
};
const LANG_LABELS = { ar: "العربية", en: "الإنجليزية", ja: "اليابانية" };
const HEADERS = { "User-Agent": "SunkenBot/2.0 (manga command)" };

export function sendMangaMessage(api, body, threadID, callback, messageID, bypassHumanQueue = false) {
  if (bypassHumanQueue) {
    const rawApi = api?.__rawApi || api;
    if (typeof rawApi?.sendMessage !== "function") throw new Error("Raw sendMessage API is unavailable.");
    return messageID !== undefined && messageID !== null
      ? rawApi.sendMessage(body, threadID, callback, messageID)
      : rawApi.sendMessage(body, threadID, callback);
  }
  return global.safeSend(api, body, threadID, callback, messageID);
}

function bigrams(str) {
  const s = str.toLowerCase().replace(/\s+/g, " ").trim();
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.substring(i, i + 2));
  return out;
}
function similarity(a, b) {
  if (!a || !b) return 0;
  const na = a.toLowerCase().trim();
  const nb = b.toLowerCase().trim();
  if (na === nb) return 1;
  const bgA = bigrams(na);
  const bgB = bigrams(nb);
  if (!bgA.length || !bgB.length) return 0;
  const mapB = new Map();
  for (const bg of bgB) mapB.set(bg, (mapB.get(bg) || 0) + 1);
  let matches = 0;
  for (const bg of bgA) {
    const count = mapB.get(bg) || 0;
    if (count > 0) {
      matches++;
      mapB.set(bg, count - 1);
    }
  }
  return (2 * matches) / (bgA.length + bgB.length);
}
function cleanQuery(raw) {
  return raw
    .replace(/["'`ʼ’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
// Collect all known title variants for a manga entry.
function collectTitles(manga) {
  const titles = [];
  const attrs = manga.attributes || {};
  if (attrs.title) titles.push(...Object.values(attrs.title));
  if (Array.isArray(attrs.altTitles)) {
    for (const alt of attrs.altTitles) titles.push(...Object.values(alt));
  }
  return titles.filter(Boolean);
}
// Pick the best display title for a manga entry.
function bestTitle(manga) {
  const attrs = manga.attributes || {};
  return (
    attrs.title?.en ||
    attrs.title?.ja ||
    Object.values(attrs.title || {})[0] ||
    "بدون عنوان"
  );
}
// Search the MangaDex API for manga matching the query.
async function searchManga(query) {
  const cacheKey = `manga_search:${query}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const res = await http.get(`${API_BASE}/manga`, {
    params: {
      title: query,
      limit: 20,
      "order[relevance]": "desc",
      "contentRating[]": ["safe", "suggestive", "erotica"],
    },
    headers: HEADERS,
    timeout: 15000,
  });
  const results = res.data?.data || [];
  cache.set(cacheKey, results, SEARCH_TTL);
  return results;
}
// Pick the best-matching manga from a list of search candidates.
function pickBestManga(query, candidates) {
  let best = null;
  let bestScore = 0;
  for (const manga of candidates) {
    const titles = collectTitles(manga);
    let score = 0;
    for (const t of titles) score = Math.max(score, similarity(query, cleanQuery(t)));
    if (score > bestScore) {
      bestScore = score;
      best = manga;
    }
  }
  return { manga: best, score: bestScore };
}
const CHAPTER_FETCH_LIMIT = 100; 
const CHAPTER_QUERY_TTL   = 5 * 60 * 1000; 
// Build the list of acceptable chapter-number strings to try.
function buildChapterCandidates(chapterNumberStr) {
  const raw = String(chapterNumberStr).trim();
  const candidates = new Set([raw]);
  if (!raw.includes(".")) {
    candidates.add(`${raw}.0`);
  } else if (raw.endsWith(".0")) {
    candidates.add(raw.slice(0, -2));
  }
  return [...candidates];
}
// Check whether a chapter's number exactly matches the target.
function isExactChapterMatch(attrChapter, targetNum) {
  if (attrChapter === null || attrChapter === undefined) return false;
  const n = Number(attrChapter);
  return !Number.isNaN(n) && n === targetNum;
}
// Check whether a chapter has readable pages (not external-only).
function isReadableChapter(attrs) {
  if (!attrs) return false;
  if (attrs.externalUrl) return false;
  if (typeof attrs.pages === "number" && attrs.pages <= 0) return false;
  return true;
}
// Pick the best chapter result from the raw API results.
function pickBestChapterResult(rawResults, targetNum) {
  const valid = (rawResults || []).filter(
    (item) => item?.attributes && isExactChapterMatch(item.attributes.chapter, targetNum) && isReadableChapter(item.attributes)
  );
  if (!valid.length) return null;
  valid.sort((a, b) => {
    const da = new Date(a.attributes.readableAt || a.attributes.publishAt || 0).getTime();
    const db = new Date(b.attributes.readableAt || b.attributes.publishAt || 0).getTime();
    return db - da; 
  });
  const best = valid[0];
  return { id: best.id, lang: best.attributes.translatedLanguage };
}
// Query the MangaDex API for chapters matching a filter and language.
async function queryChaptersRaw(mangaId, chapterFilter, lang) {
  const cacheKey = `manga_chapter_query:${mangaId}:${chapterFilter}:${lang || "any"}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const params = {
    manga: mangaId,
    chapter: chapterFilter,
    limit: CHAPTER_FETCH_LIMIT,
    "order[readableAt]": "desc",
    "contentRating[]": ["safe", "suggestive", "erotica", "pornographic"],
  };
  if (lang) params["translatedLanguage[]"] = [lang];
  const res = await http.get(`${API_BASE}/chapter`, {
    params,
    headers: HEADERS,
    timeout: 15000,
  });
  const data = Array.isArray(res.data?.data) ? res.data.data : [];
  cache.set(cacheKey, data, CHAPTER_QUERY_TTL);
  return data;
}
// Try each chapter-number candidate in one language until a match is found.
async function findBestChapterForLanguage(mangaId, chapterCandidates, lang, targetNum) {
  const settled = await Promise.allSettled(
    chapterCandidates.map(candidate => queryChaptersRaw(mangaId, candidate, lang))
  );
  const combined = [];
  for (const outcome of settled) {
    if (outcome.status === "fulfilled" && outcome.value.length) {
      combined.push(...outcome.value);
    }
  }
  return pickBestChapterResult(combined, targetNum);
}
// Resolve the best chapter to show, trying the requested language then others.
async function resolveChapter(mangaId, chapterNumberStr, requestedLang) {
  const targetNum = Number(chapterNumberStr);
  const chapterCandidates = buildChapterCandidates(chapterNumberStr);
  const lang = requestedLang || "ar";
  const selected = await findBestChapterForLanguage(mangaId, chapterCandidates, lang, targetNum);
  if (selected) {
    return { chapterId: selected.id, lang: selected.lang, availableLangs: [selected.lang] };
  }
  return { chapterId: null, availableLangs: [] };
}
// Build the list of page image URLs for a resolved chapter.
async function buildPageUrls(chapterId) {
  const res = await http.get(`${API_BASE}/at-home/server/${chapterId}`, {
    headers: HEADERS,
    timeout: 15000,
  });
  const baseUrl = res.data?.baseUrl;
  const chapter = res.data?.chapter;
  if (!baseUrl || !chapter?.hash || !Array.isArray(chapter.data)) return [];
  return chapter.data.map((file) => `${baseUrl}/data/${chapter.hash}/${file}`);
}
// Download a single manga page image to a temp file.
async function downloadImage(url, index) {
  return downloadImageToTemp(url, index, { prefix: "manga", timeout: 20000, headers: HEADERS });
}
const DOWNLOAD_CONCURRENCY = 6;
// Download all page images with a concurrency limit.
const downloadAllWithLimit = (pageUrls, limit = DOWNLOAD_CONCURRENCY) =>
  downloadWithLimit(pageUrls, downloadImage, limit);
const AGG_LANG = "ar"; 
const MAX_RUNS_SHOWN = 10; 
const MAX_GAPS_SHOWN = 8;  
// Fetch the full chapter/volume aggregate for a manga.
async function fetchAggregate(mangaId) {
  const cacheKey = `manga_aggregate:${mangaId}:${AGG_LANG}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const res = await http.get(`${API_BASE}/manga/${mangaId}/aggregate`, {
    params: { "translatedLanguage[]": [AGG_LANG] },
    headers: HEADERS,
    timeout: 15000,
  });
  const volumes = res.data?.volumes || {};
  cache.set(cacheKey, volumes, AGGREGATE_TTL);
  return volumes;
}
// Extract all chapter numbers from the aggregate data.
function extractChapterNumbers(volumes) {
  const numbers = [];
  for (const volKey of Object.keys(volumes || {})) {
    const chapters = volumes[volKey]?.chapters || {};
    for (const chKey of Object.keys(chapters)) {
      const n = Number(chapters[chKey]?.chapter);
      if (!Number.isNaN(n)) numbers.push(n);
    }
  }
  return numbers;
}
// Group a sorted list of chapter numbers into consecutive runs.
function findRuns(numbers) {
  const ints = [...new Set(numbers.filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  const runs = [];
  const gaps = [];
  if (!ints.length) return { runs, gaps };
  let start = ints[0];
  let prev = ints[0];
  for (let i = 1; i < ints.length; i++) {
    const cur = ints[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    runs.push({ from: start, to: prev });
    gaps.push({ from: prev + 1, to: cur - 1 });
    start = cur;
    prev = cur;
  }
  runs.push({ from: start, to: prev });
  return { runs, gaps };
}
// Format consecutive chapter runs into a readable range string.
function formatRuns(runs) {
  const shown = runs.slice(0, MAX_RUNS_SHOWN).map((r) =>
    r.from === r.to ? `الفصل ${r.from} موجود` : `من ${r.from} الى ${r.to} موجودة`
  );
  let text = shown.join("\n");
  if (runs.length > MAX_RUNS_SHOWN) text += `\n(و${runs.length - MAX_RUNS_SHOWN} نطاق آخر)`;
  return text;
}
// Format missing chapter numbers into a readable list.
function formatMissing(gaps) {
  if (!gaps.length) return null;
  const shown = gaps.slice(0, MAX_GAPS_SHOWN).map((g) => (g.from === g.to ? `${g.from}` : `${g.from}-${g.to}`));
  let text = shown.join("، ");
  if (gaps.length > MAX_GAPS_SHOWN) text += ` (و${gaps.length - MAX_GAPS_SHOWN} فجوة أخرى)`;
  return text;
}
// Search for a manga and report its available chapter range.
async function runChapterRangeSearch({ api, threadID, messageID, rawName, mangaQuery }) {
  let statusMsgId = null;
  try {
    statusMsgId = await new Promise((resolve) => {
      global.safeSend(
        api,
        `⏳ جاري البحث عن المانجا...\n📖 ${rawName}`,
        threadID,
        (err, info) => resolve(err ? null : info?.messageID || null),
        messageID
      );
    });
  } catch (_) {}
  // Update the in-progress status message shown while searching/downloading.
  const updateStatus = async (text) => {
    try {
      if (statusMsgId) await api.editMessage(text, statusMsgId);
      else global.safeSend(api, text, threadID, null, messageID);
    } catch (_) {
      global.safeSend(api, text, threadID, null, messageID);
    }
  };
  try {
    let candidates;
    try {
      candidates = await searchManga(mangaQuery);
    } catch (err) {
      throw { userMsg: "❌ تعذر الاتصال بخادم المانجا.\nحاول لاحقاً." };
    }
    if (!candidates.length) {
      throw { userMsg: "❌ لم يتم العثور على مانجا بهذا الاسم." };
    }
    const { manga, score } = pickBestManga(mangaQuery, candidates);
    if (!manga || score < MIN_MATCH_SCORE) {
      throw { userMsg: "❌ لم أتمكن من العثور على المانجا." };
    }
    const mangaId = manga.id;
    const mangaTitle = bestTitle(manga);
    await updateStatus(`🔍 وجدت: ${mangaTitle}\n📄 جاري جلب الفصول المترجمة للعربية...`);
    let volumes;
    try {
      volumes = await fetchAggregate(mangaId);
    } catch (err) {
      throw { userMsg: "❌ تعذر الاتصال بخادم المانجا.\nحاول لاحقاً." };
    }
    const numbers = extractChapterNumbers(volumes);
    if (!numbers.length) {
      throw { userMsg: "❌ لا توجد أي فصول مترجمة للعربية لهذه المانجا." };
    }
    numbers.sort((a, b) => a - b);
    const { runs, gaps } = findRuns(numbers);
    let msg = `مانجا ${mangaTitle} الفصول المترجمة للعربية المرفوعة :\n`;
    if (runs.length) {
      msg += formatRuns(runs);
      const missingText = formatMissing(gaps);
      if (missingText) msg += `\nالفصول المفقودة ${missingText}`;
    } else {
      msg += `فصول خاصة فقط (${numbers[0]} - ${numbers[numbers.length - 1]})`;
    }
    await updateStatus(msg);
  } catch (err) {
    const userMsg = err?.userMsg || `❌ حدث خطأ غير متوقع: ${err?.message?.substring(0, 80) || ""}`;
    try {
      if (statusMsgId) await api.editMessage(userMsg, statusMsgId);
      else global.safeSend(api, userMsg, threadID, null, messageID);
    } catch (_) {
      global.safeSend(api, userMsg, threadID, null, messageID);
    }
  }
}
const BRIDGE_URL_3ASQ = (process.env.HF_SPACE_URL || "").replace(/\/+$/, "");
const INTERNAL_TOKEN_3ASQ = process.env.INTERNAL_TOKEN || "";
const SOURCE_3ASQ = "3asq";
const BRIDGE_HEADERS_3ASQ = INTERNAL_TOKEN_3ASQ ? { "X-Internal-Token": INTERNAL_TOKEN_3ASQ } : {};
const POLL_INTERVAL_MS_3ASQ = 2000;
const POLL_TIMEOUT_MS_3ASQ = 120 * 1000;
async function createJob3asq(manga, chapter) {
  const { data } = await http.post(
    `${BRIDGE_URL_3ASQ}/manga-bridge/jobs`,
    { source: SOURCE_3ASQ, manga, chapter },
    { headers: BRIDGE_HEADERS_3ASQ, timeout: 15000 }
  );
  return data.job_id;
}
async function pollJob3asq(jobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS_3ASQ;
  while (Date.now() < deadline) {
    const { data } = await http.get(`${BRIDGE_URL_3ASQ}/manga-bridge/jobs/${jobId}`, {
      headers: BRIDGE_HEADERS_3ASQ, timeout: 15000,
    });
    if (data.status === "done" || data.status === "error") return data;
    await sleep(POLL_INTERVAL_MS_3ASQ);
  }
  throw new Error("انتهت مهلة انتظار الكشط من المصدر البديل.");
}
async function downloadJobImage3asq(jobId, idx) {
  return downloadImageToTemp(`${BRIDGE_URL_3ASQ}/manga-bridge/jobs/${jobId}/image/${idx}`, idx, {
    tmpName: `manga_3asq_${jobId}_${idx}.jpg`,
    timeout: 25000,
    headers: BRIDGE_HEADERS_3ASQ,
  });
}
const downloadAllWithLimit3asq = (jobId, count, limit = 6) =>
  downloadWithLimit(Array.from({ length: count }, (_, i) => i), (i) => downloadJobImage3asq(jobId, i), limit);
// Try the 3asq bridge as a fallback source when MangaDex has no match/chapter.
// Returns true if it successfully sent the chapter, false otherwise.
async function tryFallback3asq({ api, threadID, messageID, rawName, chapterNumber, bypassHumanQueue = false }) {
  if (!BRIDGE_URL_3ASQ || !chapterNumber) return false;
  try {
    const jobId = await createJob3asq(rawName, chapterNumber);
    const result = await pollJob3asq(jobId);
    if (result.status === "error" || !result.image_count) return false;
    const downloaded = await downloadAllWithLimit3asq(jobId, result.image_count);
    const validFiles = downloaded.filter(Boolean);
    if (!validFiles.length) return false;
    await sendImageBatches({
      files: validFiles, batchSize: MAX_PER_GROUP, threadID, replyToID: messageID,
      send: (payload, tid, cb, mid) => sendMangaMessage(api, payload, tid, cb, mid, bypassHumanQueue),
      buildBody: ({ isFirst }) => (isFirst ? `📖 ${rawName} — الفصل ${chapterNumber} (مصدر بديل)` : ""),
      delayMs: bypassHumanQueue ? 0 : 600,
      stopOnError: true,
    });
    await removeFiles(validFiles);
    return true;
  } catch (e) {
    console.warn("[manga:3asq] فشل المصدر البديل:", e.message);
    return false;
  }
}
export default {
  config: {
    name: "manga",
    // "مانجا2" now also routes here — the 3asq source is tried automatically
    // as a fallback rather than needing a separate command.
    aliases: ["مانجا2"],
    version: "3.0.0",
    author: "Sunken",
    countDown: 15,
    role: 0,
    category: "مانجا وروايات",
    description: "قراءة فصول المانجا (صور، يجرّب مصدراً بديلاً تلقائياً عند عدم توفر الفصل)، أو عرض نطاق الفصول العربية المتوفرة/المفقودة إن لم يُذكر رقم فصل",
    usage: [
      "{pn}مانجا <اسم المانجا> <رقم الفصل> — مثال: {pn}مانجا one piece 13",
      "{pn}مانجا <اسم المانجا> <رقم الفصل> <لغة> — مثال: {pn}مانجا one piece 13 en",
      "{pn}مانجا <اسم المانجا> <رقم الفصل> ar — مثال: {pn}مانجا attack on titan 5 ar",
      "{pn}مانجا <اسم المانجا> (بدون رقم فصل) — يعرض نطاقات الفصول العربية المتوفرة/المفقودة، مثال: {pn}مانجا one piece",
    ],
  },
  onStart: async function ({ api, event, args, bypassHumanQueue = false }) {
    const { threadID, messageID } = event;
    const send = (body, targetThreadID = threadID, callback = null, targetMessageID = undefined) =>
      sendMangaMessage(api, body, targetThreadID, callback, targetMessageID, bypassHumanQueue);
    if (!args.length) {
      return send(
        "📖 قارئ المانجا\n\n" +
          "📝 الاستخدام: manga [اسم المانجا] [رقم الفصل]\n\n" +
          "💡 مثال:\n  manga one piece 13\n  manga one piece 13 en",
        threadID,
        null,
        messageID
      );
    }
    let workingArgs = [...args];
    let requestedLang = null;
    if (workingArgs.length >= 3) {
      const maybeLang = LANG_ALIASES[workingArgs[workingArgs.length - 1].toLowerCase()];
      if (maybeLang) {
        requestedLang = maybeLang;
        workingArgs = workingArgs.slice(0, -1);
      }
    }
    const lastToken = workingArgs[workingArgs.length - 1];
    const isChapterNumber = lastToken && /^\d+(\.\d+)?$/.test(lastToken);
    if (!isChapterNumber) {
      const rawName = workingArgs.join(" ").trim();
      const mangaQuery = cleanQuery(rawName);
      if (!mangaQuery) {
        return send(
          "📖 قارئ المانجا\n\n" +
            "📝 الاستخدام:\n" +
            "  manga [اسم المانجا] [رقم الفصل] — لقراءة فصل معيّن\n" +
            "  manga [اسم المانجا] — لعرض نطاقات الفصول العربية المتوفرة\n\n" +
            "💡 مثال:\n  manga one piece 13\n  manga one piece",
          threadID,
          null,
          messageID
        );
      }
      return runChapterRangeSearch({ api, threadID, messageID, rawName, mangaQuery });
    }
    const chapterNumber = lastToken;
    const rawName = workingArgs.slice(0, -1).join(" ").trim();
    if (!rawName) {
      return send(
        "📖 قارئ المانجا\n\n" +
          "📝 الاستخدام: manga [اسم المانجا] [رقم الفصل]\n\n" +
          "💡 مثال:\n  manga one piece 13",
        threadID,
        null,
        messageID
      );
    }
    const mangaQuery = cleanQuery(rawName);
    if (!mangaQuery) {
      return send("❗ يرجى تحديد رقم الفصل.", threadID, null, messageID);
    }
    try {
      let candidates;
      try {
        candidates = await searchManga(mangaQuery);
      } catch (err) {
        throw { userMsg: "❌ تعذر الاتصال بخادم المانجا.\nحاول لاحقاً." };
      }
      if (!candidates.length) {
        throw { userMsg: "❌ لم يتم العثور على مانجا بهذا الاسم." };
      }
      const { manga, score } = pickBestManga(mangaQuery, candidates);
      if (!manga || score < MIN_MATCH_SCORE) {
        throw { userMsg: "❌ لم أتمكن من العثور على المانجا." };
      }
      const mangaId = manga.id;
      const mangaTitle = bestTitle(manga);
      let chapterId, lang, availableLangs;
      try {
        ({ chapterId, lang, availableLangs } = await resolveChapter(
          mangaId,
          chapterNumber,
          requestedLang
        ));
      } catch (err) {
        throw { userMsg: "❌ تعذر الاتصال بخادم المانجا.\nحاول لاحقاً." };
      }
      if (!chapterId) {
        const langLabel = LANG_LABELS[requestedLang || "ar"] || requestedLang;
        throw { userMsg: `❌ الفصل ${chapterNumber} غير متوفر بـ${langLabel}.` };
      }
      let pageUrls;
      try {
        pageUrls = await buildPageUrls(chapterId);
      } catch (err) {
        throw { userMsg: "❌ تعذر الاتصال بخادم المانجا.\nحاول لاحقاً." };
      }
      if (!pageUrls.length) {
        throw { userMsg: "❌ الفصل لا يحتوي على صفحات." };
      }
      const downloaded = await downloadAllWithLimit(pageUrls);
      const validFiles = downloaded.filter(Boolean);
      if (!validFiles.length) {
        throw { userMsg: "❌ فشل تحميل صفحات الفصل. حاول مرة أخرى." };
      }
      const allSent = await sendImageBatches({
        files: validFiles, batchSize: MAX_PER_GROUP, threadID, replyToID: messageID,
        send: (payload, tid, cb, mid) => send(payload, tid, cb, mid),
        buildBody: ({ groupNum, totalGroups }) =>
          totalGroups > 1
            ? `📖 ${mangaTitle} — الفصل ${chapterNumber} (${groupNum}/${totalGroups})`
            : `📖 ${mangaTitle} — الفصل ${chapterNumber}`,
        delayMs: bypassHumanQueue ? 0 : 600,
      });
      await removeFiles(validFiles);
      if (!allSent || validFiles.length !== pageUrls.length) {
        await send(
          "⚠️ تم إرسال جزء من الفصل فقط.\nيمكنك إعادة المحاولة.",
          threadID,
          null,
          null
        );
      }
    } catch (err) {
      const userMsg = err?.userMsg || `❌ حدث خطأ غير متوقع: ${err?.message?.substring(0, 80) || ""}`;
      const shouldTryFallback =
        userMsg.includes("لم يتم العثور على مانجا") ||
        userMsg.includes("غير متوفر بـ") ||
        userMsg.includes("تعذر الاتصال بخادم المانجا");
      if (shouldTryFallback) {
        const sentFallback = await tryFallback3asq({ api, threadID, messageID, rawName, chapterNumber, bypassHumanQueue });
        if (sentFallback) return;
      }
      await send(userMsg, threadID, null, messageID);
    }
  },
};
