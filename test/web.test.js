import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, MemoryBackend } from "../src/state/kv.js";
import { createWebApp } from "../src/web/webServer.js";
import { Backoff, makeSafeEqual } from "../src/web/auth.js";
import { clientIp, checkOrigin } from "../src/web/http.js";
import { createBroadcastService, settle, isAmbiguous } from "../src/web/broadcastService.js";
import { createRequestService } from "../src/web/requestService.js";

const H = "http://x.test";
const PW = "correct horse battery";
const groupsFixture = [
  { threadID: "1", name: "A", isGroup: true, participants: [1, 2, 3] },
  { threadID: "2", name: "B", threadType: 2 },
  { threadID: "3", name: "dm", isGroup: false, participants: [1, 2] },
];
function mkApp(over = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, adv: (ms) => (t += ms) };
  const store = new Store(new MemoryBackend());
  const sent = [];
  const bot = {
    getThreadList: (l, ts, f, cb) => cb(null, groupsFixture),
    handleMessageRequest: (id, acc, cb) => cb(null),
    __mqttHealth: { ok: true, state: "OPEN" },
    ...over.bot,
  };
  const app = createWebApp({
    bot, store, now: clock.now, log: { warn() {}, error() {}, info() {} },
    env: { DASHBOARD_PASSWORD: PW, TRUSTED_PROXY_HOPS: "1", BROADCAST_DATA_DIR: mkdtempSync(join(tmpdir(), "bc-")), BROADCAST_MIN_DELAY_MS: "1000", BROADCAST_MAX_DELAY_MS: "1000", ...over.env },
    health: over.health || (() => ({ mqtt: true, state: "OPEN", lastEventAt: null, uptime: 1 })),
    broadcastOptions: { sleep: async () => {}, random: () => 0, sendText: (a, b, th, cb) => { sent.push(th); cb(null, { messageID: "m" + th }); }, isOff: () => false, ...over.bc },
    requestOptions: { sleep: async () => {}, random: () => 0 },
  });
  return { app, clock, sent, store };
}
const req = (path, o = {}) => new Request(H + path, { headers: { origin: H, ...o.headers }, ...o, });
const json = (path, body, headers = {}) => req(path, { method: "POST", body: JSON.stringify(body), headers: { origin: H, "content-type": "application/json", "x-forwarded-for": "9.9.9.9", ...headers } });
async function login(app, pw = PW, ip = "9.9.9.9") {
  const r = await app.handle(json("/api/dashboard/login", { password: pw }, { "x-forwarded-for": ip }));
  return { r, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
}

test("auth: per-IP backoff does not lock other IPs; success clears", async () => {
  const { app, clock } = mkApp();
  for (let i = 0; i < 4; i++) expect((await login(app, "wrong-password-x")).r.status).toBe(401);
  const blocked = await login(app, PW);
  expect(blocked.r.status).toBe(429);
  expect(blocked.r.headers.get("retry-after")).toBeTruthy();
  clock.adv(120_000);
  const ok = await login(app, PW);
  expect(ok.r.status).toBe(200);
  expect(ok.cookie).toContain("sunkenbot_dashboard=");
});
test("Backoff grows exponentially and caps", () => {
  let t = 0;
  const b = new Backoff({ now: () => t, base: 1000, max: 8000, free: 1 });
  const w = [];
  for (let i = 0; i < 6; i++) { b.fail("k"); w.push(b.retryAfterMs("k")); }
  expect(w).toEqual([0, 1000, 2000, 4000, 8000, 8000]);
  b.reset("k"); expect(b.retryAfterMs("k")).toBe(0);
});
test("safeEqual is length-agnostic and rejects empty", () => {
  const eq = makeSafeEqual();
  expect(eq("abc", "abc")).toBe(true);
  expect(eq("abc", "abcd")).toBe(false);
  expect(eq("", "")).toBe(false);
});
test("sessions: idle 2h and absolute 12h expiry", async () => {
  const { app, clock } = mkApp();
  const { cookie } = await login(app);
  const probe = async () => (await (await app.handle(req("/api/dashboard/session", { headers: { cookie } }))).json()).data.authenticated;
  expect(await probe()).toBe(true);
  clock.adv(2 * 3600_000 + 1000);
  expect(await probe()).toBe(false);
  const b = await login(app);
  for (let i = 0; i < 13; i++) { clock.adv(3600_000); await app.handle(req("/api/dashboard/session", { headers: { cookie: b.cookie } })); }
  expect(await (await app.handle(req("/api/dashboard/session", { headers: { cookie: b.cookie } }))).json().then((j) => j.data.authenticated)).toBe(false);
});
test("clientIp honors trusted hops", () => {
  const r = new Request(H, { headers: { "x-forwarded-for": "6.6.6.6, 1.1.1.1" } });
  expect(clientIp(r, 1, "10.0.0.1")).toBe("1.1.1.1");
  expect(clientIp(r, 2, "10.0.0.1")).toBe("6.6.6.6");
  expect(clientIp(r, 0, "10.0.0.1")).toBe("10.0.0.1");
});
test("CSRF: origin / sec-fetch-site enforced on login, logout and API; malformed origin safe", async () => {
  const { app } = mkApp();
  const post = (path, headers) => app.handle(new Request(H + path, { method: "POST", body: "{}", headers: { "content-type": "application/json", ...headers } }));
  expect((await post("/api/dashboard/login", { origin: "http://evil.test" })).status).toBe(403);
  expect((await post("/api/dashboard/logout", { origin: "not a url" })).status).toBe(403);
  expect((await post("/api/dashboard/login", {})).status).toBe(403);
  expect((await post("/api/dashboard/logout", { "sec-fetch-site": "cross-site", origin: H })).status).toBe(403);
  expect(checkOrigin(new Request(H, { headers: { "sec-fetch-site": "same-origin" } }), new URL(H))).toBe(true);
});
test("envelope, status codes, 401, 404, 405, HEAD", async () => {
  const { app } = mkApp();
  let r = await app.handle(req("/api/requests"));
  expect(r.status).toBe(401);
  const j = await r.json();
  expect(j.ok).toBe(false); expect(j.error.code).toBe("unauthorized");
  expect((await app.handle(req("/api/nope"))).status).toBe(404);
  expect((await app.handle(new Request(H + "/api/dashboard/session", { method: "DELETE", headers: { origin: H } }))).status).toBe(405);
  r = await app.handle(new Request(H + "/health", { method: "HEAD" }));
  expect(r.status).toBe(200); expect(await r.text()).toBe("");
});
test("malformed JSON 400, wrong content-type 415, body limit 413", async () => {
  const { app } = mkApp();
  const h = { origin: H, "content-type": "application/json" };
  expect((await app.handle(new Request(H + "/api/dashboard/login", { method: "POST", body: "{bad", headers: h }))).status).toBe(400);
  expect((await app.handle(new Request(H + "/api/dashboard/login", { method: "POST", body: "{}", headers: { origin: H, "content-type": "text/plain" } }))).status).toBe(415);
  const big = JSON.stringify({ password: "x".repeat(5000) });
  expect((await app.handle(new Request(H + "/api/dashboard/login", { method: "POST", body: big, headers: h }))).status).toBe(413);
});
test("security headers and HTML escaping of botName", async () => {
  const { app } = mkApp();
  const prev = global.config; global.config = { botName: "<script>x</script>" };
  try {
    const r = await app.handle(req("/"));
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await r.text()).not.toContain("<script>x");
  } finally { global.config = prev; }
  const api = await app.handle(req("/api/requests"));
  expect(api.headers.get("cache-control")).toContain("no-store");
});
test("/health: 200 when connected, 503 when not", async () => {
  expect((await mkApp().app.handle(req("/health"))).status).toBe(200);
  const { app } = mkApp({ health: () => ({ mqtt: false, state: "NO_BOT", lastEventAt: null, uptime: 1 }) });
  const r = await app.handle(req("/health"));
  expect(r.status).toBe(503);
  expect((await r.json()).error.code).toBe("bot_offline");
});
test("static assets served; unknown static 404", async () => {
  const { app } = mkApp();
  expect((await app.handle(req("/static/client.js"))).status).toBe(200);
  expect((await app.handle(req("/static/secret.js"))).status).toBe(404);
});

// ---- requests service ----
function fakeThreadBot(pendingIds, { failIds = [] } = {}) {
  const acted = [];
  return {
    acted,
    getThreadList: (l, ts, f, cb) => cb(null, f[0] === "PENDING" ? pendingIds.map((id) => ({ threadID: id, name: "n" + id })) : []),
    handleMessageRequest: (id, acc, cb) => { acted.push(id); failIds.includes(id) ? cb(new Error("boom")) : cb(null); },
  };
}
test("bulk: per-item results, each id once, unknown ids rejected, cap 25", async () => {
  const bot = fakeThreadBot(["10001", "10002", "10003"], { failIds: ["10002"] });
  const svc = createRequestService({ getBot: () => bot, sleep: async () => {}, random: () => 0 });
  const r = await svc.bulk({ kind: "messages", action: "accept", ids: ["10001", "10002", "10003", "99999"] });
  expect(r.ok).toBe(true);
  expect(r.data.succeeded).toBe(2); expect(r.data.failed).toBe(2);
  expect(r.data.results.find((x) => x.id === "99999").success).toBe(false);
  expect(bot.acted).toEqual(["10001", "10002", "10003"]);
  await expect(svc.bulk({ kind: "messages", action: "accept", ids: Array.from({ length: 26 }, (_, i) => String(10001 + i)) })).rejects.toMatchObject({ code: "invalid_param" });
  const none = await createRequestService({ getBot: () => fakeThreadBot(["10001"], { failIds: ["10001"] }), sleep: async () => {}, random: () => 0 }).bulk({ kind: "messages", action: "reject", ids: ["10001"] });
  expect(none.ok).toBe(false);
});
test("request routes: bulk all-fail -> 502 with results; default kind messages; bad limit 400", async () => {
  const { app } = mkApp({ bot: { getThreadList: (l, ts, f, cb) => cb(null, [{ threadID: "10001" }]), handleMessageRequest: (id, a, cb) => cb(new Error("x")) } });
  const { cookie } = await login(app);
  const r = await app.handle(json("/api/requests/bulk", { kind: "messages", action: "accept", ids: ["10001"] }, { cookie }));
  expect(r.status).toBe(502);
  expect((await r.json()).data.results.length).toBe(1);
  const l = await app.handle(req("/api/requests?folder=PENDING", { headers: { cookie } }));
  expect(l.status).toBe(200);
  expect(Object.keys((await l.json()).data)).toContain("messages");
  expect((await app.handle(req("/api/requests?limit=abc", { headers: { cookie } }))).status).toBe(400);
});

// ---- broadcast ----
const mkBc = (over = {}) => {
  const { clock, sent, store } = mkApp();
  const svc = createBroadcastService({
    store, now: clock.now, getBot: () => ({ getThreadList: (l, ts, f, cb) => cb(null, groupsFixture) }),
    env: { BROADCAST_DATA_DIR: mkdtempSync(join(tmpdir(), "bc-")), BROADCAST_MIN_DELAY_MS: "1000", BROADCAST_MAX_DELAY_MS: "1000", ...over.env },
    sleep: async () => {}, random: () => 0, isOff: () => false, log: { warn() {}, error() {} },
    sendText: (a, b, th, cb) => { sent.push(th); over.send ? over.send(th, cb) : cb(null, { messageID: "m" + th }); },
  });
  return { svc, clock, sent };
};
test("group detection includes threadType 2 and excludes DMs", async () => {
  const { svc } = mkBc();
  expect((await svc.listGroups()).map((g) => g.id)).toEqual(["1", "2"]);
});
test("campaign: create, idempotency, pacing, completion", async () => {
  const { svc, clock, sent } = mkBc();
  const a = await svc.create({ text: "hi", targetIds: ["1", "2"], idempotencyKey: "key-12345678" });
  const b = await svc.create({ text: "hi", targetIds: ["1", "2"], idempotencyKey: "key-12345678" });
  expect(b.replay).toBe(true); expect(b.campaign.id).toBe(a.campaign.id);
  expect(await svc.tick()).toBe("sent");
  expect(await svc.tick()).toBe("wait");
  clock.adv(1500);
  expect(await svc.tick()).toBe("sent");
  expect(sent).toEqual(["1", "2"]);
  expect((await svc.get(a.campaign.id)).status).toBe("completed");
});
test("campaign: unknown group rejected, empty rejected", async () => {
  const { svc } = mkBc();
  await expect(svc.create({ text: "x", targetIds: ["nope"] })).rejects.toMatchObject({ code: "conflict" });
  await expect(svc.create({ text: "", targetIds: ["1"] })).rejects.toMatchObject({ code: "bad_request" });
});
test("hourly cap persisted and queued with reason", async () => {
  const { svc, clock } = mkBc({ env: { BROADCAST_MAX_PER_HOUR: "1" } });
  const a = await svc.create({ text: "x", targetIds: ["1", "2"] });
  expect(await svc.tick()).toBe("sent");
  clock.adv(2000);
  expect(await svc.tick()).toBe("capped");
  expect((await svc.get(a.campaign.id)).waitReason).toBe("hourly_cap");
  clock.adv(3600_000);
  expect(await svc.tick()).toBe("sent");
});
test("timeout is ambiguous -> unknown; resolve/skip only for unknown; retry keeps manual pause", async () => {
  const { svc, clock } = mkBc({ send: (th, cb) => cb(Object.assign(new Error("t"), { code: "timeout" })) });
  const a = await svc.create({ text: "x", targetIds: ["1"] });
  expect(await svc.tick()).toBe("unknown");
  let c = await svc.get(a.campaign.id);
  expect(c.status).toBe("review");
  await expect(svc.controlTarget(c.id, "zzz", "resolve")).rejects.toMatchObject({ code: "not_found" });
  c = await svc.controlTarget(c.id, "1", "resolve");
  expect(c.status).toBe("completed");
  await expect(svc.controlTarget(c.id, "1", "skip")).rejects.toMatchObject({ code: "conflict" });
});
test("retry does not unpause a manual pause; cancel is terminal", async () => {
  const { svc } = mkBc({ send: (th, cb) => cb(new Error("hard fail")) });
  const a = await svc.create({ text: "x", targetIds: ["1", "2"] });
  await svc.tick();
  await svc.control(a.campaign.id, "pause");
  const c = await svc.control(a.campaign.id, "retry");
  expect(c.status).toBe("paused");
  const d = await svc.control(a.campaign.id, "cancel");
  expect(d.status).toBe("cancelled");
  await expect(svc.control(a.campaign.id, "cancel")).rejects.toMatchObject({ code: "conflict" });
});
test("settle() and isAmbiguous() are pure", () => {
  const c = { status: "running", targets: [{ status: "sent" }, { status: "failed" }] };
  settle(c, "t"); expect(c.status).toBe("completed_with_errors");
  const p = { status: "paused", targets: [{ status: "sent" }] };
  settle(p, "t"); expect(p.status).toBe("paused");
  expect(isAmbiguous({ code: "timeout" })).toBe(true);
  expect(isAmbiguous(new Error("plain"))).toBe(false);
});
