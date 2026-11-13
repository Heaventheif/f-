import { test, expect, beforeAll } from "bun:test";
process.env.APPSTATE_SECRET = "x".repeat(40);
const { MqttConnectionManager, classifyMqttError } = await import("../src/fca/MqttConnectionManager.js");
const P = await import("../src/fca/appStatePersist.js");
const { redactText } = await import("../src/fca/runtimeEnv.js");
const { classifyUncaught } = await import("../src/app/processGuards.js");
const { superviseLogin, backoffDelay } = await import("../src/app/supervisor.js");
const { evaluateHealth, computeStateAge } = await import("../src/core/monitor.js");
const { cookieFingerprint } = await import("../src/fca/session-extender.js");
const { createUserData } = await import("../src/app/userData.js");
const crypto = await import("node:crypto");

class Clock {
  constructor() { this.t = 1000; this.timers = []; this.id = 0; }
  now = () => this.t;
  setTimeout = (fn, ms) => { const h = { id: ++this.id, at: this.t + ms, fn }; this.timers.push(h); return h; };
  clearTimeout = (h) => { this.timers = this.timers.filter((x) => x !== h); };
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
}
function fakeApi() {
  const api = { listens: 0, cb: null, client: { connected: true }, _mqttClient: null };
  api._mqttClient = api.client;
  api.listenMqtt = (cb) => { api.listens++; api.cb = cb; return { stopListening() {} }; };
  return api;
}
const mk = (api, clock, extra = {}) =>
  new MqttConnectionManager(api, { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, random: () => 0, ...extra });

test("classifyMqttError matches standalone codes only", () => {
  expect(classifyMqttError(new Error("HTTP 429"))).toBe("RATE_LIMITED");
  expect(classifyMqttError(new Error("mid 14290012345"))).toBe("UNKNOWN");
  expect(classifyMqttError(new Error("login_blocked"))).toBe("AUTH_FAILED");
  expect(classifyMqttError(new Error("ECONNRESET"))).toBe("TRANSIENT");
});

test("pings do not hide a stale connection; inbound events do", async () => {
  const clock = new Clock(), api = fakeApi();
  const m = mk(api, clock).start();
  await clock.advance(0);
  expect(api.listens).toBe(1);
  api.cb(null, { type: "message" });
  expect(m.health().state).toBe("CONNECTED");
  // pings run every 2 min but must not count as activity
  await clock.advance(16 * 6e4);
  expect(m.metrics().lastPingAt).not.toBeNull();
  expect(api.listens).toBeGreaterThanOrEqual(2); // stale -> reconnected
  await m.stop();
});

test("handler errors are not connection errors", async () => {
  const clock = new Clock(), api = fakeApi();
  const m = mk(api, clock, { onEvent: () => { throw new Error("boom"); } }).start();
  await clock.advance(0);
  api.cb(null, { type: "message" });
  const h = m.health();
  expect(h.consecutiveErrors).toBe(0);
  expect(h.handlerErrors).toBe(1);
  expect(h.state).toBe("CONNECTED");
  await m.stop();
});

test("auth failure blocks, then retries once; stop clears the timer", async () => {
  const clock = new Clock(), api = fakeApi();
  const m = mk(api, clock, { authBlockCooldownMs: 1000 * 60 }).start();
  await clock.advance(0);
  let authEvents = 0; m.on("auth_failed", () => authEvents++);
  api.cb(new Error("login_blocked"));
  await clock.advance(10);
  expect(authEvents).toBe(1);
  expect(m.health().state).toBe("AUTH_FAILED");
  const before = api.listens;
  await clock.advance(61_000);
  expect(api.listens).toBe(before + 1);
  api.cb(new Error("login_blocked"));
  await clock.advance(10);
  await m.stop();
  expect(clock.timers.length).toBe(0);
});

test("watchdog reconnects when the socket dies", async () => {
  const clock = new Clock(), api = fakeApi();
  const m = mk(api, clock).start();
  await clock.advance(0);
  api.cb(null, { type: "x" });
  await clock.advance(3 * 6e4);
  api.client.connected = false;
  await clock.advance(5 * 6e4);
  expect(api.listens).toBeGreaterThanOrEqual(2);
  await m.stop();
});

const ck = (name, value, extra = {}) => ({ key: name, value, domain: ".facebook.com", path: "/", ...extra });
test("merge keys on name+domain+path and keeps expires", () => {
  const merged = P.mergeAppStates(
    [ck("xs", "old", { expires: 123 }), ck("xs", "other", { domain: ".messenger.com" })],
    [ck("xs", "new", { expires: undefined })],
  );
  expect(merged.length).toBe(2);
  const fb = merged.find((c) => c.domain === ".facebook.com");
  expect(fb.value).toBe("new");
  expect(fb.expires).toBe(123);
});

test("encrypt/decrypt roundtrip (v2) and legacy v1 payload", () => {
  const obj = [ck("c_user", "1"), ck("xs", "s")];
  const enc = P._crypto.encrypt(obj);
  expect(enc.v).toBe(2);
  expect(P._crypto.decrypt(enc)).toEqual(obj);
  const key = crypto.createHash("sha256").update(process.env.APPSTATE_SECRET, "utf8").digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  const legacy = { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
  expect(P._crypto.decrypt(legacy)).toEqual(obj);
  expect(P._crypto.decrypt({ ...enc, tag: Buffer.alloc(16).toString("base64") })).toBeNull();
});

test("env hash is an HMAC; legacy sha256 rows count as unchanged", () => {
  const raw = '[{"key":"c_user","value":"1"}]';
  const h = P.computeEnvHash(raw);
  expect(h).not.toBe(P.legacyEnvHash(raw));
  const state = [ck("c_user", "1"), ck("xs", "a")];
  const r = P.chooseStartupState({
    envState: state, dbState: state, dbEnvHash: P.legacyEnvHash(raw),
    bootEnvHash: h, legacyBootEnvHash: P.legacyEnvHash(raw),
  });
  expect(r.reason).toBe("env-unchanged");
  const r2 = P.chooseStartupState({ envState: state, dbState: state, dbEnvHash: "zzz", bootEnvHash: h, legacyBootEnvHash: "q" });
  expect(r2.reason).toBe("env-changed");
});

test("redactText keeps ids/timestamps, masks secrets", () => {
  expect(redactText("mid 1234567890123456 at 1731000000000")).toBe("mid 1234567890123456 at 1731000000000");
  expect(redactText("xs=abc123; Bearer tok.en")).not.toContain("abc123");
  expect(redactText('{"token":"sekret"}')).not.toContain("sekret");
});

test("process guards: only socket write/read resets are ignorable", () => {
  expect(classifyUncaught(Object.assign(new Error("x"), { code: "EPIPE", syscall: "write" }))).toBe("ignore");
  expect(classifyUncaught(Object.assign(new Error("ECONNRESET in message"), {}))).toBe("fatal");
  expect(classifyUncaught(new TypeError("x"))).toBe("fatal");
});

test("supervisor: retries with backoff then succeeds; times out; gives up", async () => {
  const sleeps = []; let n = 0;
  const v = await superviseLogin({ attempt: async () => { if (++n < 3) throw new Error("x"); return "ok"; }, sleep: async (ms) => sleeps.push(ms), timeoutMs: 1000 });
  expect(v).toBe("ok");
  expect(sleeps.length).toBe(2);
  expect(sleeps[1]).toBeGreaterThan(sleeps[0] - 1);
  await expect(superviseLogin({ attempt: () => new Promise(() => {}), maxAttempts: 1, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  let calls = 0;
  await expect(superviseLogin({ attempt: async () => { calls++; throw new Error("f"); }, maxAttempts: 3, sleep: async () => {} })).rejects.toThrow("f");
  expect(calls).toBe(3);
  expect(backoffDelay(30, { random: () => 1 })).toBeLessThanOrEqual(300000);
});

test("monitor: no stale alert when state was checked recently; CONNECTING silent", () => {
  const now = 10 * 36e5;
  expect(computeStateAge({ now, lastSuccessfulCheckAt: now - 1000, lastSaveAt: 0, fileMtimeMs: now - 9 * 36e5 })).toBe(1000);
  expect(evaluateHealth({ label: "B", h: { state: "CONNECTING", ok: false } })).toEqual([]);
  expect(evaluateHealth({ label: "B", h: { state: "DEGRADED", ok: false } }).length).toBe(1);
  expect(evaluateHealth({ label: "B", h: { state: "CONNECTED", ok: true }, stateAgeMs: 4 * 36e5 }).map((a) => a.key)).toEqual(["state_B"]);
});

test("cookie fingerprint ignores order, detects change", () => {
  const a = [ck("a", "1"), ck("b", "2")];
  expect(cookieFingerprint(a)).toBe(cookieFingerprint([...a].reverse()));
  expect(cookieFingerprint(a)).not.toBe(cookieFingerprint([ck("a", "1"), ck("b", "3")]));
});

test("userData flushes only dirty entries", async () => {
  const usersData = new Map(), db = new Map();
  const ns = { get: async (k) => db.get(k), set: async (k, v) => db.set(k, v) };
  const ud = createUserData({ usersData, getNs: async () => ns });
  usersData.set("1", { a: 1, _dirty: true, _lastSeen: 1 });
  usersData.set("2", { a: 2, _dirty: false });
  expect(await ud.flushUsersData()).toBe(1);
  expect(db.get("1")).toEqual({ a: 1 });
  expect(usersData.get("1")._dirty).toBe(false);
  expect(await ud.getUserData("9")).toEqual({});
});
