// Shared implementation behind the `manga` and `mangalik` commands.
import fs from "node:fs";
import { parseChapter, LANG_LABELS } from "./parse.js";
import { buildChain, runChain, chainErrorMessage, mangaDexSource } from "./sources.js";
import { deliverImages, failureSummary } from "./deliver.js";
import { createBudget } from "./budget.js";
import {
  MangaDexClient, cleanQuery, pickBestManga, bestTitle, extractChapterNumbers, findRuns,
} from "./mangadex.js";
import { AppError } from "../infra/errors.js";
import { isOnePieceTitle } from "../utils/mangaScrapers.js";
import { getStore } from "../state/kv.js";

export const sharedDex = new MangaDexClient();
// Lazily resolved kv namespace (store may not be ready at import time).
let _ns;
const budgetNs = () => ({
  update: async (k, fn, init) => (_ns ??= (await getStore()).ns("mangalik_budget", { ttlMs: 36 * 3600e3 })).update(k, fn, init),
});
const realBudget = createBudget({ ns: budgetNs });

const send = (api, body, threadID, replyTo) => global.safeSend(api, body, threadID, null, replyTo || undefined);

export function formatRuns(runs, max = 10) {
  const shown = runs.slice(0, max).map((r) => (r.from === r.to ? `الفصل ${r.from} موجود` : `من ${r.from} الى ${r.to} موجودة`));
  let t = shown.join("\n");
  if (runs.length > max) t += `\n(و${runs.length - max} نطاق آخر)`;
  return t;
}
export function formatMissing(gaps, max = 8) {
  if (!gaps.length) return null;
  const shown = gaps.slice(0, max).map((g) => (g.from === g.to ? `${g.from}` : `${g.from}-${g.to}`));
  return shown.join("، ") + (gaps.length > max ? ` (و${gaps.length - max} فجوة أخرى)` : "");
}

async function rangeSearch({ api, event, name, dex }) {
  const q = cleanQuery(name);
  const cands = await dex.search(q);
  const { manga } = pickBestManga(q, cands, "ar");
  if (!manga) throw new AppError("not_found", "manga", { meta: { what: "manga" } });
  const title = bestTitle(manga);
  const numbers = extractChapterNumbers(await dex.aggregate(manga.id, "ar")).sort((a, b) => a - b);
  if (!numbers.length) return send(api, "❌ لا توجد أي فصول مترجمة للعربية لهذه المانجا.", event.threadID, event.messageID);
  const { runs, gaps } = findRuns(numbers);
  let msg = `مانجا ${title} الفصول المترجمة للعربية المرفوعة :\n`;
  if (runs.length) {
    msg += formatRuns(runs);
    const miss = formatMissing(gaps);
    if (miss) msg += `\nالفصول المفقودة ${miss}`;
  } else msg += `فصول خاصة فقط (${numbers[0]} - ${numbers[numbers.length - 1]})`;
  return send(api, msg, event.threadID, event.messageID);
}

export async function runMangaCommand({ api, event, args, kind, signal, deps = {} }) {
  const { threadID, messageID } = event;
  const usage = kind === "mangalik"
    ? "📖 الاستخدام: mangalik <اسم المانجا> <رقم الفصل>\nمثال: mangalik One Piece 1085"
    : "📖 قارئ المانجا\n\n📝 الاستخدام:\n  manga [اسم المانجا] [رقم الفصل] [لغة]\n  manga [اسم المانجا] — نطاقات الفصول العربية\n\n💡 مثال:\n  manga one piece 13\n  manga naruto 5 en";
  if (!threadID || !Array.isArray(args) || !args.length) return send(api, usage, threadID, messageID);
  const joined = args.join(" ");
  if (joined.length > 100) return send(api, "❗ الاسم طويل جداً.", threadID, messageID);
  const { name, chapter, lang } = parseChapter(args);
  if (!name || !cleanQuery(name)) return send(api, usage, threadID, messageID);
  const dex = deps.dex || sharedDex;
  try {
    if (!chapter) {
      if (kind === "mangalik") return send(api, usage, threadID, messageID);
      return await rangeSearch({ api, event, name, dex });
    }
    const ctx = { name, chapter, lang: lang || "ar", userID: String(event.senderID ?? threadID), signal };
    const chain = deps.chain || buildChain(kind, { dex: mangaDexSource(dex), budget: realBudget });
    const { data, result } = await runChain(chain, ctx, async (d) => {
      const label = `📖 ${d.title} — الفصل ${d.chapter}${d.source === "3asq" ? " (مصدر بديل)" : ""}`;
      return deliverImages({
        urls: d.imageUrls, headers: d.headers, allowHosts: d.allowHosts, delayMs: 600,
        send: (files, info) => global.safeSend(api, {
          body: info.isFirst ? label + (info.batches > 1 ? ` (${info.batch}/${info.batches})` : "") : `(${info.batch}/${info.batches})`,
          attachment: files.map((f) => fs.createReadStream(f)),
        }, threadID, null, messageID),
      });
    });
    const note = failureSummary(result);
    if (note) await send(api, note, threadID, null);
    if (!result.sent && !result.aborted) await send(api, "❌ فشل تحميل صفحات الفصل. حاول مرة أخرى.", threadID, messageID);
    void data;
  } catch (e) {
    console.error(`[${kind}]`, e?.code || "", e?.message);
    await send(api, chainErrorMessage(e instanceof AppError ? e : new AppError("unknown", "x"), { chapter, lang: lang || "ar" }), threadID, messageID).catch(() => {});
  }
}
export { isOnePieceTitle, LANG_LABELS };
