// bun scripts/bench-rust.js [iterations] — مقارنة زمن Rust مقابل JS لكل دالة.
// تُقاس نفس المسارات التي يستخدمها الإنتاج (شاملةً ترميز Buffer + JSON.parse في الجسر).
import { isRustAvailable, rustStatus, callRust } from "../src/utils/rustBridge.js";
import timing from "../src/utils/timing.js";
import {
  extractReaderImagesJs, parseMangalikSearchResultsJs, findMangalikChapterRedirectJs,
} from "../src/utils/mangaScrapers.js";
import { __rustParity as comicP } from "../src/cmds/_modules/comic.js";
import { __rustParity as novelP } from "../src/cmds/_modules/novel.js";

if (!isRustAvailable()) {
  console.error(`❌ Rust غير متاح (${rustStatus().reason})`);
  process.exit(2);
}
const N = Number(process.argv[2]) || 2000;

// ── بيانات واقعية الحجم ──
const imgs = Array.from({ length: 60 }, (_, i) => `<div class="page-break"><img class="wp-manga-chapter-img" data-src="https://mangalik.net/wp-content/uploads/ch/${i}.jpg" alt=""></div>`).join("");
const chapterHtml = `<html><head><title>x</title></head><body>${"<div><p>filler</p></div>".repeat(300)}<div class="reading-content">${imgs}</div></body></html>`;
const searchHtml = `<html><body>${Array.from({ length: 30 }, (_, i) => `<div class="c-tabs-item"><div class="post-title"><h3><a href="https://mangalik.net/manga/title-${i}/">Title ${i}</a></h3></div></div>`).join("")}${"<div><p>filler</p></div>".repeat(300)}</body></html>`;
const options = Array.from({ length: 1100 }, (_, i) => `<option data-redirect="/manga/pieceone/${i}/" value="${i}">${i}</option>`).join("");
const redirectHtml = `<html><body><select class="single-chapter-select">${options}</select></body></html>`;
const chapters = Array.from({ length: 1500 }, (_, i) => ({ title: { $t: `Moon Knight #${i}` }, link: [] }));
const titles = chapters.map((c) => c.title.$t);
const longText = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}. ` + "This is a sentence of prose, quite ordinary. ".repeat(8)).join("\n\n");
const dirty = "Some  text\u00a0\u00a0with •••• junk ..... and   spaces " .repeat(60); // >2000 chars: Rust gate used by production
const para = "Just a normal paragraph of a novel chapter with nothing suspicious inside it at all.";

const CHURL = "https://mangalik.net/manga/pieceone/1085/";
const cases = [
  ["extractReaderImages", 3, () => callRust("extract_reader_images", chapterHtml, CHURL, "Mangalik"), () => extractReaderImagesJs(chapterHtml, CHURL, "Mangalik")],
  ["parseMangalikSearchResults", 3, () => callRust("parse_mangalik_search_results", searchHtml), () => parseMangalikSearchResultsJs(searchHtml)],
  ["findMangalikChapterRedirect", 3, () => callRust("find_mangalik_chapter_redirect", redirectHtml, "https://mangalik.net/manga/pieceone/", "1099"), () => findMangalikChapterRedirectJs(redirectHtml, "https://mangalik.net/manga/pieceone/", "1099")],
  ["matchChapter", 2, () => { const r = callRust("match_chapter", JSON.stringify(titles), "1400"); return chapters[r.matchIndex]; }, () => comicP.matchChapterJs(chapters, "1400").match],
  ["splitMessage", 3, () => callRust("split_message", longText, 9000), () => novelP.splitMessageJs(longText, 9000)],
  ["cleanText", 5, () => callRust("clean_text", dirty), () => novelP.cleanTextJs(dirty)],
  ["isFiltered", 5, () => callRust("is_filtered", para), () => novelP.isFilteredJs(para)],
];
// ملاحظة: الإنتاج يستدعي cleanText/isFiltered على فقرات قصيرة؛ نقيس هنا كذلك فقرة قصيرة (para/dirty).

const bench = (fn, n) => {
  for (let i = 0; i < Math.min(50, n); i++) fn(); // warm-up
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - t0) / n; // ms لكل استدعاء
};
// احتفظ إذا ≥ keep، احذف (أضفها لـ DISABLE_RUST_FNS) إذا < drop
const targets = { extractReaderImages: [2, 1.5], parseMangalikSearchResults: [2, 1.5], findMangalikChapterRedirect: [2, 1.5], splitMessage: [2, 1.5], matchChapter: [1.5, 1.5], cleanText: [3, 1.5], isFiltered: [3, 1.5] };

const t = timing.start("bench-rust");
const rss0 = process.memoryUsage().rss;
console.log(`iterations=${N}\n`);
console.log("function".padEnd(30), "JS ms".padStart(10), "Rust ms".padStart(10), "speedup".padStart(9), " target");
for (const [name, div, rustFn, jsFn] of cases) {
  const n = Math.max(20, Math.floor(N / div / (name.startsWith("extract") || name.startsWith("parse") || name.startsWith("find") ? 10 : 1)));
  const js = bench(jsFn, n), rs = bench(rustFn, n);
  const x = js / rs;
  const [keep, drop] = targets[name];
  const verdict = x >= keep ? "KEEP ✅" : x < drop ? "DROP ❌" : "BORDERLINE ⚠️";
  console.log(name.padEnd(30), js.toFixed(4).padStart(10), rs.toFixed(4).padStart(10), `${x.toFixed(2)}x`.padStart(9), ` >${keep}x ${verdict}`);
}
console.log(`\nRSS delta: ${((process.memoryUsage().rss - rss0) / 1048576).toFixed(1)} MB`);
t.end();
