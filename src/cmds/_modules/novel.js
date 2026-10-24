import http from "../../utils/fetchHttp.js";
import * as cheerio from "cheerio";
import { translateToArabic } from "../../utils/translator.js";
import { getHfBaseOrNull, getInternalToken } from "../../utils/hfClient.js";
import cache from "../../utils/cache.js";
const CACHE_TTL = 3600 * 1000;
const cacheGet = (k) => cache.get(k);
const cacheSet = (k, v) => cache.set(k, v, CACHE_TTL);
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/125.0.0.0 Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
];
const randomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const BROWSER_HEADERS = () => ({
  "User-Agent": randomUA(),
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
});
const slugify = (n) => n.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const FALLBACK_SITES = [
  {
    name: "AllNovelFull",
    buildUrl: (slug, ch) => `https://allnovelfull.net/${slug}/chapter-${ch}.html`,
    selectors: ["#chapter-content", ".chapter-content", ".text-content"],
    titleSel: [".truyen-title", "h3.title", "title"],
    slugify,
    buildChapter: (ch) => String(ch),
  },
  {
    name: "NovelFull",
    indexUrl: (slug) => `https://novelfull.com/${slug}.html`,
    selectors: ["#chapter-content", ".chapter-content", ".text-left"],
    titleSel: [".truyen-title", "h3.title", "title"],
    slugify,
    buildChapter: (ch) => String(ch),
  },
  {
    name: "NovelFire",
    buildUrl: (slug, ch) => `https://novelfire.net/book/${slug}/chapter-${ch}`,
    selectors: [
      ".chapter-content", "#chapter-content",
      "div.content", ".reading-content",
      "div[class*='chapter']", "article",
    ],
    titleSel: [".novel-title", "h1", "title"],
    slugify,
    buildChapter: (ch) => String(ch),
  },
  {
    name: "INovelHub",
    buildUrl: (slug, ch) => `https://inovelhub.com/novel/${slug}/chapter-${ch}`,
    selectors: [
      "div#chapter-content", "#chapter-content",
      ".chapter-content", ".entry-content",
      "div[id*='chapter']", "div[class*='chapter']",
      "article .content", "main article",
    ],
    titleSel: [".novel-title", "h1", "title"],
    slugify,
    buildChapter: (ch) => String(ch),
  },
  {
    name: "NovelCrest",
    buildUrl: (slug, ch) => `https://www.novelcrest.com/book/${slug}/${ch}.html`,
    buildUrlAlt: (slug, ch) => `https://www.novelcrest.com/book/${slug}-2/${ch}.html`,
    selectors: ["div#chr-content", ".chr-c", "#chr-content"],
    titleSel: [".chr-title", "h1", "title"],
    slugify,
    buildChapter: (ch) => String(ch),
  },
];
const WUXIABOX_SITE = {
  name: "WuxiaBox",
  buildUrl: (novelID, ch) => `https://www.wuxiabox.com/novel/${novelID}_${ch}.html`,
  selectors: ["article#chapter-article", "div.chapter-content", ".page-in"],
  titleSel: [".truyen-title", "h1", "title"],
  slugify: (n) => n,
  buildChapter: (ch) => String(ch),
};
const PROXIES = [
  { build: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`, successCount: 0 },
  { build: (u) => `https://corsproxy.io/?${encodeURIComponent(u)}`, successCount: 0 },
];
// Order proxies by past success count, most reliable first.
const orderedProxies = () => [...PROXIES].sort((a, b) => b.successCount - a.successCount);
const FILTER_WORDS = [
  "novelfull.com", "boxnovel", "novelmt.com", "mtlnovel.me",
  "advertisement", "report chapter", "next chapter", "prev chapter",
  "table of contents", "access denied", "just a moment", "cloudflare",
  "enable javascript", "read more at",
];
const STOLEN_CONTENT_PATTERNS = [
  /stol(en|e)\s+(content|chapter|novel)/i,
  /(this|the)\s+(chapter|content|novel)\s+(is|was)\s+stolen/i,
  /if\s+you('| a)re\s+reading\s+this\s+on/i,
  /please\s+read\s+(this|it)\s+on\s+(the\s+)?original/i,
  /unauthorized\s+(use|reproduction|copy)/i,
  /support\s+the\s+(author|translator)\s+by\s+reading/i,
];
const isFiltered = (t) => {
  const lower = t.toLowerCase();
  if (FILTER_WORDS.some(w => lower.includes(w))) return true;
  if (STOLEN_CONTENT_PATTERNS.some(re => re.test(t))) return true;
  return false;
};
function cleanText(t) {
  return t
    .replace(/\u00a0/g, " ")
    .replace(/[•◆▪]{2,}/g, " ")
    .replace(/\.{4,}/g, "...")
    .replace(/\s{2,}/g, " ")
    .trim();
}
const sendMessageAsync = (api, body, threadID, messageID) =>
  new Promise((resolve, reject) =>
    global.safeSend(api, body, threadID, (err, info) => (err ? reject(err) : resolve(info)), messageID)
  );
async function raceFirstSuccess(tasks) {
  return new Promise((resolve, reject) => {
    let pending = tasks.length;
    const errors = [];
    if (pending === 0) return reject(new Error("لا توجد مصادر متاحة"));
    tasks.forEach((task) => {
      task.promise
        .then((value) => resolve({ value, siteName: task.siteName }))
        .catch((err) => {
          errors.push(`${task.siteName}: ${err.message?.substring(0, 60)}`);
          pending -= 1;
          if (pending === 0) reject(new Error(errors.join(" | ")));
        });
    });
  });
}
function splitLongParagraph(p, maxLen) {
  if (p.length <= maxLen) return [p];
  const sentences = p.match(/[^.!?\u061f\u060c]+[.!?\u061f\u060c]*/g) || [p];
  const out = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).length > maxLen && cur) { out.push(cur); cur = s; }
    else cur += s;
  }
  if (cur) out.push(cur);
  return out;
}
async function translateBatch(paragraphs) {
  if (!paragraphs?.length) return [];
  const arabicChars = paragraphs.join("").match(/[\u0600-\u06FF]/g);
  if (arabicChars && arabicChars.length > 50) return paragraphs;
  const MAX_CHUNK = 3800;
  const SEP = " ||| ";
  const safeParagraphs = paragraphs.flatMap(p => splitLongParagraph(p, MAX_CHUNK));
  const chunks = [];
  let current = "";
  for (const p of safeParagraphs) {
    const candidate = current ? current + SEP + p : p;
    if (candidate.length > MAX_CHUNK && current) { chunks.push(current); current = p; }
    else current = candidate;
  }
  if (current) chunks.push(current);
  console.log(`[TRANSLATE] ${paragraphs.length} فقرة → ${chunks.length} chunk`);
  const out = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      const translated = await translateToArabic(chunks[i]);
      out.push(translated || chunks[i]);
    } catch { out.push(chunks[i]); }
    if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
  }
  const result = out.join(SEP).split("|||").map(p => p.trim()).filter(Boolean);
  return result.length > 0 ? result : paragraphs;
}
async function translateBatchCached(cacheKey, paragraphs) {
  const tKey = `translated:${cacheKey}`;
  const cached = cacheGet(tKey);
  if (cached) return cached;
  const translated = await translateBatch(paragraphs);
  cacheSet(tKey, translated);
  return translated;
}
async function fetchHTML(url) {
  const attempts = [
    { url, headers: BROWSER_HEADERS(), proxyRef: null },
    ...orderedProxies().map((p) => ({ url: p.build(url), headers: { "User-Agent": randomUA() }, proxyRef: p }))
  ];
  for (const a of attempts) {
    try {
      const res = await http.get(a.url, { timeout: 20000, headers: a.headers, validateStatus: () => true });
      if (res.status >= 400) continue;
      const html = typeof res.data === "string" ? res.data : String(res.data);
      if (html.length < 500) continue;
      const lower = html.substring(0, 3000).toLowerCase();
      if (lower.includes("just a moment") || lower.includes("cloudflare")) continue;
      if (a.proxyRef) a.proxyRef.successCount += 1;
      return html;
    } catch (_) {}
  }
  throw new Error("فشلت جميع المحاولات");
}
function extractContent($, selectors) {
  let container = null;
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length) { container = el; break; }
  }
  if (!container) return null;
  container.find("script,style,ins,.ads,.ad,noscript").remove();
  let paras = [];
  container.find("p").each((_, el) => {
    const t = cleanText($(el).text());
    if (t.length > 15 && !isFiltered(t)) paras.push(t);
  });
  if (paras.length < 3) {
    paras = container.text().split(/\n+/).map(p => cleanText(p)).filter(p => p.length > 15 && !isFiltered(p));
  }
  return paras.length > 0 ? paras : null;
}
const wuxiaBoxIDCache = new Map();
async function resolveWuxiaBoxUrl(slug, chapterNum) {
  const cacheKey = `wuxia:${slug}:${chapterNum}`;
  if (wuxiaBoxIDCache.has(cacheKey)) return wuxiaBoxIDCache.get(cacheKey);
  const candidates = [chapterNum];
  for (let i = 1; i <= 15; i++) {
    candidates.push(chapterNum + i);
    candidates.push(chapterNum - i);
  }
  for (const idx of candidates) {
    if (idx < 1) continue;
    const url = `https://www.wuxiabox.com/novel/${slug}_${idx}.html`;
    try {
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      const headText = [
        $("title").text(),
        $("h2").first().text(),
        $("h3").first().text(),
        $(".chapter-title").first().text(),
      ].join(" ");
      const match = headText.match(/chapter\s*(\d+)/i);
      if (match && parseInt(match[1]) === chapterNum) {
        console.log(`[WuxiaBox] ✅ فصل ${chapterNum} → index ${idx}`);
        wuxiaBoxIDCache.set(cacheKey, { url, html, $ });
        return { url, html, $ };
      }
      if (idx === chapterNum && !match) {
        const content = extractContent($, ["article#chapter-article", "div.chapter-content", ".page-in"]);
        if (content && content.length > 3) {
          wuxiaBoxIDCache.set(cacheKey, { url, html, $ });
          return { url, html, $ };
        }
      }
    } catch (_) {}
  }
  return null;
}
async function fetchFromFallback(site, novelName, chapterNum) {
  const cacheKey = `${site.name}:${novelName}:${chapterNum}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const slug = site.slugify(novelName);
  if (!slug) throw new Error("اسم الرواية غير صالح بعد التحويل لرابط");
  let html, $, url;
  if (site.name === "WuxiaBox") {
    const wSlug = novelName.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const resolved = await resolveWuxiaBoxUrl(wSlug, chapterNum);
    if (!resolved) throw new Error(`WuxiaBox: لم يُعثر على الفصل ${chapterNum} في نطاق ±15`);
    ({ url, html, $ } = resolved);
  } else if (site.name === "NovelFull") {
    const indexUrl = site.indexUrl(slug);
    const indexHtml = await fetchHTML(indexUrl);
    const $idx = cheerio.load(indexHtml);
    const chPattern = new RegExp(`/chapter-${chapterNum}[^"']*\\.html`, "i");
    let chapterUrl = null;
    $idx("a[href]").each((_, el) => {
      const href = $idx(el).attr("href") || "";
      if (chPattern.test(href)) {
        chapterUrl = href.startsWith("http") ? href : `https://novelfull.com${href}`;
        return false;
      }
    });
    if (!chapterUrl) {
      for (let page = 1; page <= 5 && !chapterUrl; page++) {
        try {
          const pageHtml = await fetchHTML(`${indexUrl}?page=${page}`);
          const $p = cheerio.load(pageHtml);
          $p("a[href]").each((_, el) => {
            const href = $p(el).attr("href") || "";
            if (chPattern.test(href)) {
              chapterUrl = href.startsWith("http") ? href : `https://novelfull.com${href}`;
              return false;
            }
          });
        } catch (_) {}
      }
    }
    if (!chapterUrl) throw new Error(`NovelFull: لم يُعثر على رابط الفصل ${chapterNum} في الفهرس`);
    url = chapterUrl;
    html = await fetchHTML(url);
    $ = cheerio.load(html);
  } else if (site.name === "NovelCrest") {
    url = site.buildUrl(slug, site.buildChapter(chapterNum));
    try {
      html = await fetchHTML(url);
      $ = cheerio.load(html);
      if (!extractContent($, site.selectors) && site.buildUrlAlt) {
        throw new Error("محتوى فارغ، جرّب النسخة البديلة");
      }
    } catch (_) {
      if (site.buildUrlAlt) {
        url = site.buildUrlAlt(slug, site.buildChapter(chapterNum));
        html = await fetchHTML(url);
        $ = cheerio.load(html);
      } else throw _;
    }
  } else {
    url = site.buildUrl(slug, site.buildChapter(chapterNum));
    html = await fetchHTML(url);
    $ = cheerio.load(html);
  }
  const paragraphs = extractContent($, site.selectors);
  if (!paragraphs || paragraphs.length < 2) throw new Error(`محتوى فارغ (${paragraphs?.length || 0} فقرة)`);
  let title = "";
  for (const sel of site.titleSel) {
    try { const t = $(sel).first().text().trim().split(/[-|•]/)[0].trim(); if (t?.length > 2) { title = t; break; } } catch (_) {}
  }
  const result = { title: title || novelName, chapterTitle: `الفصل ${chapterNum}`, paragraphs, url, siteName: site.name };
  cacheSet(cacheKey, result);
  return result;
}
const SAFE_MESSAGE_LEN = 9000;
function splitMessage(text, maxLen = SAFE_MESSAGE_LEN) {
  const chunks = [];
  let current = "";
  for (const para of text.split("\n\n")) {
    const pieces = para.length > maxLen ? splitLongParagraph(para, maxLen) : [para];
    for (const piece of pieces) {
      if ((current + piece + "\n\n").length > maxLen) {
        if (current.trim()) chunks.push(current.trim());
        current = piece + "\n\n";
      } else {
        current += piece + "\n\n";
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}
async function sendAsChunks(api, threadID, messageID, header, translated, divider) {
  const fullText = header + translated.join("\n\n");
  const chunks = splitMessage(fullText);
  let sentAny = false;
  for (let i = 0; i < chunks.length; i++) {
    const suffix = chunks.length > 1 ? `\n\n${divider}\n📌 ${i + 1} / ${chunks.length}` : "";
    const body = chunks[i] + suffix;
    await new Promise(r => setTimeout(r, 800));
    try {
      await sendMessageAsync(api, body, threadID, messageID);
      sentAny = true;
    } catch (err) {
      console.warn(`[NOVEL] فشل إرسال الجزء ${i + 1}/${chunks.length} (${body.length} حرف): ${err.message?.substring(0, 100)}`);
    }
  }
  return sentAny;
}
async function verifyTranslation(paragraphs) {
  const isEnglishHeavy = (text) => {
    const total = text.replace(/\s/g, "").length;
    if (total === 0) return false;
    const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
    return (arabicChars / total) < 0.4;
  };
  const verified = [];
  for (const para of paragraphs) {
    if (isEnglishHeavy(para)) {
      try {
        const retried = await translateToArabic(para);
        verified.push(retried || para);
        console.log(`[VERIFY] أُعيدت ترجمة فقرة (${para.length} حرف)`);
      } catch {
        verified.push(para);
      }
    } else {
      verified.push(para);
    }
  }
  return verified;
}
const JS_SITES = ["NovelHi", "WtrLab", "Freewebnovel"];
class NeedsSelectionError extends Error {
  constructor(candidates, site) {
    super(`اختيار مطلوب بين ${candidates.length} نتيجة محتملة`);
    this.candidates = candidates;
    this.site = site;
  }
}
async function fetchFromJsSitesBridge(novelName, chapterNum) {
  const HF_API = getHfBaseOrNull();
  if (!HF_API) throw new Error("HF_SPACE_URL غير مضبوط");
  const res = await http.post(`${HF_API}/novel`, { novel: novelName, chapter: chapterNum }, {
    timeout: 60000,
    headers: { "Content-Type": "application/json", "X-Internal-Token": getInternalToken() },
    validateStatus: () => true,
  });
  if (res.status === 404) {
    const details = res.data?.details?.join("\n• ") || res.data?.error || "لا توجد تفاصيل";
    throw new Error(`لم يُعثر على الفصل:\n• ${details}`);
  }
  if (res.status === 200 && res.data?.need_selection) {
    throw new NeedsSelectionError(res.data.candidates || [], res.data.site || "");
  }
  if (res.status !== 200) throw new Error(`خطأ ${res.status} — ${res.data?.error || "غير معروف"}`);
  const data = res.data;
  if (!data.paragraphs?.length) throw new Error("المحتوى فارغ");
  return {
    title: data.title || novelName,
    chapterTitle: `الفصل ${chapterNum}`,
    paragraphs: data.paragraphs,
    siteName: data.site || JS_SITES.join("/"),
  };
}
export default {
  config: {
    name: "novel",
    aliases: ["رواية"],
    version: "10.0.0",
    author: "Sunken",
    countDown: 20,
    role: 0,
    category: "مانجا وروايات",
    description: "قراءة فصول الروايات مترجمة تلقائياً للعربية (5 مصادر بالتوازي + مصدر بديل تلقائي)",
    usage: ["{pn}رواية <اسم الرواية> <رقم الفصل> — مثال: {pn}رواية martial peak 1"],
  },
  onStart: async function ({ api, event, args, message }) {
    const { threadID, messageID } = event;
    if (args.length < 2) {
      return global.safeSend(api,
        "📚 الاستخدام: .novel [اسم الرواية] [رقم الفصل]\n💡 مثال: .novel martial peak 1",
        threadID, null, messageID
      );
    }
    const lastArg = args[args.length - 1];
    if (isNaN(lastArg) || Number(lastArg) < 1) {
      return global.safeSend(api, 
        "❌ يجب أن يكون آخر شيء في الأمر رقم الفصل\n💡 مثال: .novel martial peak 1",
        threadID, null, messageID
      );
    }
    const chapterNum = parseInt(lastArg);
    const novelName  = args.slice(0, -1).join(" ").trim();
    if (!novelName) {
      return global.safeSend(api, 
        "❌ يجب كتابة اسم الرواية قبل رقم الفصل\n💡 مثال: .novel martial peak 1",
        threadID, null, messageID
      );
    }
    let statusMsgId = null;
    try {
      const sent = await sendMessageAsync(
        api,
        `⏳ جاري جلب الفصل...\n📖 ${novelName}\n📄 الفصل ${chapterNum}\n\n⚠️ قد يستغرق حتى 30 ثانية`,
        threadID,
        messageID
      );
      statusMsgId = sent?.messageID;
    } catch (_) {}
    const updateStatus = async (text) => {
      try { if (statusMsgId) await api.editMessage(text, statusMsgId); } catch (_) {}
    };
    await updateStatus(`🔍 جلب من ${FALLBACK_SITES.length} مصادر بالتوازي...\n📖 ${novelName}\n📄 الفصل ${chapterNum}`);
    const OVERALL_TIMEOUT = 30000; 
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("انتهى الوقت المسموح (timeout)")), OVERALL_TIMEOUT)
    );
    let result = null;
    let cacheKeyUsed = null;
    const siteErrors = {}; 
    try {
      const tasks = FALLBACK_SITES.map((site) => ({
        siteName: site.name,
        promise: fetchFromFallback(site, novelName, chapterNum).catch(err => {
          siteErrors[site.name] = err.message?.substring(0, 80);
          throw err;
        }),
      }));
      const winner = await Promise.race([raceFirstSuccess(tasks), timeoutPromise]);
      result = winner.value;
      cacheKeyUsed = `${winner.siteName}:${novelName}:${chapterNum}`;
      console.log(`[NOVEL] ✅ ${winner.siteName} نجح أولاً`);
    } catch (err) {
      console.warn(`[NOVEL] فشلت كل المصادر الأساسية أو انتهى الوقت: ${err.message?.substring(0, 200)}`);
    }
    if (!result) {
      await updateStatus(`🔁 المصادر الأساسية فشلت، تجربة مصدر احتياطي...\n📖 ${novelName}\n📄 الفصل ${chapterNum}`);
      try {
        const winner = await fetchFromFallback(WUXIABOX_SITE, novelName, chapterNum);
        result = winner;
        cacheKeyUsed = `${WUXIABOX_SITE.name}:${novelName}:${chapterNum}`;
        console.log(`[NOVEL] ✅ ${WUXIABOX_SITE.name} نجح كاحتياطي أخير`);
      } catch (err) {
        siteErrors[WUXIABOX_SITE.name] = err.message?.substring(0, 80);
        console.warn(`[NOVEL] فشل الاحتياطي WuxiaBox أيضًا: ${err.message?.substring(0, 200)}`);
      }
    }
    if (!result) {
      await updateStatus(`🔁 تجربة مصدر بديل (مواقع JS)...\n📖 ${novelName}\n📄 الفصل ${chapterNum}`);
      try {
        result = await fetchFromJsSitesBridge(novelName, chapterNum);
        cacheKeyUsed = `${result.siteName}:${novelName}:${chapterNum}`;
        console.log(`[NOVEL] ✅ ${result.siteName} نجح كمصدر بديل`);
      } catch (err) {
        if (err instanceof NeedsSelectionError) {
          const list = err.candidates.map((c, i) => `${i + 1}. ${c.title}`).join("\n");
          const selectMsg = `🔎 وُجدت عدة نتائج متشابهة لـ "${novelName}" على ${err.site}:\n\n${list}\n\n💡 حاول تحديد الاسم بدقة أكبر.`;
          try { if (statusMsgId) await api.editMessage(selectMsg, statusMsgId); else global.safeSend(api, selectMsg, threadID, null, messageID); }
          catch (_) { global.safeSend(api, selectMsg, threadID, null, messageID); }
          return;
        }
        siteErrors[JS_SITES.join("/")] = err.message?.substring(0, 80);
      }
    }
    if (!result) {
      const errorDetails = Object.entries(siteErrors)
        .map(([site, err]) => `• ${site}: ${err}`)
        .join("\n");
      const errMsg =
        `❌ لم أجد الفصل في أي مصدر\n\n` +
        `📖 ${novelName} | 📄 الفصل ${chapterNum}\n\n` +
        (errorDetails ? `🔍 تفاصيل الأخطاء:\n${errorDetails}\n\n` : "") +
        `💡 تأكد من:\n• الاسم الإنجليزي الصحيح\n• رقم الفصل صحيح`;
      try {
        if (statusMsgId) await api.editMessage(errMsg, statusMsgId);
        else global.safeSend(api, errMsg, threadID, null, messageID);
      } catch (_) { global.safeSend(api, errMsg, threadID, null, messageID); }
      return;
    }
    await updateStatus(`🔄 ترجمة ${result.paragraphs.length} فقرة...\n📖 ${result.title}\n🌐 ${result.siteName}`);
    const translated = await translateBatchCached(cacheKeyUsed, result.paragraphs);
    await updateStatus(`✅ التحقق من الترجمة...\n📖 ${result.title}`);
    const verified = await verifyTranslation(translated);
    const divider = "─".repeat(35);
    const chapterLabel = result.chapterTitle || `الفصل ${chapterNum}`;
    const header = `📖 ${result.title}\n📄 ${chapterLabel}\n🌐 ${result.siteName}\n${divider}\n\n`;
    try { if (statusMsgId) await api.unsendMessage(statusMsgId, threadID); } catch (_) {}
    try {
      await sendAsChunks(api, threadID, messageID, header, verified, divider);
    } catch (err) {
      console.error("[NOVEL] فشل إرسال الرسائل المقطعة:", err.message);
    }
  }
};
