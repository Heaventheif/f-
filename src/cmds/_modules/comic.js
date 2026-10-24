import http from '../../utils/fetchHttp.js';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { getHfBase, getInternalToken } from '../../utils/hfClient.js';
import { downloadWithLimit } from '../../utils/concurrentDownload.js';
const BASE_URL = 'https://arcomixverse.blogspot.com';
const BATCH_SIZE = 15;       
const BATCH_DELAY_MS = 1500; 
const FEED_PAGE_SIZE = 200;
const MAX_FEED_PAGES = 10;
const MAX_IMAGES = 80;       
const SERIES_CACHE_TTL_MS = 5 * 60 * 1000; 
const LABEL_CACHE_TTL_MS = 30 * 60 * 1000; 
const seriesCache = { fetchedAt: 0, list: null };
const labelCache = new Map(); 
const commonHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ar,en-US;q=0.7,en;q=0.3',
};
const normalize = (s) => (s || '').toString().trim().toLowerCase();
const normalizeNums = (s) => (s || '').toString().replace(/[٠-٩]/g, d => d.charCodeAt(0) - 1632);
async function fetchSeriesList({ force = false } = {}) {
  const now = Date.now();
  if (!force && seriesCache.list && (now - seriesCache.fetchedAt) < SERIES_CACHE_TTL_MS) {
    return seriesCache.list;
  }
  let list = [];
  let startIndex = 1;
  for (let page = 0; page < MAX_FEED_PAGES; page++) {
    const url = `${BASE_URL}/feeds/posts/summary/-/Series?alt=json&max-results=${FEED_PAGE_SIZE}&start-index=${startIndex}`;
    const { data } = await http.get(url, { timeout: 15000, headers: commonHeaders });
    const entries = (data && data.feed && data.feed.entry) || [];
    list = list.concat(entries);
    if (entries.length < FEED_PAGE_SIZE) break;
    startIndex += FEED_PAGE_SIZE;
  }
  seriesCache.list = list;
  seriesCache.fetchedAt = now;
  return list;
}
function findMangaInList(list, query) {
  const q = normalize(query);
  if (!q) return null;
  let m = list.find(e => normalize(e.title['$t']) === q);
  if (m) return m;
  m = list.find(e => normalize(e.title['$t']).includes(q));
  if (m) return m;
  const qWords = q.split(/\s+/).filter(w => w.length >= 2);
  if (qWords.length >= 2) {
    m = list.find(e => {
      const t = normalize(e.title['$t']);
      return qWords.every(w => t.includes(w));
    });
    if (m) return m;
  }
  return null;
}
function suggestSimilar(list, query, max = 8) {
  const q = normalize(query);
  const words = q.split(/\s+/).filter(w => w.length >= 3);
  const scored = list.map(e => {
    const t = normalize(e.title['$t']);
    let score = 0;
    for (const w of words) if (t.includes(w)) score += w.length;
    return { entry: e, score };
  }).filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
  return scored.map(x => x.entry);
}
async function getMangaLabel(mangaUrl) {
  const now = Date.now();
  const cached = labelCache.get(mangaUrl);
  if (cached && (now - cached.fetchedAt) < LABEL_CACHE_TTL_MS) {
    return cached.label;
  }
  const { data } = await http.post(
    `${getHfBase()}/comic/label`,
    { series_url: mangaUrl },
    { timeout: 20000, headers: { 'Content-Type': 'application/json', 'X-Internal-Token': getInternalToken() } }
  );
  const label = data.label;
  if (label) {
    labelCache.set(mangaUrl, { fetchedAt: now, label });
  }
  return label;
}
async function getChaptersForLabel(label) {
  let all = [];
  let startIndex = 1;
  for (let page = 0; page < MAX_FEED_PAGES; page++) {
    const url = `${BASE_URL}/feeds/posts/summary/-/${encodeURIComponent(label)}?alt=json&max-results=${FEED_PAGE_SIZE}&start-index=${startIndex}`;
    const { data } = await http.get(url, { timeout: 15000, headers: commonHeaders });
    const entries = (data && data.feed && data.feed.entry) || [];
    all = all.concat(entries);
    if (entries.length < FEED_PAGE_SIZE) break; 
    startIndex += FEED_PAGE_SIZE;
  }
  return all;
}
function matchChapter(chapters, query) {
  const q = String(query).trim();
  if (!q) return { match: null, ambiguous: false, candidates: [] };
  const exact = chapters.find(c => c.title['$t'].trim() === q);
  if (exact) return { match: exact, ambiguous: false, candidates: [] };
  const qLower = q.toLowerCase();
  const wantsAnnual = /سنوي|annual/i.test(qLower);
  const qNorm = normalizeNums(q);
  const qNumMatch = qNorm.match(/(\d+(?:\.\d+)?)/);
  if (!qNumMatch) return { match: null, ambiguous: false, candidates: [] };
  const qNum = qNumMatch[1];
  const isAnnualTitle = (t) => /سنوي|annual/i.test(t);
  const candidates = chapters.filter(c => {
    const t = normalizeNums(c.title['$t']);
    const tIsAnnual = isAnnualTitle(t);
    if (wantsAnnual !== tIsAnnual) return false;
    const m = t.match(/#?(\d+(?:\.\d+)?)/);
    return m && m[1] === qNum;
  });
  if (candidates.length === 1) {
    return { match: candidates[0], ambiguous: false, candidates: [] };
  }
  if (candidates.length > 1) {
    const exactByTitle = candidates.find(c => {
      const t = c.title['$t'];
      return t.endsWith(`#${qNum}`) || t.endsWith(qNum);
    });
    return { match: exactByTitle || candidates[0], ambiguous: true, candidates };
  }
  return { match: null, ambiguous: false, candidates: [] };
}
async function fetchChapterImages(chapterUrl) {
  const { data } = await http.post(
    `${getHfBase()}/comic/images`,
    { chapter_url: chapterUrl },
    { timeout: 25000, headers: { 'Content-Type': 'application/json', 'X-Internal-Token': getInternalToken() } }
  );
  return data.images || [];
}
async function downloadImage(url, index, refererUrl) {
  const ext = path.extname(url).split('?')[0] || '.jpg';
  const filePath = path.join(os.tmpdir(), `comic_${Date.now()}_${index}${ext}`);
  const res = await http.get(url, {
    responseType: 'arraybuffer',
    timeout: 25000,
    headers: { ...commonHeaders, Referer: refererUrl }
  });
  const contentType = res.headers['content-type'] || '';
  if (!contentType.startsWith('image/')) {
    throw new Error(`رد غير متوقع (${contentType}) بدل صورة من: ${url}`);
  }
  await fs.writeFile(filePath, res.data);
  return filePath;
}
const DOWNLOAD_CONCURRENCY = 6;
const downloadAllWithLimit = (urls, refererUrl, limit = DOWNLOAD_CONCURRENCY) =>
  downloadWithLimit(urls, (url, i) => downloadImage(url, i, refererUrl), limit);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
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
  onStart: async ({ api, event, args }) => {
    const { threadID, messageID } = event;
    if (args.length === 0) {
      return global.safeSend(
        api,
        `⚠️ الاستخدام:\n` +
        `• .comic <اسم السلسلة> [رقم الفصل]\n` +
        `• .comic <اسم السلسلة>                ← لعرض آخر الفصول\n\n` +
        `📌 أمثلة:\n` +
        `• .comic kill all immortals 1\n` +
        `• .comic moon knight 7.5\n` +
        `• .comic absolute batman annual 1`,
        threadID, null, messageID
      );
    }
    let chapterQuery = null;
    let mangaNameParts = args;
    const looksLikeBareNumber = (s) => /^#?\d+(?:\.\d+)?$/.test(String(s).trim());
    const isAnnualWord = (s) => /^(annual|سنوي)$/i.test(String(s).trim());
    const looksLikeFullTitle = (s) => /^العدد(\s*السنوي)?\s*#?\d+(?:\.\d+)?$/i.test(String(s).trim());
    if (args.length >= 2) {
      const last = args[args.length - 1];
      const prev = args[args.length - 2];
      if (isAnnualWord(prev) && looksLikeBareNumber(last)) {
        chapterQuery = `${prev} ${last}`.trim();
        mangaNameParts = args.slice(0, -2);
      } else if (isAnnualWord(last) && looksLikeBareNumber(prev)) {
        chapterQuery = `${prev} ${last}`.trim();
        mangaNameParts = args.slice(0, -2);
      } else if (looksLikeBareNumber(last) || looksLikeFullTitle(last)) {
        chapterQuery = last;
        mangaNameParts = args.slice(0, -1);
      }
    }
    const rawMangaName = mangaNameParts.join(' ').trim();
    if (!rawMangaName) {
      return global.safeSend(api, '❌ اسم السلسلة فارغ.', threadID, null, messageID);
    }
    try {
      const seriesList = await fetchSeriesList();
      const manga = findMangaInList(seriesList, rawMangaName);
      if (!manga) {
        const suggestions = suggestSimilar(seriesList, rawMangaName, 8);
        let msg = `❌ لم يتم العثور على السلسلة: "${rawMangaName}".\n`;
        if (suggestions.length) {
          msg += `\n📚 هل تقصد أحد هذه السلاسل؟\n` +
            suggestions.map((e, i) => `  ${i + 1}. ${e.title['$t']}`).join('\n');
        }
        return global.safeSend(api, msg, threadID, null, messageID);
      }
      const mangaUrl = manga.link.find(l => l.rel === 'alternate').href;
      const mangaTitle = manga.title['$t'];
      const label = await getMangaLabel(mangaUrl);
      if (!label) {
        return global.safeSend(
          api,
          `❌ تعذّر قراءة معرّف السلسلة من الصفحة:\n${mangaUrl}`,
          threadID, null, messageID
        );
      }
      const chapters = await getChaptersForLabel(label);
      if (chapters.length === 0) {
        return global.safeSend(
          api,
          `❌ لا توجد فصول منشورة بعد لـ "${mangaTitle}".`,
          threadID, null, messageID
        );
      }
      if (!chapterQuery) {
        const latest = chapters.slice(0, 12);
        const lines = latest.map((c, i) => {
          const t = c.title['$t'];
          return `  ${i + 1}. ${t}`;
        });
        return global.safeSend(
          api,
          `📖 ${mangaTitle}\n` +
          `🔖 ${chapters.length} فصل متاح\n\n` +
          `🆕 آخر الفصول:\n${lines.join('\n')}\n\n` +
          `📌 لإرسال فصل: .comic ${rawMangaName} <رقم أو annual 1 ...>`,
          threadID, null, messageID
        );
      }
      const { match, ambiguous, candidates } = matchChapter(chapters, chapterQuery);
      if (!match) {
        const sample = chapters.slice(0, 10).map(c => c.title['$t']).join('، ');
        return global.safeSend(
          api,
          `❌ لا يوجد فصل يطابق "${chapterQuery}" في "${mangaTitle}".\n` +
          `📚 أمثلة على العناوين: ${sample} ...`,
          threadID, null, messageID
        );
      }
      if (ambiguous && candidates.length > 1) {
        const opts = candidates.map(c => `• ${c.title['$t']}`).join('\n');
        return global.safeSend(
          api,
          `⚠️ "${chapterQuery}" يطابق أكثر من فصل في "${mangaTitle}":\n${opts}\n\n` +
          `حدّد بالضبط (مثال: annual 1 لتمييز العدد السنوي).`,
          threadID, null, messageID
        );
      }
      const chapterUrl = match.link.find(l => l.rel === 'alternate').href;
      const chapterTitle = match.title['$t'];
      let images = await fetchChapterImages(chapterUrl);
      if (images.length === 0) {
        return global.safeSend(
          api,
          `❌ لم يتم العثور على صور في هذا الفصل.\n` +
          `• العنوان: ${chapterTitle}\n` +
          `• الرابط: ${chapterUrl}`,
          threadID, null, messageID
        );
      }
      if (images.length > MAX_IMAGES) {
        const totalFound = images.length;
        images = images.slice(0, MAX_IMAGES);
        await new Promise((resolve) => {
          global.safeSend(
            api,
            `⚠️ هذا الفصل يحتوي ${totalFound} صفحة، وسيتم إرسال أول ${MAX_IMAGES} صفحة فقط (حد أمان).`,
            threadID, resolve, messageID
          );
        });
      }
      const downloaded = await downloadAllWithLimit(images, chapterUrl);
      const validFiles = downloaded.filter(Boolean);
      const failedCount = images.length - validFiles.length;
      if (!validFiles.length) {
        return global.safeSend(
          api,
          `❌ فشل تحميل صور هذا الفصل. حاول مرة أخرى لاحقاً.`,
          threadID, null, messageID
        );
      }
      let allSent = true;
      for (let i = 0; i < validFiles.length; i += BATCH_SIZE) {
        const batch = validFiles.slice(i, i + BATCH_SIZE);
        const isFirst = i === 0;
        try {
          await new Promise((resolve, reject) => {
            global.safeSend(
              api,
              { attachment: batch.map((f) => fs.createReadStream(f)) },
              threadID,
              (err) => (err ? reject(err) : resolve()),
              isFirst ? messageID : null
            );
          });
        } catch (e) {
          allSent = false;
          console.error('[comic] فشل إرسال دفعة صور:', e.message);
        }
        if (i + BATCH_SIZE < validFiles.length) {
          await sleep(BATCH_DELAY_MS);
        }
      }
      await Promise.allSettled(validFiles.map((f) => fs.remove(f)));
      if (!allSent || failedCount > 0) {
        await global.safeSend(
          api,
          `⚠️ ${mangaTitle} • ${chapterTitle}\n` +
          `تعذّر تحميل/إرسال بعض الصور (${failedCount + (allSent ? 0 : validFiles.length)} من أصل ${images.length} تقريباً).`,
          threadID, null, null
        );
      }
    } catch (error) {
      console.error('[comic] خطأ:', error.message);
      let errorMsg = `❌ حدث خطأ:\n`;
      if (error.code === 'ECONNABORTED') errorMsg += `انتهت المهلة. حاول مرة أخرى.`;
      else if (error.response) errorMsg += `الخادم رد بـ ${error.response.status}`;
      else errorMsg += error.message;
      await global.safeSend(api, errorMsg, threadID, null, messageID);
    }
  }
};
