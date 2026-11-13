import { test, expect } from "bun:test";
import { parseChapter } from "../src/manga/parse.js";
import { MangaDexClient, pickBestManga, findRuns, buildPageUrls, parseRetryAfter, pickBestChapter } from "../src/manga/mangadex.js";
import { deliverImages, planBatches, MAX_PAGES } from "../src/manga/deliver.js";
import { runChain, summarizeErrors } from "../src/manga/sources.js";
import { createBudget } from "../src/manga/budget.js";
import { AppError } from "../src/infra/errors.js";
import { parseComicArgs, matchChapter, isComicPageUrl, isComicImageUrl } from "../src/manga/comicLogic.js";
import {
  isFiltered, isChallengePage, slugify, cleanTitle, findChapterLink, pageOrder, translateBatch,
  verifyTranslation, validChapter, extractContent, proxyTemplates, hasNonLatin,
} from "../src/manga/novelSources.js";
import * as cheerio from "cheerio";

test("parseChapter table", () => {
  const rows = [
    ["naruto", { name: "naruto", chapter: null, lang: null }],
    ["naruto 5", { name: "naruto", chapter: "5", lang: null }],
    ["naruto en", { name: "naruto", chapter: null, lang: "en" }],
    ["naruto 5 en", { name: "naruto", chapter: "5", lang: "en" }],
    ["naruto en 5", { name: "naruto", chapter: "5", lang: "en" }],
    ["one piece 13.5", { name: "one piece", chapter: "13.5", lang: null }],
    ["one piece 13,5", { name: "one piece", chapter: "13.5", lang: null }],
    ["bleach ٧", { name: "bleach", chapter: "7", lang: null }],
    ["bleach 007", { name: "bleach", chapter: "7", lang: null }],
    ["en", { name: "en", chapter: null, lang: null }],
  ];
  for (const [input, exp] of rows) {
    const r = parseChapter(input);
    expect({ name: r.name, chapter: r.chapter, lang: r.lang }).toEqual(exp);
  }
  expect(parseChapter("x 99999").chapter).toBeNull();
  expect(parseChapter("spider-man 2099", { yearLike: true }).chapter).toBeNull();
  expect(parseChapter("spider-man #2099", { yearLike: true }).chapter).toBe("2099");
});

const mk = (id, title, lang, rating = "safe") => ({ id, attributes: { title: { en: title }, contentRating: rating, availableTranslatedLanguages: lang } });

test("pickBestManga prefers requested language and skips porn", () => {
  const c = [mk("a", "Naruto", ["ja"]), mk("b", "Naruto", ["en"]), mk("p", "Naruto", ["en"], "pornographic")];
  expect(pickBestManga("naruto", c, "en").manga.id).toBe("b");
  expect(pickBestManga("zzzzqq", c, "en").manga).toBeNull();
  expect(pickBestManga("naruto", [c[2]], "en").manga).toBeNull();
});

test("findRuns gaps", () => {
  expect(findRuns([1, 2, 3, 7, 8, 12])).toEqual({ runs: [{ from: 1, to: 3 }, { from: 7, to: 8 }, { from: 12, to: 12 }], gaps: [{ from: 4, to: 6 }, { from: 9, to: 11 }] });
  expect(findRuns([])).toEqual({ runs: [], gaps: [] });
});

test("buildPageUrls uses data-saver and rejects bad hosts", () => {
  const d = { baseUrl: "https://uploads.mangadex.network", chapter: { hash: "h", data: ["a.png"], dataSaver: ["a.jpg"] } };
  expect(buildPageUrls(d)[0]).toBe("https://uploads.mangadex.network/data-saver/h/a.jpg");
  expect(buildPageUrls(d, false)[0]).toContain("/data/h/a.png");
  expect(buildPageUrls({ ...d, baseUrl: "https://evil.com" })).toEqual([]);
  expect(buildPageUrls({ ...d, baseUrl: "http://uploads.mangadex.network" })).toEqual([]);
});

test("pickBestChapter excludes external and empty", () => {
  const raw = [
    { id: "1", attributes: { chapter: "5", pages: 0 } },
    { id: "2", attributes: { chapter: "5", externalUrl: "x", pages: 3 } },
    { id: "3", attributes: { chapter: "5.0", pages: 10, translatedLanguage: "en" } },
  ];
  expect(pickBestChapter(raw, 5).id).toBe("3");
});

test("MangaDexClient: 429 Retry-After, rate limit slots, cache", async () => {
  let t = 0;
  const sleeps = [];
  const calls = [];
  const responses = [{ status: 429, retryAfter: "2", body: "" }, { status: 200, retryAfter: null, body: '{"data":[]}' }];
  const c = new MangaDexClient({
    now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; },
    request: async (u) => { calls.push(u); return responses.shift() || { status: 200, body: '{"data":[]}' }; },
  });
  expect(await c.get("/manga", { title: "x" })).toEqual({ data: [] });
  expect(calls.length).toBe(2);
  expect(sleeps.some((s) => s >= 1900)).toBe(true);
  await c.get("/manga", { title: "x" }); // cached
  expect(calls.length).toBe(2);
  // 4 req/s: five distinct requests need >= 750ms of waiting in total
  sleeps.length = 0;
  for (let i = 0; i < 5; i++) await c.get("/manga", { title: `q${i}` });
  expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(750 - 250);
  expect(parseRetryAfter("3")).toBe(3000);
});

test("MangaDexClient: persistent 429 -> rate_limited; 404 -> not_found", async () => {
  const c = new MangaDexClient({ sleep: async () => {}, request: async () => ({ status: 429, body: "" }), maxRetries: 1 });
  await expect(c.get("/x")).rejects.toMatchObject({ code: "rate_limited" });
  const c2 = new MangaDexClient({ sleep: async () => {}, request: async () => ({ status: 404, body: "" }) });
  await expect(c2.get("/y")).rejects.toMatchObject({ code: "not_found" });
});

test("planBatches / page cap", () => {
  expect(planBatches(30, 14)).toEqual([[0, 14], [14, 28], [28, 30]]);
  expect(MAX_PAGES).toBe(140);
});

test("deliverImages: failure reasons + prefetch order", async () => {
  const urls = Array.from({ length: 5 }, (_, i) => `https://x/${i}`);
  const sent = [];
  const r = await deliverImages({
    urls, batchSize: 2, sleep: async () => {},
    download: async (u) => { if (u.endsWith("/1")) throw new AppError("timeout", "t"); return u; },
    send: async (files, info) => { sent.push([...files]); },
  });
  expect(r.sent).toBe(4);
  expect(r.failures).toEqual([{ page: 2, reason: "مهلة" }]);
  expect(sent.length).toBe(3);
});

test("deliverImages: resume-no-duplicate with failing sender", async () => {
  const urls = Array.from({ length: 6 }, (_, i) => `https://x/${i}`);
  const sent = [];
  let n = 0;
  const r = await deliverImages({
    urls, batchSize: 2, sleep: async () => {},
    download: async (u) => u,
    send: async (files) => { n++; if (n >= 2) throw new Error("send fail"); sent.push(...files); },
  });
  expect(r.sent).toBe(2);
  expect(r.aborted.page).toBe(3);
  expect(sent).toEqual(["https://x/0", "https://x/1"]);
  // chain stops after partial delivery: next source is NOT tried
  let secondCalled = false;
  const sources = [
    { name: "a", langs: null, find: async () => ({}), chapter: async () => ({ imageUrls: ["u"] }) },
    { name: "b", langs: null, find: async () => { secondCalled = true; return {}; }, chapter: async () => ({}) },
  ];
  const out = await runChain(sources, { lang: "ar" }, async () => ({ sent: 2, aborted: { page: 3 } }));
  expect(out.result.sent).toBe(2);
  expect(secondCalled).toBe(false);
});

test("runChain: falls through when nothing delivered; 3asq only for ar", async () => {
  const order = [];
  const src = (name, langs, fn) => ({ name, langs, find: async () => (order.push(name), {}), chapter: fn });
  const sources = [
    src("dex", null, async () => { throw new AppError("not_found", "x", { meta: { what: "chapter" } }); }),
    src("3asq", ["ar"], async () => ({ imageUrls: ["u"] })),
  ];
  await runChain(sources, { lang: "ar" }, async () => ({ sent: 1 }));
  expect(order).toEqual(["dex", "3asq"]);
  order.length = 0;
  await expect(runChain(sources, { lang: "en" }, async () => ({ sent: 1 }))).rejects.toMatchObject({ code: "not_found" });
  expect(order).toEqual(["dex"]);
  expect(summarizeErrors([]).code).toBe("not_found");
});

test("budget per user per day", async () => {
  const store = new Map();
  const ns = () => ({ update: async (k, fn, init) => { const v = await fn(store.has(k) ? store.get(k) : init); store.set(k, v); return v; } });
  const b = createBudget({ ns, limit: 2, now: () => Date.UTC(2026, 0, 1) });
  await b.take("u1"); await b.take("u1");
  await expect(b.take("u1")).rejects.toMatchObject({ code: "rate_limited" });
  await b.take("u2");
});

test("comic args / chapters / urls", () => {
  expect(parseComicArgs(["Spider-Man", "2099"])).toEqual({ name: "Spider-Man 2099", chapterQuery: null });
  expect(parseComicArgs(["Spider-Man", "2099", "5"])).toEqual({ name: "Spider-Man 2099", chapterQuery: "5" });
  expect(parseComicArgs(["moon", "knight", "7.5"]).chapterQuery).toBe("7.5");
  expect(parseComicArgs(["batman", "annual", "1"])).toEqual({ name: "batman", chapterQuery: "annual 1" });
  const t = (s) => ({ title: { $t: s }, link: [{ rel: "alternate", href: "https://arcomixverse.blogspot.com/x" }] });
  const ch = [t("Moon Knight #7"), t("Moon Knight #7.5"), t("Moon Knight Annual #1"), t("Moon Knight #1")];
  expect(matchChapter(ch, "7.50").match.title.$t).toBe("Moon Knight #7.5");
  expect(matchChapter(ch, "1").match.title.$t).toBe("Moon Knight #1");
  expect(matchChapter(ch, "annual 1").match.title.$t).toContain("Annual");
  const amb = matchChapter([t("A #3"), t("B #3")], "3");
  expect(amb.ambiguous).toBe(true);
  expect(amb.candidates.length).toBe(2);
  expect(matchChapter(null, "3").match).toBeNull();
  expect(isComicPageUrl("https://arcomixverse.blogspot.com/2020/a.html")).toBe(true);
  expect(isComicPageUrl("https://arcomixverse.blogspot.com.evil.com/")).toBe(false);
  expect(isComicPageUrl("http://arcomixverse.blogspot.com/")).toBe(false);
  expect(isComicImageUrl("https://blogger.googleusercontent.com/a.jpg")).toBe(true);
  expect(isComicImageUrl("http://blogger.googleusercontent.com/a.jpg")).toBe(false);
  expect(isComicImageUrl("https://169.254.169.254/a.jpg")).toBe(false);
});

test("novel: challenge markers, filter, slug, title", () => {
  const article = "<html><body>" + "x".repeat(600) + "<p>The cloudflare dragon roared.</p></body></html>";
  expect(isChallengePage(article)).toBe(false);
  expect(isChallengePage("<html><title>Just a moment...</title><div class='cf-chl-widget'>")).toBe(true);
  expect(isFiltered('"No."')).toBe(false);
  expect(isFiltered("He said to go to the next chapter of his life.")).toBe(false);
  expect(isFiltered("Next Chapter »")).toBe(true);
  expect(isFiltered("Visit novelfull.com for more")).toBe(true);
  expect(slugify("Spider-Man's Tale!")).toBe("spider-mans-tale");
  expect(slugify("Café Noir")).toBe("cafe-noir");
  expect(slugify("رواية")).toBe("");
  expect(hasNonLatin("رواية")).toBe(true);
  expect(cleanTitle("Spider-Man - Chapter 5 | NovelFull")).toBe("Spider-Man");
  expect(cleanTitle("Spider-Man Returns")).toBe("Spider-Man Returns");
  expect(validChapter(5000)).toBe(true);
  expect(validChapter(5001)).toBe(false);
  expect(validChapter(1.5)).toBe(false);
  expect(validChapter(0)).toBe(false);
});

test("novel: extractContent keeps short dialogue", () => {
  const $ = cheerio.load('<div id="chapter-content"><p>"No."</p><p>She walked away slowly.</p><p>Next Chapter</p></div>');
  expect(extractContent($, ["#chapter-content"])).toEqual(['"No."', "She walked away slowly."]);
});

test("novel: NovelFull exact chapter regex and paging", () => {
  const html = '<a href="/x/chapter-10-foo.html">10</a><a href="/x/chapter-1-bar.html">1</a><a href="/x/chapter-100.html">100</a>';
  expect(findChapterLink(html, 1).url).toBe("https://novelfull.com/x/chapter-1-bar.html");
  expect(findChapterLink(html, 10).url).toBe("https://novelfull.com/x/chapter-10-foo.html");
  expect(findChapterLink(html, 11).url).toBeNull();
  const order = pageOrder(260, 30);
  expect(order[0]).toBe(6);
  expect(order.length).toBeGreaterThan(5);
  expect(new Set(order).size).toBe(order.length);
});

test("novel: translateBatch separator check + failure accounting", async () => {
  const good = await translateBatch(["a one", "b two"], { translate: async (t) => t.split(" ||| ").map((x) => "ع" + x).join(" ||| "), sleep: async () => {} });
  expect(good).toEqual({ paragraphs: ["عa one", "عb two"], failed: 0 });
  // engine drops a separator -> falls back per paragraph
  let call = 0;
  const bad = await translateBatch(["a", "b"], { translate: async (t) => (t.includes("|||") ? "merged only" : "T" + t), sleep: async () => {} });
  expect(bad.paragraphs).toEqual(["Ta", "Tb"]);
  void call;
  const dead = await translateBatch(["a", "b"], { translate: async () => { throw new Error("x"); }, sleep: async () => {} });
  expect(dead).toEqual({ paragraphs: ["a", "b"], failed: 2 });
});

test("novel: verifyTranslation capped", async () => {
  let n = 0;
  const paras = Array.from({ length: 30 }, () => "english text only");
  const r = await verifyTranslation(paras, { translate: async () => (n++, "ترجمة عربية كاملة"), maxRetries: 5 });
  expect(n).toBe(5);
  expect(r.incomplete).toBe(true);
});

test("novel: proxies are opt-in", () => {
  expect(proxyTemplates({})).toEqual([]);
  expect(proxyTemplates({ NOVEL_PROXIES: "https://p.example/?u={url},http://bad/{url},nope" })).toEqual(["https://p.example/?u={url}"]);
});
