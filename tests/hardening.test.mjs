// tests/hardening.test.mjs — retry/circuit breaker, security helpers, atomic file. بدون شبكة.
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { withRetry, classifyError, ErrorClass, CircuitBreaker, backoffDelay } from "../src/utils/retry.js";
import { constantTimeEqual, makeLoginLockout, safeMerge, safeJsonParse, resolveInside, withSecurityHeaders } from "../src/utils/security.js";
import { atomicWriteJson, readJsonWithRecovery } from "../src/utils/atomicFile.js";

const tests = []; const test = (n, f) => tests.push([n, f]);
const noSleep = async () => {};

test("classifyError", () => {
  assert.equal(classifyError({ status: 429 }), ErrorClass.RATE_LIMITED);
  assert.equal(classifyError({ code: "ECONNRESET" }), ErrorClass.NETWORK);
  assert.equal(classifyError({ status: 401 }), ErrorClass.AUTH_FAILED);
  assert.equal(classifyError({ name: "SendStopped" }), ErrorClass.SEND_STOPPED);
});
test("retry: ينجح بعد فشل شبكي", async () => {
  let n = 0;
  const r = await withRetry(async () => { if (++n < 3) { const e = new Error("x"); e.code = "ETIMEDOUT"; throw e; } return "ok"; },
    { service: "t1", sleep: noSleep, breaker: new CircuitBreaker({ threshold: 99 }) });
  assert.equal(r, "ok"); assert.equal(n, 3);
});
test("retry: لا يعيد المحاولة عند AUTH_FAILED", async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw Object.assign(new Error("a"), { status: 401 }); }, { sleep: noSleep, breaker: new CircuitBreaker() }));
  assert.equal(n, 1);
});
test("circuit breaker يفتح ثم نصف مفتوح", () => {
  let t = 0; const b = new CircuitBreaker({ threshold: 2, cooldownMs: 100, now: () => t });
  b.failure(); b.failure(); assert.equal(b.canPass(), false);
  t = 150; assert.equal(b.canPass(), true); assert.equal(b.state, "HALF_OPEN");
  b.success(); assert.equal(b.state, "CLOSED");
});
test("backoff ضمن الحدود", () => {
  for (let a = 0; a < 10; a++) { const d = backoffDelay(a, 500, 15000); assert.ok(d >= 250 && d <= 15000); }
});
test("constantTimeEqual", () => {
  assert.equal(constantTimeEqual("abcdefgh", "abcdefgh"), true);
  assert.equal(constantTimeEqual("abcdefgh", "abcdefg"), false);
  assert.equal(constantTimeEqual("a", 5), false);
});
test("login lockout تصاعدي", () => {
  let t = 0; const l = makeLoginLockout({ free: 2, baseMs: 1000, now: () => t });
  l.fail("ip"); l.fail("ip"); assert.equal(l.check("ip"), 0);
  l.fail("ip"); assert.equal(l.check("ip"), 1000);
  t = 1001; assert.equal(l.check("ip"), 0); l.fail("ip"); assert.equal(l.check("ip"), 2000);
  l.ok("ip"); assert.equal(l.check("ip"), 0);
});
test("prototype pollution", () => {
  const o = safeMerge({}, JSON.parse('{"__proto__":{"polluted":1},"a":{"constructor":{"x":1},"b":2}}'));
  assert.equal({}.polluted, undefined); assert.equal(o.a.b, 2); assert.equal(Object.hasOwn(o.a, "constructor"), false);
  assert.equal(safeJsonParse('{"__proto__":{"p":1},"k":1}').k, 1); assert.equal({}.p, undefined);
  assert.equal(safeJsonParse("{bad"), null);
});
test("path traversal", () => {
  assert.equal(resolveInside("/tmp/root", "../etc/passwd"), null);
  assert.equal(resolveInside("/tmp/root", "a.txt"), path.resolve("/tmp/root/a.txt"));
});
test("security headers", () => {
  const r = withSecurityHeaders(new Response("x"));
  assert.equal(r.headers.get("X-Frame-Options"), "DENY");
  assert.match(r.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
});
test("atomic write + استعادة من .bak", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "atm-")), "s.json");
  atomicWriteJson(f, { v: 1 }); atomicWriteJson(f, { v: 2 });
  assert.deepEqual(readJsonWithRecovery(f), { v: 2 });
  fs.writeFileSync(f, "garbage{{"); assert.deepEqual(readJsonWithRecovery(f), { v: 1 });
});

let fail = 0;
for (const [n, f] of tests) { try { await f(); console.log("✓", n); } catch (e) { fail++; console.error("✗", n, e.message); } }
if (fail) { console.error(`${fail} failed`); process.exit(1); }
console.log(`all ${tests.length} passed`);
