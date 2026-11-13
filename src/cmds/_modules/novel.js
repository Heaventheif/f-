import { translateToArabic } from "../../utils/translator.js";
import { parseChapter } from "../../manga/parse.js";
import { askChoice } from "../../manga/reply.js";
import { AppError } from "../../infra/errors.js";
import { LRU } from "../../infra/lru.js";
import { SingleFlight } from "../../infra/limiter.js";
import {
  SITES, WUXIABOX, fetchChapter, fetchFromBridge, NeedsSelectionError, slugify, hasNonLatin,
  validChapter, translateBatch, verifyTranslation, splitLongParagraph, cacheKey, makeFetchHtml,
} from "../../manga/novelSources.js";

const SOURCE_TIMEOUT = 25e3;
const OVERALL_TIMEOUT = 3e4;
const SAFE_MESSAGE_LEN = 9e3;
const pageCache = new LRU({ maxEntries: 100, maxBytes: 24 * 1024 * 1024, ttlMs: 3600e3 });
const translatedCache = new LRU({ maxEntries: 100, maxBytes: 24 * 1024 * 1024, ttlMs: 3600e3 });
const flight = new SingleFlight();
const fetchHtml = makeFetchHtml();

const send = (api, body, threadID, replyTo) =>
  new Promise((resolve, reject) => global.safeSend(api, body, threadID, (err, info) => (err ? reject(err) : resolve(info)), replyTo));

// Runs every source in parallel; first success wins, losers are aborted. Stops at `timeoutMs`.
async function raceSites(sites, name, n, { timeoutMs = OVERALL_TIMEOUT, parentSignal } = {}) {
  const all = new AbortController();
  const timer = setTimeout(() => all.abort(), timeoutMs);
  parentSignal?.addEventListener("abort", () => all.abort(), { once: true });
  const errors = {};
  const deadline = Date.now() + timeoutMs;
  try {
    return await new Promise((resolve, reject) => {
      let pending = sites.length;
      if (!pending) return reject(new AppError("not_found", "no_sources"));
      all.signal.addEventListener("abort", () => reject(new AppError("timeout", "overall")), { once: true });
      for (const site of sites) {
        const ctl = new AbortController();
        all.signal.addEventListener("abort", () => ctl.abort(), { once: true });
        const t = setTimeout(() => ctl.abort(), SOURCE_TIMEOUT);
        const key = cacheKey(site.name, name, n);
        const cached = pageCache.get(key);
        Promise.resolve(cached || fetchChapter(site, name, n, { fetchHtml, signal: ctl.signal, deadline }))
          .then((r) => { pageCache.set(key, r); resolve(r); })
          .catch((e) => {
            errors[site.name] = e?.code || "error";
            if (--pending === 0) reject(Object.assign(new AppError("not_found", "all_failed"), { errors }));
          })
          .finally(() => clearTimeout(t));
      }
    });
  } finally {
    clearTimeout(timer);
    all.abort(); // cancel the losers
  }
}

export function splitMessage(text, maxLen = SAFE_MESSAGE_LEN) {
  const chunks = [];
  let current = "";
  for (const para of text.split("\n\n")) {
    const pieces = para.length > maxLen ? splitLongParagraph(para, maxLen) : [para];
    for (const piece of pieces) {
      if ((current + piece + "\n\n").length > maxLen) {
        if (current.trim()) chunks.push(current.trim());
        current = piece + "\n\n";
      } else current += piece + "\n\n";
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

async function sendChunks(api, threadID, messageID, header, paragraphs, divider) {
  const chunks = splitMessage(header + paragraphs.join("\n\n"));
  let sent = 0;
  const failedParts = [];
  for (let i = 0; i < chunks.length; i++) {
    const body = chunks[i] + (chunks.length > 1 ? `\n\n${divider}\n📌 ${i + 1} / ${chunks.length}` : "");
    await new Promise((r) => setTimeout(r, 800));
    let ok = false;
    for (let a = 0; a < 2 && !ok; a++) {
      try { await send(api, body, threadID, messageID); ok = true; } catch { /* retry */ }
    }
    if (ok) sent++; else failedParts.push(i + 1);
  }
  return { sent, failedParts, total: chunks.length };
}

async function deliver({ api, threadID, messageID, result, chapterNum, setStatus }) {
  const tKey = `tr:${cacheKey(result.siteName, result.title, chapterNum)}`;
  let translated = translatedCache.get(tKey);
  let note = [];
  if (!translated) {
    await setStatus(`🔄 ترجمة ${result.paragraphs.length} فقرة...\n📖 ${result.title}\n🌐 ${result.siteName}`);
    const tr = await translateBatch(result.paragraphs, { translate: translateToArabic });
    const v = await verifyTranslation(tr.paragraphs, { translate: translateToArabic });
    translated = v.paragraphs;
    if (tr.failed || v.incomplete) note.push("⚠️ بعض الفقرات لم تُترجم بالكامل.");
    else translatedCache.set(tKey, translated); // never cache a failed/partial translation
  }
  const divider = "─".repeat(35);
  const header = `📖 ${result.title}\n📄 ${result.chapterTitle || `الفصل ${chapterNum}`}\n🌐 ${result.siteName}\n${divider}\n\n`;
  const r = await sendChunks(api, threadID, messageID, header, [...translated, ...note], divider);
  if (r.failedParts.length) {
    await send(api, `⚠️ تعذر إرسال ${r.failedParts.length} من ${r.total} جزء (${r.failedParts.join("، ")}). أعد الأمر لإكمالها.`, threadID, messageID).catch(() => {});
  }
}

async function run({ api, event, name, chapterNum, signal, message, bridgeName }) {
  const { threadID, messageID } = event;
  let statusId = null;
  try { statusId = (await send(api, `⏳ جاري جلب الفصل...\n📖 ${name}\n📄 الفصل ${chapterNum}\n\n⚠️ قد يستغرق حتى 30 ثانية`, threadID, messageID))?.messageID; } catch { /* ignore */ }
  const setStatus = async (text) => { try { if (statusId) await api.editMessage(text, statusId); } catch { /* ignore */ } };
  const finish = async (text) => { try { if (statusId) return await api.editMessage(text, statusId); } catch { /* fall through */ } return send(api, text, threadID, messageID).catch(() => {}); };
  const errors = {};
  let result = null;
  if (!bridgeName) {
    for (const [label, sites, budget] of [["primary", SITES, OVERALL_TIMEOUT], ["backup", [WUXIABOX], SOURCE_TIMEOUT]]) {
      if (result) break;
      if (label === "backup") await setStatus(`🔁 المصادر الأساسية فشلت، تجربة مصدر احتياطي...\n📖 ${name}\n📄 الفصل ${chapterNum}`);
      try { result = await flight.run(`${label}:${cacheKey("x", name, chapterNum)}`, () => raceSites(sites, name, chapterNum, { timeoutMs: budget, parentSignal: signal })); }
      catch (e) { Object.assign(errors, e?.errors || { [label]: e?.code || "error" }); }
    }
  }
  if (!result) {
    await setStatus(`🔁 تجربة مصدر بديل (مواقع JS)...\n📖 ${name}\n📄 الفصل ${chapterNum}`);
    try { result = await fetchFromBridge(bridgeName || name, chapterNum, { signal }); }
    catch (e) {
      if (e instanceof NeedsSelectionError && e.candidates.length) {
        const registered = await askChoice({
          api, message, event, header: `🔎 وُجدت عدة نتائج متشابهة لـ "${name}" على ${e.site}:`,
          labels: e.candidates.map((c) => c.title || String(c)),
          onPick: (idx, ev) => run({ api, event: ev, name: e.candidates[idx].title || name, chapterNum, signal, message, bridgeName: e.candidates[idx].title || name }),
        });
        if (!registered) await finish(`🔎 وُجدت عدة نتائج لـ "${name}". حدّد الاسم بدقة أكبر.`);
        else await api.unsendMessage?.(statusId)?.catch?.(() => {});
        return;
      }
      errors.bridge = e?.code || "error";
    }
  }
  if (!result) {
    const details = Object.entries(errors).map(([s, c]) => `• ${s}: ${c}`).join("\n");
    return finish(`❌ لم أجد الفصل في أي مصدر\n\n📖 ${name} | 📄 الفصل ${chapterNum}\n\n${details ? `🔍 التفاصيل:\n${details}\n\n` : ""}💡 تأكد من:\n• الاسم الإنجليزي الصحيح\n• رقم الفصل صحيح`);
  }
  try { if (statusId) await api.unsendMessage(statusId); } catch { /* ignore */ }
  await deliver({ api, threadID, messageID, result, chapterNum, setStatus });
}

export default {
  config: {
    name: "novel",
    aliases: ["رواية"],
    version: "11.0.0",
    author: "Sunken",
    countDown: 20,
    role: 0,
    category: "مانجا وروايات",
    description: "قراءة فصول الروايات مترجمة تلقائياً للعربية (5 مصادر بالتوازي + مصدر بديل تلقائي)",
    usage: ["{pn}رواية <اسم الرواية> <رقم الفصل> — مثال: {pn}رواية martial peak 1"],
  },
  onStart: async function ({ api, event, args, message, signal }) {
    const { threadID, messageID } = event;
    const reply = (t) => global.safeSend(api, t, threadID, null, messageID);
    const { name, number } = parseChapter(args || []);
    if (!name || number == null) return reply("📚 الاستخدام: .novel [اسم الرواية] [رقم الفصل]\n💡 مثال: .novel martial peak 1");
    if (!validChapter(number)) return reply("❌ رقم الفصل يجب أن يكون عدداً صحيحاً بين 1 و5000.");
    if (name.length > 100) return reply("❗ الاسم طويل جداً.");
    if (!slugify(name) && hasNonLatin(name)) return reply("❌ اكتب اسم الرواية بالأحرف الإنجليزية (اللاتينية).\n💡 مثال: .novel martial peak 1");
    if (!slugify(name)) return reply("❌ اسم الرواية غير صالح.");
    try {
      await run({ api, event, name, chapterNum: number, signal, message });
    } catch (e) {
      console.error("[NOVEL:ERR]", e?.code || "", e?.message);
      await reply("❌ حدث خطأ أثناء جلب الفصل. حاول لاحقاً.");
    }
  },
};
