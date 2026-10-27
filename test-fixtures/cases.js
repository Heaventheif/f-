// عينات اختبار مشتركة بين parity-test.js و bench-rust.js. كل مصفوفة ≥ 10 حالات.
const reader = (imgs) => `<html><body><div class="reading-content">${imgs}</div></body></html>`;
const BASE = "https://mangalik.net/manga/pieceone/1085/";

export const readerImages = [
  { name: "basic-src", html: reader(`<img class="wp-manga-chapter-img" src="https://mangalik.net/a.jpg">`), url: BASE, source: "Mangalik" },
  { name: "data-src-priority", html: reader(`<img class="wp-manga-chapter-img" data-src=" https://mangalik.net/b.jpg " src="https://mangalik.net/x.jpg">`), url: BASE, source: "Mangalik" },
  { name: "lazy-original", html: reader(`<img class="wp-manga-chapter-img" data-lazy-src="/c.jpg"><img class="wp-manga-chapter-img" data-original="//mangalik.net/d.jpg">`), url: BASE, source: "Mangalik" },
  { name: "empty-attr-falls-through", html: reader(`<img class="wp-manga-chapter-img" data-src="" src="/e.jpg">`), url: BASE, source: "Mangalik" },
  { name: "page-break-and-dedupe", html: reader(`<div class="page-break"><img src="/f.jpg#1"></div><div class="page-break"><img src="/f.jpg#2"></div>`), url: BASE, source: "Mangalik" },
  { name: "foreign-host-rejected", html: reader(`<img class="wp-manga-chapter-img" src="https://evil.com/a.jpg">`), url: BASE, source: "Mangalik" },
  { name: "http-rejected", html: reader(`<img class="wp-manga-chapter-img" src="http://mangalik.net/a.jpg">`), url: BASE, source: "Mangalik" },
  { name: "credentials-rejected", html: reader(`<img class="wp-manga-chapter-img" src="https://u:p@mangalik.net/a.jpg">`), url: BASE, source: "Mangalik" },
  { name: "suffix-trick-rejected", html: reader(`<img class="wp-manga-chapter-img" src="https://evilmangalik.net/a.jpg">`), url: BASE, source: "Mangalik" },
  { name: "starz-subdomain", html: reader(`<img class="wp-manga-chapter-img" src="https://cdn.starzmanga.com/p/1.webp"><img class="wp-manga-chapter-img" src="https://img.manga-starz.net/2.webp">`), url: "https://starzmanga.com/manga/one-piece/1/", source: "StarzManga" },
  { name: "wrong-source-for-host", html: reader(`<img class="wp-manga-chapter-img" src="https://starzmanga.com/1.jpg">`), url: BASE, source: "Mangalik" },
  { name: "no-img-attrs-undefined-quirk", html: reader(`<img class="wp-manga-chapter-img">`), url: BASE, source: "Mangalik" },
  { name: "malformed-html", html: `<div class="reading-content"><img class="wp-manga-chapter-img" src="/z.jpg"`, url: BASE, source: "Mangalik" },
  { name: "empty", html: "", url: BASE, source: "Mangalik" },
  { name: "unicode-path", html: reader(`<img class="wp-manga-chapter-img" src="/صورة 1.jpg">`), url: BASE, source: "Mangalik" },
];

export const searchResults = [
  { name: "post-title", html: `<div class="c-tabs-item"><div class="post-title"><h3><a href="https://mangalik.net/manga/foo-bar/">  Foo Bar </a></h3></div></div>` },
  { name: "title-attr", html: `<a href="/manga/abc/" title="ABC Title"></a>` },
  { name: "img-alt", html: `<a href="/manga/abc/"><img alt="Alt Name"></a>` },
  { name: "anchor-text", html: `<a href="/manga/abc/"> Anchor Text </a>` },
  { name: "slug-fallback", html: `<a href="/manga/hello_world-test/"></a>` },
  { name: "slug-percent-decoded", html: `<a href="/manga/%D9%85%D8%A7%D9%86%D8%AC%D8%A7-1/"></a>` },
  { name: "dedupe-first-wins", html: `<a href="/manga/x/">First</a><a href="/manga/x/?p=2">Second</a>` },
  { name: "too-many-segments", html: `<a href="/manga/x/1085/">no</a><a href="/manga/y/">yes</a>` },
  { name: "foreign-host", html: `<a href="https://evil.com/manga/x/">no</a><a href="https://sub.mangalik.net/manga/ok/">ok</a>` },
  { name: "http-rejected", html: `<a href="http://mangalik.net/manga/x/">no</a>` },
  { name: "multiple-cards", html: `<div class="c-tabs-item"><div class="post-title"><a href="/manga/a/">A</a></div></div><div class="c-tabs-item"><div class="post-title"><a href="/manga/b/">B</a></div></div>` },
  { name: "empty", html: "" },
  { name: "malformed", html: `<div class="c-tabs-item"><a href="/manga/z/">Z` },
];

const sel = (opts) => `<select class="single-chapter-select">${opts}</select>`;
const M = "https://mangalik.net/manga/pieceone/";
export const redirects = [
  { name: "by-text", html: sel(`<option data-redirect="/manga/pieceone/1085/">1085</option>`), manga: M, chapter: "1085" },
  { name: "by-value", html: sel(`<option data-redirect="/manga/pieceone/zz/" value="1085">x</option>`), manga: M, chapter: 1085 },
  { name: "by-last-segment-decimal", html: sel(`<option data-redirect="/manga/pieceone/1085-2/">x</option>`), manga: M, chapter: "1085.2" },
  { name: "comma-decimal-query", html: sel(`<option data-redirect="/manga/pieceone/7-5/">x</option>`), manga: M, chapter: "7,5" },
  { name: "foreign-redirect-skipped", html: sel(`<option data-redirect="https://evil.com/manga/pieceone/1085/">1085</option><option data-redirect="/manga/pieceone/1085/">1085</option>`), manga: M, chapter: "1085" },
  { name: "no-match", html: sel(`<option data-redirect="/manga/pieceone/1/">1</option>`), manga: M, chapter: "999" },
  { name: "no-select", html: `<div></div>`, manga: M, chapter: "1" },
  { name: "empty-chapter-quirk", html: sel(`<option data-redirect="/manga/pieceone/1/">1</option>`), manga: M, chapter: "" },
  { name: "space-separator", html: sel(`<option data-redirect="/manga/pieceone/12/">Chapter 12</option>`), manga: M, chapter: "chapter 12" },
  { name: "percent-segment", html: sel(`<option data-redirect="/manga/pieceone/%D9%A1/">x</option>`), manga: M, chapter: "١" },
  { name: "empty-html", html: "", manga: M, chapter: "1" },
  { name: "fragment-stripped", html: sel(`<option data-redirect="/manga/pieceone/5/#top">5</option>`), manga: M, chapter: "5" },
];

const T = (...a) => a.map((t) => ({ title: { $t: t }, link: [{ rel: "alternate", href: "https://x/" + encodeURIComponent(t) }] }));
export const chapters = [
  { name: "exact-title", chapters: T("العدد #1", "العدد #2"), query: "العدد #2" },
  { name: "exact-trimmed", chapters: T("  Batman #3  ", "Batman #4"), query: " Batman #3" },
  { name: "bare-number", chapters: T("Moon Knight #7", "Moon Knight #8"), query: "7" },
  { name: "decimal", chapters: T("Moon Knight #7", "Moon Knight #7.5"), query: "7.5" },
  { name: "arabic-digits", chapters: T("العدد #٧", "العدد #٨"), query: "٨" },
  { name: "annual-wanted", chapters: T("Batman #1", "Batman Annual #1"), query: "annual 1" },
  { name: "annual-arabic", chapters: T("العدد #1", "العدد السنوي #1"), query: "سنوي 1" },
  { name: "ambiguous", chapters: T("Batman #1", "Batman #1 Variant", "Batman Annual #1"), query: "1" },
  { name: "ambiguous-endswith", chapters: T("Foo 1 Variant", "Foo #1"), query: "1" },
  { name: "no-number", chapters: T("a", "b"), query: "abc" },
  { name: "no-match", chapters: T("Batman #1"), query: "99" },
  { name: "empty-query", chapters: T("Batman #1"), query: "   " },
  { name: "empty-list", chapters: [], query: "5" },
  { name: "number-prefix-collision", chapters: T("Batman #10", "Batman #1"), query: "1" },
];

export const novelTexts = [
  "Hello world.",
  "  leading and trailing   spaces  ",
  "nbsp\u00a0\u00a0\u00a0between",
  "bullets •••• and ◆◆ and ▪▪▪ end",
  "dots..... and .... and ... and ..",
  "tabs\t\t\tand\n\nnewlines   mixed",
  "bom\ufeff\ufeffinside",
  "nel\u0085\u0085inside",
  "الفصل الأول ...... بداية القصة   الطويلة",
  "emoji 😀😀  double",
  "",
  "   ",
];

export const filterTexts = [
  "Click NEXT CHAPTER to continue",
  "Visit novelfull.com for more",
  "Just a Moment... Cloudflare",
  "This chapter was stolen from somewhere",
  "THE CONTENT IS STOLEN",
  "If you're reading this on a pirate site",
  "if you are reading this on amazon",
  "Please read this on the original site",
  "Unauthorized use of this text",
  "Support the translator by reading at the official site",
  "A completely normal sentence about a hero.",
  "Stole content but different order",
  "",
];

const para = (n, s) => Array.from({ length: n }, (_, i) => `${s} ${i}.`).join(" ");
export const splitCases = [
  { name: "short", text: "aaa\n\nbbb\n\nccc", max: 10 },
  { name: "single-fits", text: "hello", max: 9000 },
  { name: "empty", text: "", max: 100 },
  { name: "only-newlines", text: "\n\n\n\n", max: 100 },
  { name: "long-paragraph", text: para(60, "Sentence number"), max: 200 },
  { name: "many-paragraphs", text: Array.from({ length: 40 }, (_, i) => para(5, "Para" + i)).join("\n\n"), max: 300 },
  { name: "arabic-punct", text: "جملة أولى، جملة ثانية؟ جملة ثالثة! ".repeat(30), max: 120 },
  { name: "emoji-utf16", text: "😀😀😀😀 ".repeat(50), max: 40 },
  { name: "no-terminators-long", text: "x".repeat(500), max: 100 },
  { name: "leading-terminators", text: "..." + "word ".repeat(60), max: 50 },
  { name: "exact-boundary", text: "a".repeat(8), max: 10 },
  { name: "trailing-ws", text: "abc\n\n   \n\ndef", max: 8 },
  { name: "default-max-9000", text: para(2000, "Long chapter text"), max: 9000 },
];
