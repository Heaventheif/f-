// tests/mqtt_stale.test.mjs — اختبار كشف ركود MQTT (الإدخال فقط) — بدون شبكة، بدون إطار عمل
// التشغيل: node tests/mqtt_stale.test.mjs
import assert from "node:assert/strict";
import MqttConnectionManager from "../src/fca/MqttConnectionManager.js";

const passed = [];
const pass = (name) => { passed.push(name); console.log(`PASS: ${name}`); };

// ساعة وهمية: نتحكم بـ Date.now فقط، setTimeout الحقيقي يعمل (لهذا كل مؤقتات المدير ضخمة/غير مهمة)
let NOW = 1_700_000_000_000;
const realNow = Date.now;
Date.now = () => NOW;

let listenerCb = null;          // يلتقط كولباك الإطار الوارد
const reconnectCalls = [];      // تجسس على أسباب إعادة الاتصال

const api = {
  _mqttClient: { connected: true },
  listenMqtt: (cb) => { listenerCb = cb; return { stopListeningAsync: async () => {} }; }
};

const manager = new MqttConnectionManager(api, {
  label: "TEST",
  staleAfterMs: 8 * 60000,
  initialGraceMs: 0,
  watchdogIntervalMs: 3600000, // لن يعمل حقيقيًا — نستدعي _watchdogCheck يدويًا
  pingIntervalMs: 3600000,
  reconnectBaseMs: 1,
  reconnectCapMs: 1,
  cooldownMs: 1,
  stableWindowMs: 0
});

// تجسس: إعادة اتصال "ناجحة" تحدّث وقت الإدخال — تمنع العاصفة وتسمح بالتحقق من العدد
manager._reconnect = async (reason) => {
  reconnectCalls.push(reason);
  manager.state = "CONNECTED";
  manager.lastInboundAt = Date.now();
  manager.connectedSince = Date.now();
  return true;
};

try {
  // (a) البدء: بدون شبكة، _connectOnce يكتمل بعد بعض التِكات
  manager.start();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.ok(manager.state === "CONNECTING" || manager.state === "CONNECTED",
    `state after start = ${manager.state}`);
  assert.equal(reconnectCalls.length, 0, "لا إعادة اتصال عند البدء");
  pass("a) start → الحالة CONNECTING/CONNECTED وبدون إعادة اتصال");

  // (b) إطار وارد واحد يحدّث lastInboundAt فقط عبر _recordEvent
  listenerCb(null, { type: "message" });
  assert.equal(manager.lastInboundAt, NOW, "lastInboundAt تحدّثت مع الإطار الوارد");
  assert.equal(manager.lastEventType, "message");
  pass("b) إطار وارد → lastInboundAt === NOW");

  // (c) 7.5 دقيقة بدون إدخال < 8 دقائق → لا إعادة اتصال
  NOW += 7.5 * 60000;
  await manager._watchdogCheck();
  assert.equal(reconnectCalls.length, 0, "7.5د < staleAfterMs → لا إعادة اتصال");
  pass("c) بعد 7.5 دقيقة ركود → لا إعادة اتصال بعد");

  // (d) تجاوز 8 دقائق والسوكيت حيّ → reconnect("stale") مرة واحدة
  NOW += 60 * 1000;
  await manager._watchdogCheck();
  assert.deepEqual(reconnectCalls, ["stale"], "السبب stale وليس socket_not_alive");
  pass("d) ركود > 8 دقائق مع سوكيت حيّ → reconnect('stale') مرة واحدة");

  // (e) فحص فوري ثانٍ → لا عاصفة (الإدخال انعش عبر إعادة الاتصال الوهمية)
  await manager._watchdogCheck();
  assert.equal(reconnectCalls.length, 1, "لا عاصفة إعادة اتصال");
  pass("e) فحص فوري ثانٍ → لا يزال اتصال واحدًا فقط (لا عاصفة)");

  // (f) إطار وارد يصفّر العدّاد
  NOW += 10 * 60000;
  manager.state = "CONNECTED"; // الوكشاف (الوهمي) أعادها إلى CONNECTED
  listenerCb(null, { type: "message" });
  await manager._watchdogCheck();
  assert.equal(reconnectCalls.length, 1, "الإطار الوارد صفّر الركود");
  pass("f) إطار وارد بعد 10 دقائق يصفّر العدّاد → لا إعادة اتصال");

  // (g) الـ ping وحده لا يمنع الركود (آخر اختبار للخلل الأصلي)
  NOW += 9 * 60000;
  manager.lastPingAt = NOW; // ping نجح للتو
  await manager._watchdogCheck();
  assert.deepEqual(reconnectCalls, ["stale", "stale"],
    "الـ ping لا يدخل في حساب الركود → stale ثانية");
  pass("g) ping ناجح لا يمنع كشف الركود → reconnect('stale') الثانية");

  // (h) AUTH_FAILED لا يعيد الاتصال من الوكشاف أبدًا
  manager.state = "AUTH_FAILED";
  NOW += 30 * 60000;
  await manager._watchdogCheck();
  assert.equal(reconnectCalls.length, 2, "حارس AUTH_FAILED منع إعادة الاتصال");
  pass("h) AUTH_FAILED → الوكشاف لا يعيد الاتصال");

  // (i) health() يعكس ركود الإدخال
  manager.state = "CONNECTED";
  manager.lastInboundAt = NOW;
  const h1 = manager.health();
  assert.equal(h1.ok, true, "health.ok صحيح بعد إدخال حديث");
  assert.equal(typeof h1.lastInboundAt, "string", "health يكشف lastInboundAt بصيغة ISO");
  assert.ok(h1.lastEventAt && h1.lastPingAt, "حقول التشخيص القديمة بقيت");
  NOW += 9 * 60000;
  const h2 = manager.health();
  assert.equal(h2.ok, false, "health.ok خاطئ عند ركود الإدخال");
  assert.ok(h2.staleForMs >= 8 * 60000, `staleForMs=${h2.staleForMs} يجب ≥ ${8 * 60000}`);
  pass("i) health(): ok true→false و staleForMs≥8 دقائق حسب الإدخال فقط");

  console.log(`\n=== ALL ${passed.length} CHECKS PASSED ===`);
} catch (error) {
  console.error(`FAIL: ${error?.message}`);
  if (error?.stack) console.error(error.stack);
  Date.now = realNow;
  process.exit(1);
} finally {
  Date.now = realNow;
  try { manager.watchdogTimer && clearTimeout(manager.watchdogTimer); } catch {}
  try { manager.pingTimer && clearTimeout(manager.pingTimer); } catch {}
  try { await manager.stop(); } catch {}
}
