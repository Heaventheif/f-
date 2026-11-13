import { test, expect } from "bun:test";
import { extractUrl, extractUrlFromEvent, isAllowedAutoHost, firstSeen } from "../src/cmds/autodl.js";
import { planSegmentSeconds, findOversize, buildSegmentArgs } from "../src/utils/mediaSplitter.js";
import { shuffle } from "../src/cmds/_modules/fyp.js";
import { detectVoice, tmpfilesDirectUrl, buildProviders, resolveFormat } from "../src/cmds/_modules/vl.js";
import { collectDraw, makeSeeds, parseArgs as parseDraw, decodeDataUri } from "../src/cmds/_modules/draw.js";
import { classifyQuery } from "../src/cmds/_modules/ytmp3.js";
import { assertDuration, fmtDuration, parseDuration, isAllowedAudioUrl, normalizeYtResults } from "../src/media/audioSource.js";
import { parseArgs as parsePin } from "../src/cmds/_modules/pin.js";
import { parsePick } from "../src/cmds/_modules/yt.js";
import { isNsfwPost } from "../src/cmds/_modules/random.js";
import { normalizeScTrack, searchTracks } from "../src/cmds/_modules/song.js";
import { nextDesign } from "../src/media/betadashCommand.js";
import { pickProgressiveFormat, resolveDownloadUrl } from "../src/utils/yyApi.js";
import { assertImageResponse } from "../src/utils/betadash.js";
import { createFirecrawlClient } from "../src/utils/firecrawlClient.js";
import { staticFact } from "../src/cmds/_modules/animal.js";

test("extractUrl table", () => {
  const rows = [
    ["see https://youtu.be/abc.", "https://youtu.be/abc"],
    ["(https://tiktok.com/@a/video/1)", "https://tiktok.com/@a/video/1"],
    ["x https://a.com/p?q=1, ok", "https://a.com/p?q=1"],
    ["no link", null],
    ["https://a.com/x!?", "https://a.com/x"],
  ];
  for (const [i, o] of rows) expect(extractUrl(i)).toBe(o);
});
test("auto-detect ignores quoted text; hosts allowlist; dedupe", () => {
  const ev = { body: "hi", messageReply: { body: "https://youtu.be/x" } };
  expect(extractUrlFromEvent(ev)).toBe(null);
  expect(extractUrlFromEvent(ev, { allowReply: true })).toBe("https://youtu.be/x");
  expect(isAllowedAutoHost("https://evil.com/?u=youtube.com")).toBe(false);
  expect(isAllowedAutoHost("https://m.youtube.com/a")).toBe(true);
  expect(firstSeen("t1", "https://youtu.be/dd")).toBe(true);
  expect(firstSeen("t1", "https://youtu.be/dd")).toBe(false);
  expect(firstSeen("t2", "https://youtu.be/dd")).toBe(true);
});
test("splitter size planning", () => {
  const cap = 24 * 1024 * 1024;
  expect(planSegmentSeconds(100 * 1024 * 1024, 100, cap)).toBeLessThan(25);
  expect(planSegmentSeconds(100e6, 100, cap, 0.5)).toBeLessThan(planSegmentSeconds(100e6, 100, cap));
  expect(findOversize([{ size: 1 }, { size: cap + 1 }], cap).length).toBe(1);
  const copy = buildSegmentArgs("a.mp4", "p_%03d.mp4", "mp4", 10);
  expect(copy).toContain("copy");
  expect(copy.join(" ")).toContain("-map 0:v? -map 0:a?");
  expect(buildSegmentArgs("a.mp3", "p.mp3", "mp3", 10, { reencode: true })).toContain("libmp3lame");
  expect(buildSegmentArgs("a.mp4", "p.mp4", "mp4", 10, { reencode: true })).toContain("libx264");
});
test("fisher-yates shuffle keeps elements, is unbiased-ish", () => {
  const src = [1, 2, 3, 4, 5, 6];
  expect(shuffle(src).sort()).toEqual(src);
  const counts = {};
  for (let i = 0; i < 6000; i++) { const f = shuffle([1, 2, 3])[0]; counts[f] = (counts[f] || 0) + 1; }
  for (const k of [1, 2, 3]) expect(counts[k]).toBeGreaterThan(1600);
  expect(shuffle([1, 2, 3], () => 0)).toEqual([2, 3, 1]);
});
test("detectVoice incl. mp4 audio, tmpfiles, providers", () => {
  expect(detectVoice({ attachments: [{ type: "audio", url: "https://cdn.fbcdn.net/audioclip-1.mp4" }] })?.url).toContain("audioclip");
  expect(detectVoice({ attachments: [{ type: "video", url: "https://x/a.mp4" }] })).toBe(null);
  expect(detectVoice({ messageReply: { attachments: [{ type: "file", url: "https://x/a.m4a" }] } })).not.toBe(null);
  expect(tmpfilesDirectUrl("http://tmpfiles.org/12/a.mp3")).toBe("https://tmpfiles.org/dl/12/a.mp3");
  expect(tmpfilesDirectUrl("https://tmpfiles.org/dl/12/a.mp3")).toBe("https://tmpfiles.org/dl/12/a.mp3");
  expect(buildProviders({}).map((p) => p.name)).toEqual(["self-host"]);
  expect(buildProviders({ VL_PUBLIC_HOSTS: "1" }).length).toBe(5);
  expect(resolveFormat({ url: "https://x/a.mp4?z=1" }).ext).toBe("m4a");
});
test("draw: partial results, seeds, args", async () => {
  const { files, failures } = await collectDraw([1, 2, 3, 4], async (s) => { if (s === 3) throw new Error("x"); return `f${s}`; });
  expect(files).toEqual(["f1", "f2", "f4"]);
  expect(failures.length).toBe(1);
  expect(new Set(makeSeeds(4)).size).toBe(4);
  expect(makeSeeds(3, 10)).toEqual([10, 11, 12]);
  const p = parseDraw(["seed=7", "anime", "16:9", "a", "cat"]);
  expect([p.seed, p.styleTag, p.ratio, p.rawPrompt]).toEqual([7, "anime", "16:9", "a cat"]);
  expect(parseDraw(["x".repeat(1000)]).rawPrompt.length).toBe(400);
  expect(() => decodeDataUri("nope")).toThrow();
});
test("ytmp3/audio caps and classification", () => {
  expect(() => assertDuration(601)).toThrow();
  expect(assertDuration(600)).toBe(600);
  expect(assertDuration(null)).toBe(null);
  expect(parseDuration("1:02:03")).toBe(3723);
  expect(fmtDuration(225)).toBe("3:45");
  expect(fmtDuration(3723)).toBe("1:02:03");
  expect(isAllowedAudioUrl("https://evil.com/youtube.com")).toBe(false);
  expect(isAllowedAudioUrl("http://localhost/x")).toBe(false);
  expect(classifyQuery("https://music.youtube.com/watch?v=x").kind).toBe("url");
  expect(classifyQuery("http://169.254.169.254/").kind).toBe("blocked");
  expect(classifyQuery("a song").kind).toBe("search");
  const items = normalizeYtResults({ status: true, results: [{ videoId: "abcdefghijk", title: "t", seconds: 100, author: { name: "a" } }, { videoId: "abcdefghijk" }] }, 5);
  expect(items.length).toBe(1);
  expect(items[0].duration).toBe(100);
});
test("song: sc ms->sec and fallback surfaces scError", async () => {
  expect(normalizeScTrack({ title: "x", full_duration: 185000, permalink_url: "u" }).durationSec).toBe(185);
  const r = await searchTracks("q", 1, {
    sc: async () => { throw new Error("boom"); },
    yt: async () => [{ videoId: "abcdefghijk", title: "t", duration: 100, artist: "a", url: "u" }],
  });
  expect(r.source).toBe("yt");
  expect(r.scError.message).toBe("boom");
});
test("pin/yt arg parsers, nsfw filter", () => {
  expect(parsePin(["cars", "12"])).toEqual({ query: "cars", count: 12 });
  expect(parsePin(['"red', 'cars"', "99"])).toEqual({ query: "red cars", count: 20 });
  expect(parsePin(["cars"]).count).toBe(5);
  expect(parsePin(["2024"]).query).toBe("2024");
  expect(parsePick("mp4 2", 3)).toEqual({ index: 1, mp4: true });
  expect(parsePick("9", 3).index).toBe(-1);
  expect(isNsfwPost({ tags: ["funny", "NSFW"] })).toBe(true);
  expect(isNsfwPost({ tags: ["cats"] })).toBe(false);
});
test("canva rotation is atomic", async () => {
  const store = new Map();
  const gd = { get: async (k) => { await new Promise((r) => setTimeout(r, 2)); return store.get(k); }, set: async (k, v) => store.set(k, v) };
  const designs = [{ name: "a" }, { name: "b" }, { name: "c" }];
  const got = await Promise.all([1, 2, 3].map(() => nextDesign(gd, "k", designs, null)));
  expect(new Set(got.map((d) => d.name)).size).toBe(3);
  expect((await nextDesign(gd, "k", designs, "b")).name).toBe("b");
});
test("yy format pick, relative url, betadash payload", () => {
  const f = [{ kind: "progressive", height: 720, download_url: "/a" }, { kind: "progressive", height: 360, download_url: "/b" }, { kind: "video", height: 1080, download_url: "/c" }];
  expect(pickProgressiveFormat(f, 480).download_url).toBe("/b");
  expect(pickProgressiveFormat(f, 100).download_url).toBe("/b");
  expect(pickProgressiveFormat([], 360)).toBe(null);
  expect(resolveDownloadUrl("/api/x?y=1", "https://h.example")).toBe("https://h.example/api/x?y=1");
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200)]);
  expect(assertImageResponse(png, { "content-type": "image/png" }).ext).toBe("png");
  expect(() => assertImageResponse(Buffer.alloc(200, 65), {})).toThrow();
});
test("firecrawl: key cooldown on 402, failover", async () => {
  const seen = [];
  const fetchImpl = async (_u, init) => {
    const key = init.headers.Authorization;
    seen.push(key);
    const ok = key.endsWith("good");
    return { ok, status: ok ? 200 : 402, json: async () => (ok ? { success: true } : { success: false }) };
  };
  const c = createFirecrawlClient({ getApiKeys: () => ["bad", "good"], fetchImpl });
  for (let i = 0; i < 3; i++) expect((await c.scrape("https://x.y")).success).toBe(true);
  expect(seen.filter((k) => k.endsWith("bad")).length).toBe(1);
});
test("animal static fallback", () => {
  expect(staticFact("dog").length).toBeGreaterThan(5);
});
