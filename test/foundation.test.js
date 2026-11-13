import { test, expect } from "bun:test";
import { Semaphore, KeyedMutex, RateLimiter, Breaker, runWithFallback, pool, SingleFlight } from "../src/infra/limiter.js";
import { LRU } from "../src/infra/lru.js";
import { Store, MemoryBackend, FileBackend } from "../src/state/kv.js";
import { parseConfig } from "../src/app/config.js";
import { withTempDir, tmpName } from "../src/io/tmp.js";
import { safeFetch, fetchBuffer, sniffImage } from "../src/net/safeFetch.js";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("semaphore caps concurrency", async () => {
  const s = new Semaphore(2); let cur = 0, peak = 0;
  await Promise.all(Array.from({ length: 6 }, () => s.run(async () => { peak = Math.max(peak, ++cur); await new Promise((r) => setTimeout(r, 5)); cur--; })));
  expect(peak).toBe(2);
});
test("keyed mutex serializes read-modify-write", async () => {
  const m = new KeyedMutex(); let v = 0;
  await Promise.all(Array.from({ length: 20 }, () => m.run("k", async () => { const x = v; await new Promise((r) => setTimeout(r, 1)); v = x + 1; })));
  expect(v).toBe(20);
});
test("single flight shares one call", async () => {
  const sf = new SingleFlight(); let n = 0;
  await Promise.all([1, 2, 3].map(() => sf.run("a", async () => { n++; await new Promise((r) => setTimeout(r, 5)); })));
  expect(n).toBe(1);
});
test("rate limiter window", () => {
  let t = 0; const rl = new RateLimiter({ max: 2, windowMs: 1000, now: () => t });
  expect(rl.allow("u").ok).toBe(true); expect(rl.allow("u").ok).toBe(true);
  expect(rl.allow("u").ok).toBe(false); t = 1001; expect(rl.allow("u").ok).toBe(true);
});
test("fallback skips open breaker and aggregates", async () => {
  const br = new Breaker({ failures: 1, openMs: 1000 });
  const calls = [];
  const r = await runWithFallback([{ name: "a" }, { name: "b" }], async (p) => { calls.push(p.name); if (p.name === "a") throw new Error("x"); return "ok"; }, { breaker: br });
  expect(r).toBe("ok"); calls.length = 0;
  await runWithFallback([{ name: "a" }, { name: "b" }], async (p) => { calls.push(p.name); return "ok"; }, { breaker: br });
  expect(calls).toEqual(["b"]);
  await expect(runWithFallback([{ name: "z" }], async () => { throw new Error("q"); })).rejects.toThrow("all_providers_failed");
});
test("pool returns partial results", async () => {
  const r = await pool([1, 2, 3], 2, async (x) => { if (x === 2) throw new Error("no"); return x; });
  expect(r.map((x) => x.ok)).toEqual([true, false, true]);
});
test("LRU respects bytes and ttl", () => {
  let t = 0; const l = new LRU({ maxBytes: 100, maxEntries: 10, now: () => t });
  l.set("a", Buffer.alloc(60)); l.set("b", Buffer.alloc(60));
  expect(l.get("a")).toBeUndefined(); expect(l.get("b")).toBeDefined();
  l.set("c", "x", 10); t = 11; expect(l.get("c")).toBeUndefined();
});
test("kv update is atomic and rolls back on failure", async () => {
  const be = new MemoryBackend(); const st = new Store(be); const ns = st.ns("t");
  await Promise.all(Array.from({ length: 10 }, () => ns.update("c", (v) => (v || 0) + 1, 0)));
  expect(await ns.get("c")).toBe(10);
  be.save = async () => { throw new Error("disk"); };
  await expect(ns.set("c", 99)).rejects.toThrow("disk");
  expect(await ns.get("c")).toBe(10);
});
test("kv file backend quarantines corrupt file instead of overwriting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kvt-")); writeFileSync(join(dir, "bans.json"), "{not json");
  const ns = new Store(new FileBackend(dir)).ns("bans");
  await expect(ns.get("x")).rejects.toMatchObject({ code: "state_corrupt" });
  await expect(ns.set("x", 1)).rejects.toMatchObject({ code: "state_corrupt" });
  expect(readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(true);
});
test("kv ttl expiry", async () => {
  let t = 0; const ns = new Store(new MemoryBackend()).ns("t", { ttlMs: 10, now: () => t });
  await ns.set("a", 1); expect(await ns.get("a")).toBe(1); t = 11; expect(await ns.get("a")).toBeUndefined();
});
test("config validation lists problems", () => {
  expect(() => parseConfig({ Prefix: [""] })).toThrow(/Prefix/);
  const c = parseConfig({ Prefix: [""], allowEmptyPrefix: true, developers: [61551132213582] });
  expect(c.developers).toEqual(["61551132213582"]); expect(Object.isFrozen(c)).toBe(true);
});
test("withTempDir always cleans", async () => {
  let d; await expect(withTempDir(async (dir) => { d = dir; throw new Error("boom"); })).rejects.toThrow("boom");
  expect(existsSync(d)).toBe(false);
  await withTempDir(async (dir) => { expect(tmpName(dir, "../x")).not.toContain(".."); });
});
test("safeFetch blocks private/loopback and non-http", async () => {
  for (const u of ["http://127.0.0.1/", "http://169.254.169.254/latest", "http://[::1]/", "file:///etc/passwd"])
    await expect(safeFetch(u)).rejects.toMatchObject({ code: "blocked_url" });
});
test("safeFetch enforces allowHosts, byte cap and timeout", async () => {
  const srv = Bun.serve({ port: 0, fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/big") return new Response(new Uint8Array(5000));
    if (p === "/slow") return new Promise(() => {});
    if (p === "/redir") return Response.redirect("http://169.254.169.254/", 302);
    return new Response("ok");
  } });
  const base = `http://localhost:${srv.port}`;
  const o = { allowPrivate: true };
  expect((await fetchBuffer(base + "/", o)).toString()).toBe("ok");
  await expect(fetchBuffer(base + "/big", { ...o, maxBytes: 100 })).rejects.toMatchObject({ code: "too_large" });
  await expect(safeFetch(base + "/slow", { ...o, timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
  await expect(safeFetch(base + "/", { ...o, allowHosts: ["example.com"] })).rejects.toMatchObject({ code: "blocked_url" });
  await expect(safeFetch(base + "/redir", { timeoutMs: 500, allowPrivate: false })).rejects.toMatchObject({ code: "blocked_url" });
  srv.stop(true);
});
test("sniffImage", () => {
  expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("jpg");
  expect(sniffImage(Buffer.from("<html>hello world</html>"))).toBeNull();
});
