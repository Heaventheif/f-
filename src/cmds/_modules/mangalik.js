import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { downloadWithLimit } from "../../utils/concurrentDownload.js";
import { FirecrawlClientError, firecrawlClient } from "../../utils/firecrawlClient.js";
import mangaCommand from "./manga.js";
import {
  buildMangalikChapterUrl,
  buildMangalikOnePieceChapterUrl,
  buildMangalikSearchTerms,
  buildMangalikSearchUrl,
  buildStarzOnePieceChapterUrl,
  extractReaderImages,
  findMangalikChapterRedirect,
  getFirecrawlHtml,
  getMangaSourceOrder,
  isOnePieceTitle,
  normalizeReaderImageUrl,
  parseMangalikSearchResults,
  pickBestMangalik,
} from "../../utils/mangaScrapers.js";

const MAX_IMAGES_PER_MESSAGE = 14;
const MAX_IMAGES_PER_CHAPTER = 140;
const DOWNLOAD_CONCURRENCY = 4;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const REDIRECT_LIMIT = 3;
const MIME_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
]);

class MangalikCommandError extends Error {
  constructor(code, message = code, extra = {}) {
    super(message);
    this.name = "MangalikCommandError";
    this.code = code;
    Object.assign(this, extra);
  }
}

function log(level, message, fields = {}) {
  const record = { time: new Date().toISOString(), command: "mangalik", message, ...fields };
  const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  writer(`[mangalik] ${JSON.stringify(record)}`);
}

function getSafeError(error) {
  return String(error?.message || error || "Unknown error")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(token|api[_-]?key|authorization|cookie|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .slice(0, 180);
}

function sendDirect(api, body, threadID, replyToID = null) {
  const rawApi = api?.__rawApi || api;
  if (typeof rawApi?.sendMessage !== "function") return Promise.reject(new Error("Raw sendMessage API is unavailable."));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    const callback = (error, result) => finish(error, result);
    try {
      const result = replyToID
        ? rawApi.sendMessage(body, threadID, callback, replyToID)
        : rawApi.sendMessage(body, threadID, callback);
      if (result && typeof result.then === "function") result.then(value => finish(null, value), finish);
    } catch (error) {
      finish(error);
    }
  });
}

function getPayloadData(response) {
  return response?.data && typeof response.data === "object" ? response.data : response;
}

function scrapeStatus(response) {
  const data = getPayloadData(response);
  return Number(data?.metadata?.statusCode ?? data?.statusCode ?? response?.metadata?.statusCode) || null;
}

async function scrapeHtml(url) {
  const response = await firecrawlClient.scrape(url, { timeout: REQUEST_TIMEOUT_MS });
  const statusCode = scrapeStatus(response);
  if (statusCode && statusCode >= 400) {
    throw new MangalikCommandError("SOURCE_PAGE_NOT_FOUND", `Source page returned HTTP ${statusCode}.`, { statusCode });
  }
  const html = getFirecrawlHtml(response);
  if (!html) throw new MangalikCommandError("SOURCE_EMPTY_HTML", "Source page returned no HTML.");
  return html;
}

async function searchMangalik(title) {
  for (const term of buildMangalikSearchTerms(title)) {
    const html = await scrapeHtml(buildMangalikSearchUrl(term));
    const match = pickBestMangalik(title, parseMangalikSearchResults(html));
    if (match.manga) return match.manga;
  }
  return null;
}

async function readMangalikChapter(title, chapter) {
  let lastError = null;
  if (isOnePieceTitle(title)) {
    const specialUrl = buildMangalikOnePieceChapterUrl(chapter);
    try {
      const html = await scrapeHtml(specialUrl);
      const imageUrls = extractReaderImages(html, specialUrl, "Mangalik");
      if (imageUrls.length) return { source: "Mangalik", title: "One Piece", chapterUrl: specialUrl, imageUrls };
      lastError = new MangalikCommandError("NO_CHAPTER_IMAGES", "No Mangalik One Piece reader images were found.");
    } catch (error) {
      lastError = error;
    }
  }

  let manga = null;
  try {
    manga = await searchMangalik(title);
  } catch (error) {
    lastError = error;
  }
  if (manga) {
    const candidateUrls = [];
    if (/[._-]/.test(chapter)) {
      try {
        const detailHtml = await scrapeHtml(manga.url);
        candidateUrls.push(findMangalikChapterRedirect(detailHtml, manga.url, chapter));
      } catch (error) {
        lastError = error;
      }
    }
    candidateUrls.push(buildMangalikChapterUrl(manga.url, chapter));
    for (const chapterUrl of [...new Set(candidateUrls.filter(Boolean))]) {
      try {
        const html = await scrapeHtml(chapterUrl);
        const imageUrls = extractReaderImages(html, chapterUrl, "Mangalik");
        if (imageUrls.length) return { source: "Mangalik", title: manga.title || title, chapterUrl, imageUrls };
        lastError = new MangalikCommandError("NO_CHAPTER_IMAGES", "No Mangalik reader images were found.");
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError || new MangalikCommandError("NO_CHAPTER_IMAGES", "No Mangalik reader images were found.");
}

async function readStarzOnePieceChapter(chapter) {
  const chapterUrl = buildStarzOnePieceChapterUrl(chapter);
  if (!chapterUrl) throw new MangalikCommandError("INVALID_CHAPTER", "Invalid chapter number.");
  const html = await scrapeHtml(chapterUrl);
  const imageUrls = extractReaderImages(html, chapterUrl, "StarzManga");
  if (!imageUrls.length) throw new MangalikCommandError("NO_CHAPTER_IMAGES", "No StarzManga reader images were found.");
  return { source: "StarzManga", title: "One Piece", chapterUrl, imageUrls };
}

async function readChapter(title, chapter) {
  const sourceOrder = getMangaSourceOrder(title);
  let lastError = null;
  for (const source of sourceOrder) {
    log("info", "source attempt", { source, title, chapter });
    try {
      if (source === "StarzManga") return await readStarzOnePieceChapter(chapter);
      return await readMangalikChapter(title, chapter);
    } catch (error) {
      lastError = error;
      log("warn", "source unavailable; trying next source", {
        source,
        title,
        chapter,
        errorCode: error?.code || null,
        statusCode: error?.statusCode || null,
        error: getSafeError(error),
      });
    }
  }
  throw lastError || new MangalikCommandError("NO_CHAPTER_IMAGES", "No source returned reader images.");
}

function isAllowedImageUrl(value, source, baseUrl) {
  return normalizeReaderImageUrl(value, source, baseUrl);
}

async function readBoundedBody(response) {
  if (!response.body?.getReader) throw new Error("Image response had no body.");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("Image exceeded the download size limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

async function downloadImage(imageUrl, destination, source, referer) {
  let currentUrl = isAllowedImageUrl(imageUrl, source, referer);
  if (!currentUrl) throw new Error("Image URL host is not allowed.");
  for (let hop = 0; hop <= REDIRECT_LIMIT; hop++) {
    const response = await fetch(currentUrl, {
      redirect: "manual",
      headers: {
        Referer: referer,
        "User-Agent": "Mozilla/5.0 (compatible; SunkenBot/4.0; +https://starzmanga.com/)",
      },
      signal: AbortSignal.timeout(25_000),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || hop === REDIRECT_LIMIT) throw new Error("Image redirect could not be followed.");
      currentUrl = isAllowedImageUrl(new URL(location, currentUrl).href, source, currentUrl);
      if (!currentUrl) throw new Error("Image redirect host is not allowed.");
      continue;
    }
    if (!response.ok) throw new Error(`Image returned HTTP ${response.status}.`);

    const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const extension = MIME_EXTENSIONS.get(contentType);
    if (!extension) throw new Error("Image response had an unsupported content type.");
    const declaredSize = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_IMAGE_BYTES) throw new Error("Image exceeded the download size limit.");
    const bytes = await readBoundedBody(response);
    if (!bytes.length) throw new Error("Image response was empty.");
    const finalPath = `${destination}.${extension}`;
    await fs.writeFile(finalPath, bytes, { flag: "wx" });
    return finalPath;
  }
  throw new Error("Image redirect limit was exceeded.");
}

async function sendImageBatch(api, files, { title, chapter, index, total, source, chapterUrl, threadID, replyToID }) {
  const firstPage = (index - 1) * MAX_IMAGES_PER_MESSAGE + 1;
  const lastPage = firstPage + files.length - 1;
  const body = `📖 ${title} — الفصل ${chapter} (${source}, ${index}/${total})\nالصفحات ${firstPage}–${lastPage}\n${chapterUrl}`;
  const streams = files.map(file => fs.createReadStream(file));
  try {
    await sendDirect(api, { body, attachment: streams }, threadID, index === 1 ? replyToID : null);
  } finally {
    for (const stream of streams) if (!stream.closed) stream.destroy();
  }
}

async function deliverChapter(api, event, chapterData, chapter) {
  const { threadID, messageID } = event;
  const imageUrls = chapterData.imageUrls.slice(0, MAX_IMAGES_PER_CHAPTER);
  const truncated = imageUrls.length < chapterData.imageUrls.length;
  const totalBatches = Math.ceil(imageUrls.length / MAX_IMAGES_PER_MESSAGE);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mangalik-f-"));
  let sentImages = 0;
  let failedImages = 0;

  try {
    for (let offset = 0; offset < imageUrls.length; offset += MAX_IMAGES_PER_MESSAGE) {
      const batchUrls = imageUrls.slice(offset, offset + MAX_IMAGES_PER_MESSAGE);
      const downloaded = await downloadWithLimit(batchUrls, (url, index) =>
        downloadImage(url, path.join(tempDir, `page-${offset + index + 1}`), chapterData.source, chapterData.chapterUrl),
      DOWNLOAD_CONCURRENCY);
      const files = downloaded.filter(Boolean);
      failedImages += batchUrls.length - files.length;
      if (files.length) {
        await sendImageBatch(api, files, {
          title: chapterData.title,
          chapter,
          index: Math.floor(offset / MAX_IMAGES_PER_MESSAGE) + 1,
          total: totalBatches,
          source: chapterData.source,
          chapterUrl: chapterData.chapterUrl,
          threadID,
          replyToID: messageID,
        });
        sentImages += files.length;
      }
      await Promise.allSettled(files.map(file => fs.remove(file)));
    }

    if (!sentImages) throw new MangalikCommandError("NO_IMAGES_DOWNLOADED", "All reader images failed to download.");
    if (failedImages || truncated) {
      const note = truncated
        ? `⚠️ تم إرسال أول ${MAX_IMAGES_PER_CHAPTER} صفحة فقط؛ الفصل يتجاوز الحد الآمن.`
        : `⚠️ تعذر تحميل ${failedImages} صفحة؛ أُرسلت الصفحات المتاحة.`;
      await sendDirect(api, note, threadID);
    }
    log("info", "chapter delivered", { source: chapterData.source, title: chapterData.title, chapter, pages: sentImages, batches: totalBatches });
  } finally {
    await fs.remove(tempDir).catch(() => {});
  }
}

export function buildMangaFallbackArgs(title, chapter) {
  return [...String(title || "").trim().split(/\s+/).filter(Boolean), String(chapter || "").trim()];
}

export async function invokeMangaFallback({ api, event, title, chapter, command = mangaCommand }) {
  if (typeof command?.onStart !== "function") throw new Error("manga.js fallback handler is unavailable.");
  return command.onStart({
    api,
    event,
    args: buildMangaFallbackArgs(title, chapter),
    bypassHumanQueue: true,
  });
}

export default {
  config: {
    name: "mangalik",
    aliases: ["mangalek", "مانجاليك"],
    version: "2.0.0",
    author: "Sunken",
    countDown: 0,
    role: 0,
    category: "مانجا وروايات",
    description: "جلب فصول المانجا؛ StarzManga أولاً لـOne Piece ثم Mangalik، مع تحويل تلقائي إلى manga عند الفشل",
    usage: ["{pn}mangalik <اسم المانجا> <رقم الفصل> — مثال: {pn}mangalik One Piece 1085"],
  },

  onStart: async function ({ api, event, args }) {
    const threadID = event?.threadID;
    const messageID = event?.messageID;
    const rawTitle = args?.slice(0, -1).join(" ").trim();
    const chapter = String(args?.at(-1) || "").trim().replace(/,/g, ".");
    log("info", "command started", { threadID: String(threadID || ""), title: rawTitle.slice(0, 100), chapter });

    if (!threadID || !messageID || !rawTitle || rawTitle.length > 100 || !/^\d+(?:[._-]\d+)?$/.test(chapter)) {
      await sendDirect(api, "📖 الاستخدام: mangalik <اسم المانجا> <رقم الفصل>\nمثال: mangalik One Piece 1085", threadID, messageID).catch(() => {});
      log("warn", "invalid command arguments", { threadID: String(threadID || "") });
      return;
    }

    try {
      const message = isOnePieceTitle(rawTitle)
        ? `⏳ أبحث عن One Piece الفصل ${chapter} في StarzManga، ثم Mangalik...`
        : `⏳ أبحث عن ${rawTitle} — الفصل ${chapter} في Mangalik...`;
      await sendDirect(api, message, threadID, messageID);
    } catch (error) {
      log("warn", "could not send progress message", { error: getSafeError(error) });
    }

    try {
      const chapterData = await readChapter(rawTitle, chapter);
      await deliverChapter(api, event, chapterData, chapter);
      return;
    } catch (error) {
      log("warn", "all configured scrapers failed; routing to manga.js", {
        title: rawTitle,
        chapter,
        errorCode: error?.code || null,
        statusCode: error?.statusCode || null,
        firecrawlKeyIndex: error instanceof FirecrawlClientError ? error.keyIndex : null,
        error: getSafeError(error),
      });
    }

    try {
      log("info", "internal manga.js fallback started", { title: rawTitle, chapter, bypassHumanQueue: true });
      await invokeMangaFallback({ api, event, title: rawTitle, chapter });
      log("info", "internal manga.js fallback finished", { title: rawTitle, chapter });
    } catch (error) {
      log("error", "internal manga.js fallback failed", { error: getSafeError(error) });
      await sendDirect(api, "❌ تعذر جلب الفصل من المصادر البديلة أيضاً.", threadID, messageID).catch(() => {});
    }
  },
};
