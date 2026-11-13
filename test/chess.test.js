import { test, expect } from "bun:test";
import { applyUci, isUciMove, isReachableFen, START_FEN, statusOfFen } from "../src/chess/rules.js";
import { createChessStore } from "../src/chess/store.js";
import { callEngine } from "../src/cmds/_modules/chess.js";

test("rules: legality, promotion, notation", () => {
  expect(isUciMove("E2 E4")).toBe(true);
  expect(isUciMove("hello")).toBe(false);
  const r = applyUci(START_FEN, "E2 E4");
  expect(r.ok).toBe(true);
  expect(r.san).toBe("e4");
  expect(applyUci(START_FEN, "e2e5")).toMatchObject({ ok: false, reason: "illegal" });
  expect(applyUci(START_FEN, "hello").reason).toBe("not_a_move");
  const promo = applyUci("8/P7/8/8/8/8/k6K/8 w - - 0 1", "a7a8");
  expect(promo.promotion).toBe("q");
  expect(applyUci("8/P7/8/8/8/8/k6K/8 w - - 0 1", "a7a8n").promotion).toBe("n");
});

test("rules: fool's mate and engine-fen validation", () => {
  let fen = START_FEN;
  for (const m of ["f2f3", "e7e5", "g2g4", "d8h4"]) { const r = applyUci(fen, m); expect(r.ok).toBe(true); fen = r.fen; if (m === "d8h4") expect(r.result).toEqual({ winner: "black" }); }
  const after = applyUci(START_FEN, "e2e4").fen;
  const reply = applyUci(after, "e7e5").fen;
  expect(isReachableFen(after, reply)).toBe(true);
  expect(isReachableFen(after, START_FEN)).toBe(false);
  expect(isReachableFen(after, "garbage")).toBe(false);
  expect(statusOfFen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1", "w").result).toEqual({ draw: true, winner: null });
});

test("store: turns, version conflicts, ttl sweep", async () => {
  const data = new Map();
  const ns = { get: async (k) => data.get(k), list: async () => [...data], del: async (k) => data.delete(k), set: async (k, v) => data.set(k, v), update: async (k, fn) => { const v = await fn(data.get(k)); data.set(k, v); return v; } };
  let t = 1000;
  const store = createChessStore({ ns, now: () => t, idleMs: 100 });
  const g = await store.create({ threadID: 12, player_white: 1, player_black: "bot", current_turn: 1, fen: START_FEN });
  expect(typeof g.id).toBe("string");
  expect(g.current_turn).toBe("1");
  expect((await store.findActive("12", "1")).id).toBe(g.id);
  expect(await store.findActive("13", "1")).toBeNull();
  const g2 = await store.update(g.id, 1, { current_turn: "bot" });
  expect(g2.version).toBe(2);
  await expect(store.update(g.id, 1, { current_turn: "1" })).rejects.toMatchObject({ code: "conflict" });
  const notified = [];
  t += 50;
  expect(await store.sweep((x) => notified.push(x.id))).toBe(0);
  t += 100;
  expect(await store.sweep((x) => notified.push(x.id))).toBe(1);
  expect(notified).toEqual([g.id]);
  expect(await store.findActive("12", "1")).toBeNull();
});

test("store: per-game mutex serialises", async () => {
  const store = createChessStore({ ns: { get: async () => null } });
  const order = [];
  await Promise.all([
    store.withLock("a", async () => { await new Promise((r) => setTimeout(r, 20)); order.push(1); }),
    store.withLock("a", async () => { order.push(2); }),
  ]);
  expect(order).toEqual([1, 2]);
});

test("engine: token only via https allowlisted target; image capped; difficulty", async () => {
  let seen;
  const getJson = async (url, o) => { seen = { url, o }; return { image_base64: "x".repeat(9 * 1024 * 1024), new_fen: "f" }; };
  const target = { base: "https://a.hf.space", host: "a.hf.space", headers: { "X-Internal-Token": "t" } };
  const d = await callEngine({ fen: "f", move: "e2e4", botMode: true, difficulty: 5, perspective: "white", target, getJson });
  expect(d.image_base64).toBeNull();
  expect(seen.o.allowHosts).toEqual(["a.hf.space"]);
  expect(seen.o.body.difficulty).toBe(5);
  await callEngine({ fen: "f", botMode: true, difficulty: 99, perspective: "white", target, getJson });
  expect(seen.o.body.difficulty).toBe(10);
  await expect(callEngine({ fen: "f", target: null, getJson })).rejects.toMatchObject({ code: "not_configured" });
});
