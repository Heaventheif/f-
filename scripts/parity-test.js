// bun scripts/parity-test.js — يقارن Rust مع JS الأصلي على test-fixtures/cases.js.
// المقارنة بـ JSON.stringify مع ترتيب مفاتيح ثابت. أي FAIL → exit 1.
import { rustStatus, isRustAvailable, callRust } from "../src/utils/rustBridge.js";
import {
  extractReaderImagesJs, parseMangalikSearchResultsJs, findMangalikChapterRedirectJs,
} from "../src/utils/mangaScrapers.js";
import { __rustParity as comicP } from "../src/cmds/_modules/comic.js";
import { __rustParity as novelP } from "../src/cmds/_modules/novel.js";
import * as C from "../test-fixtures/cases.js";

if (!isRustAvailable()) {
  console.error(`❌ Rust غير متاح (${rustStatus().reason}) — لا يمكن إجراء parity.`);
  process.exit(2);
}

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;
const canon = (v) => JSON.stringify(sortKeys(v === undefined ? "__undefined__" : v));
// JS قد يرمي (مثلاً decodeURIComponent)؛ نعتبر "رمى" نتيجة قابلة للمقارنة.
const run = (fn) => { try { return { v: fn() }; } catch (e) { return { threw: true }; } };

let pass = 0, fail = 0;
function check(group, name, rustFn, jsFn) {
  const r = run(rustFn), j = run(jsFn);
  // إن رمى Rust بينما JS لم يرمِ → FAIL. إن رمى الاثنان → PASS (المستدعي سيسقط لـ JS ويرمي بالمثل).
  const ok = r.threw && j.threw ? true : (!r.threw && !j.threw && canon(r.v) === canon(j.v));
  if (ok) { pass++; console.log(`PASS ${group}/${name}`); }
  else {
    fail++;
    console.log(`FAIL ${group}/${name}`);
    console.log("   rust:", r.threw ? "THREW" : canon(r.v));
    console.log("   js  :", j.threw ? "THREW" : canon(j.v));
  }
}

for (const c of C.readerImages)
  check("extractReaderImages", c.name, () => callRust("extract_reader_images", c.html, c.url, c.source), () => extractReaderImagesJs(c.html, c.url, c.source));

for (const c of C.searchResults)
  check("parseMangalikSearchResults", c.name, () => callRust("parse_mangalik_search_results", c.html), () => parseMangalikSearchResultsJs(c.html));

for (const c of C.redirects)
  check("findMangalikChapterRedirect", c.name,
    () => callRust("find_mangalik_chapter_redirect", c.html, c.manga, String(c.chapter || "")),
    () => findMangalikChapterRedirectJs(c.html, c.manga, c.chapter));

for (const c of C.chapters)
  check("matchChapter", c.name,
    () => {
      const r = callRust("match_chapter", JSON.stringify(c.chapters.map((x) => x.title.$t)), String(c.query));
      return { match: r.matchIndex == null ? null : c.chapters[r.matchIndex], ambiguous: r.ambiguous, candidates: r.candidateIndices.map((i) => c.chapters[i]) };
    },
    () => comicP.matchChapterJs(c.chapters, c.query));

C.novelTexts.forEach((t, i) =>
  check("cleanText", `case-${i}`, () => callRust("clean_text", t), () => novelP.cleanTextJs(t)));

C.filterTexts.forEach((t, i) =>
  check("isFiltered", `case-${i}`, () => callRust("is_filtered", t), () => novelP.isFilteredJs(t)));

for (const c of C.splitCases)
  check("splitMessage", c.name, () => callRust("split_message", c.text, c.max), () => novelP.splitMessageJs(c.text, c.max));

console.log(`\n${fail === 0 ? "✅" : "❌"} parity: ${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
