// اختبار دخاني لخادم الويب — يعمل تحت Bun فقط: bun tests/webserver_smoke.test.mjs
// يتحقق من: /health و /ready (بادرة التشغيل الأولية) وتسجيل دخول لوحة التحكم بـ PIN ≥ 8 محارف
process.env.PIN = "12345678";
process.env.PORT = "19999";
const base = "http://127.0.0.1:19999";
const fails = [];
const ok = (name, cond) => { if (cond) console.log("✅", name); else { console.error("❌", name); fails.push(name); } };
try {
  const { startWebServer } = await import("../src/web/webServer.js");
  await startWebServer();
  // 1) /health يبقى فحص عملية فقط
  const h = await fetch(`${base}/health`);
  const hj = await h.json().catch(() => ({}));
  ok("/health → 200 {status:\"ok\"}", h.status === 200 && hj.status === "ok");
  // 2) /ready: بدون بوت متصل + ضمن أول 90 ثانية → 200 مع grace:true
  const r = await fetch(`${base}/ready`);
  const rj = await r.json().catch(() => ({}));
  ok("/ready → 200 مع grace:true", r.status === 200 && rj.ok === true && rj.grace === true);
  ok("/ready → state=NO_BOT (لا يوجد بوت)", rj.state === "NO_BOT");
  // 3) تسجيل دخول بـ PIN صحيح (8 محارف)
  const lg = await fetch(`${base}/api/dashboard/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "12345678" }) });
  const lgj = await lg.json().catch(() => ({}));
  ok("login بـ PIN صحيح → 200 authenticated:true", lg.status === 200 && lgj.authenticated === true);
  // 4) تسجيل دخول بـ PIN من 4 أرقام → يُرفض (الحد الأدنى 8)
  const bad = await fetch(`${base}/api/dashboard/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "1234" }) });
  ok("login بـ PIN من 4 أرقام → 401", bad.status === 401);
  // 5) حالة الجلسة بدون كوكيز → غير مُصادق
  const ses = await fetch(`${base}/api/dashboard/session`);
  const sesj = await ses.json().catch(() => ({}));
  ok("session → 200 authenticated:false", ses.status === 200 && sesj.authenticated === false);
} catch (e) {
  console.error("❌ استثناء غير متوقع:", e?.stack || e?.message || e);
  fails.push("exception");
} finally {
  try { global.bunServer?.stop(true); } catch (_) {}
}
if (fails.length) {
  console.error(`🔥 فشل ${fails.length} من الاختبارات:`, fails);
  process.exit(1);
}
console.log("✅ نجحت جميع اختبارات الدخان");
process.exit(0);
