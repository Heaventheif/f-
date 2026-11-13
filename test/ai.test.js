import { test, expect } from "bun:test";
import { parseTrArgs, resolveLang } from "../src/cmds/tr.js";
import { buildHelp, paginateBlocks } from "../src/cmds/help.js";
import { cleanReply } from "../src/ai/text.js";
import { runChain } from "../src/ai/providers.js";
import { Breaker } from "../src/infra/limiter.js";
import { AppError } from "../src/infra/errors.js";
import { resolveTargets, planKick } from "../src/admin/targets.js";
import { planBan, paginateBans } from "../src/cmds/_modules/ban.js";
import { canUnsend } from "../src/cmds/unsend.js";
import { createPrefs } from "../src/cmds/_modules/tts.js";
import { Store, MemoryBackend } from "../src/state/kv.js";

test("tr: plain words are text, explicit lang forms parse", () => {
  expect(parseTrArgs(["no", "way"])).toEqual({ lang: "ar", text: "no way" });
  expect(parseTrArgs(["it", "is", "cold"])).toEqual({ lang: "ar", text: "it is cold" });
  expect(parseTrArgs(["en:", "مرحبا"])).toEqual({ lang: "en", text: "مرحبا" });
  expect(parseTrArgs(["-fr", "hello"])).toEqual({ lang: "fr", text: "hello" });
  expect(parseTrArgs(["zh", "x"].slice(0, 1), "hi")).toEqual({ lang: "zh-CN", text: "hi" });
  expect(parseTrArgs(["مرحبا", "بك"])).toEqual({ lang: "en", text: "مرحبا بك" });
  expect(parseTrArgs(["-xx", "a"]).error).toBeTruthy();
  expect(parseTrArgs([]).error).toBeTruthy();
  expect(resolveLang("انجليزي")).toBe("en");
});

const cmd = (name, role = 0, category = "x") => ({ config: { name, role, category, description: { ar: "d" + name } } });
test("help: role hiding, search, details, pagination boundaries", () => {
  const cmds = [cmd("alpha"), cmd("secret", 2)];
  expect(buildHelp(cmds, { role: 0 }).join("\n")).not.toContain("secret");
  expect(buildHelp(cmds, { role: 0, query: "secret" }).join("\n")).not.toContain("📖");
  expect(buildHelp(cmds, { role: 2, query: "secret" })[0]).toContain("📖 secret");
  const many = Array.from({ length: 400 }, (_, i) => cmd("c" + String(i).padStart(3, "0"), 0, "cat" + i));
  const pages = buildHelp(many, { role: 0 });
  expect(pages.length).toBeGreaterThan(1);
  for (const p of pages) expect(p.length).toBeLessThanOrEqual(2200);
  expect(paginateBlocks("t", "s", []).length).toBe(1);
  expect(paginateBlocks("t", "s", ["a"]).length).toBe(1);
});

test("cleanReply keeps code blocks and tables, strips noise", () => {
  const src = "## Title\n**bold**\n---\n```js\n**keep** ---\n```\n| a | b |\n|---|---|\n@DONE@";
  const out = cleanReply(src);
  expect(out).toContain("**keep** ---");
  expect(out).toContain("|---|---|");
  expect(out).not.toContain("@DONE@");
  expect(out).not.toContain("## ");
  expect(out).toContain("bold");
});

test("provider breaker: 429/5xx trip, 413 truncates once, 4xx AppError does not trip", async () => {
  const mk = (name, onCall) => ({ name, maxPrompt: 1000, timeoutMs: 1, buildRequest: (p) => ({ url: "u", method: "POST", body: { p } }), parse: (j) => j.t, onCall });
  const err = (status) => Object.assign(new Error("x"), { status });
  const br = new Breaker({ failures: 2, openMs: 10_000 });
  let aCalls = 0;
  const a = mk("a");
  const b = mk("b");
  const fj = async (_u, { body }) => {
    if (body.__who) return;
    return { t: "ok" };
  };
  const fjFail = async (url, opts) => { aCalls++; throw err(429); };
  await expect(runChain([a], "hi", { breaker: br, fj: fjFail })).rejects.toThrow();
  await expect(runChain([a], "hi", { breaker: br, fj: fjFail })).rejects.toThrow();
  expect(br.isOpen("a")).toBe(true);
  // open provider is skipped while another is live
  const r = await runChain([a, b], "hi", { breaker: br, fj });
  expect(r.provider).toBe("b");
  // 413: truncated retry succeeds without tripping
  const br2 = new Breaker({ failures: 1, openMs: 10_000 });
  const lens = [];
  const fj413 = async (_u, { body }) => { lens.push(body.p.length); if (lens.length === 1) throw err(413); return { t: "ok" }; };
  const r2 = await runChain([mk("c")], "x".repeat(800), { breaker: br2, fj: fj413 });
  expect(r2.text).toBe("ok");
  expect(lens[1]).toBeLessThan(lens[0]);
  expect(br2.isOpen("c")).toBe(false);
  // blocked_url AppError does not trip
  const br3 = new Breaker({ failures: 1, openMs: 10_000 });
  await expect(runChain([mk("d")], "hi", { breaker: br3, fj: async () => { throw new AppError("blocked_url", "x"); } })).rejects.toThrow();
  expect(br3.isOpen("d")).toBe(false);
});

test("resolveTargets: multi-word mention names, ids, reply, text", () => {
  const ev = { mentions: { 111111: "@Ali Hassan", 222222: "Bob" } };
  const r = resolveTargets(ev, ["@Ali", "Hassan", "and", "Bob", "newnick"]);
  expect(r.ids).toEqual(["111111", "222222"]);
  expect(r.via).toBe("mention");
  expect(r.text).toBe("and newnick".replace("and ", "and "));
  expect(r.names.get("111111")).toBe("Ali Hassan");
  const byId = resolveTargets({}, ["123456789", "spam"]);
  expect(byId).toMatchObject({ ids: ["123456789"], via: "id", text: "spam" });
  const rep = resolveTargets({ messageReply: { senderID: 987654321 } }, []);
  expect(rep).toMatchObject({ ids: ["987654321"], via: "reply" });
  expect(resolveTargets({}, ["hi"]).ids).toEqual([]);
});

test("kick/ban plans refuse bot, owner, admins, self", () => {
  const k = planKick(["1", "2", "3", "4", "5"], { botID: "1", protectedSet: new Set(["2"]), threadAdmins: ["3"], senderID: "4" });
  expect(k.allowed).toEqual(["5"]);
  expect(k.refused.map((x) => x.reason)).toEqual(["bot", "protected", "admin", "self"]);
  const b = planBan(["1", "2", "9"], { botID: "1", protectedSet: new Set(["2"]), senderID: "8" });
  expect(b.allowed).toEqual(["9"]);
  expect(b.refused.length).toBe(2);
  const pg = paginateBans(Array.from({ length: 25 }, (_, i) => i), 99);
  expect(pg).toMatchObject({ page: 3, pages: 3, total: 25 });
  expect(pg.items.length).toBe(5);
  expect(paginateBans([], 1).pages).toBe(1);
});

test("unsend permission", () => {
  expect(canUnsend({ senderID: "1", requesterID: "1" })).toBe(true);
  expect(canUnsend({ senderID: "1", requesterID: "2" })).toBe(false);
  expect(canUnsend({ senderID: "1", requesterID: "2", role: 1 })).toBe(true);
  expect(canUnsend({ senderID: "1", requesterID: "2", isGroupAdmin: true })).toBe(true);
});

test("tts prefs: concurrent sets are atomic, hostile ids are safe", async () => {
  const ns = new Store(new MemoryBackend()).ns("tts_prefs");
  const prefs = createPrefs(async () => ns);
  await Promise.all(Array.from({ length: 20 }, (_, i) => prefs.set("t1", "u" + i, "v" + i)));
  for (let i = 0; i < 20; i++) expect((await prefs.get("t1", "u" + i)).voice).toBe("v" + i);
  await prefs.set("__proto__", "__proto__", "evil");
  expect(({}).evil).toBeUndefined();
  await prefs.reset("t1", "u0");
  expect((await prefs.get("t1", "u0")).source).toBe("default");
});
