/**
 * اختبار دخان لترحيل fca-nx + الطبقة البشرية
 * تشغيل: bun scripts/smoke-test.mjs
 */
process.env.TZ = "Europe/Berlin";
process.env.NODE_ENV = "test";
process.env.STATE_DIR = "/tmp/sunkenbot-test";

const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok, extra });
  console.log(`${ok ? "✅" : "❌"} ${name}${extra ? " — " + extra : ""}`);
};

// 1) المكتبة تُستورد وتصدّر الواجهات المطلوبة
const fcaNx = await import("fca-nx").then(m => m.default?.default ?? m.default ?? m);
const named = await import("fca-nx");
check("fca-nx: login متاح", typeof (fcaNx.login ?? named.login) === "function");
check("fca-nx: attachThreadInfoRealtimeSync متاح", typeof (fcaNx.attachThreadInfoRealtimeSync ?? named.attachThreadInfoRealtimeSync) === "function");

// 2) وحدات البوت المعدّلة تُستورد بلا أخطاء
for (const m of [
  "../src/fca/humanLayer.js",
  "../src/fca/fcaCompat.js",
  "../src/fca/MqttConnectionManager.js",
  "../src/fca/session-extender.js",
  "../src/fca/bot-init.js",
  "../src/fca/Client.js",
  "../src/utils/send.js",
  "../src/events/onMessage.js",
  "../src/web/requestService.js",
]) {
  try { await import(m); check(`import ${m}`, true); }
  catch (e) { check(`import ${m}`, false, e.message); }
}

// 3) سلوك الطبقة البشرية بمحاكاة API مزيف
const { humanLayerEnabled, typingActive, readDelayActive, humanPreSendPause, markReadLikeHuman, initHumanLayer, humanPostSend } = await import("../src/fca/humanLayer.js");
check("humanLayerEnabled الافتراضي", humanLayerEnabled() === true);

const calls = { typing: 0, typingStop: 0, read: 0 };
const fakeApi = {
  getCurrentUserID: () => "100000",
  sendTypingIndicator: (tid, isTyping, opts, cb) => {
    calls[isTyping ? "typing" : "typingStop"]++;
    if (typeof opts === "function") opts(null, true);
    else if (typeof cb === "function") cb(null, true);
    return Promise.resolve(true);
  },
  markAsRead: (tid, read, cb) => { calls.read++; if (cb) cb(null); return Promise.resolve(true); },
  httpGet: (url) => Promise.resolve("<html>ok</html>"),
  refreshFbDtsg: () => Promise.resolve(true),
};

// إرسال نصي: يجب أن يظهر مؤشر الكتابة وينتظر مدة بشرية ثم يوقف المؤشر
const t0 = Date.now();
const handle = await humanPreSendPause(fakeApi, "12345", "مرحبا، هذا رد تجريبي من البوت");
const elapsed = Date.now() - t0;
check("humanPreSendPause: يعيد handle", !!handle);
check("humanPreSendPause: أظهر مؤشر الكتابة", calls.typing >= 1, `typing=${calls.typing}`);
check("humanPreSendPause: انتظر مدة بشرية", elapsed >= 800 && elapsed <= 12000, `${elapsed}ms`);
humanPostSend(handle);
check("humanPostSend: أوقف مؤشر الكتابة", calls.typingStop >= 1, `stop=${calls.typingStop}`);

// إرسال وسائط (بلا نص): لا يُشترط مؤشر كتابة لكن الإيقاع يعمل
calls.typing = 0;
const t1 = Date.now();
await humanPreSendPause(fakeApi, "67890", { attachment: "stream" });
const elapsed2 = Date.now() - t1;
check("humanPreSendPause (وسائط): لا typing", calls.typing === 0, `typing=${calls.typing}`);
check("humanPreSendPause (وسائط): سريع", elapsed2 < 8000, `${elapsed2}ms`);

// قراءة متأخرة: يجب أن تُجدول markAsRead وليست فورية
calls.read = 0;
markReadLikeHuman(fakeApi, { type: "message", threadID: "111", body: "رسالة وصلت الآن" });
check("markReadLikeHuman: ليست فورية", calls.read === 0);
await new Promise(r => setTimeout(r, 7600));
check("markReadLikeHuman: نُفذت بعد تأخير", calls.read === 1, `read=${calls.read}`);

// حدث غير رسالة (log): لا قراءة
markReadLikeHuman(fakeApi, { type: "event", threadID: "111" });
await new Promise(r => setTimeout(r, 6000));
check("markReadLikeHuman: يتجاهل الأحداث غير الرسائل", calls.read === 1);

// 4) initHumanLayer يعمل ولا يكسر (المؤقتات unref)
const st = initHumanLayer(fakeApi, { label: "Bot-1", botIndex: 1 });
check("initHumanLayer: نشط", !!st && !!fakeApi.__humanLayer);

// 5) fcaCompat: adaptApi على api مزيف
const { adaptApi } = await import("../src/fca/fcaCompat.js");
const rawApi = {
  refreshFb_dtsg: (cb) => { if (cb) cb(null); return Promise.resolve(); },
  unsendMessage: (id, cb) => { if (cb) cb(null); return Promise.resolve(true); },
  isMqttConnected: () => true,
};
const adapted = adaptApi(rawApi);
check("adaptApi: refreshFbDtsg أصبح متاحاً", typeof adapted.refreshFbDtsg === "function");
check("adaptApi: unsendMessage مغلف", typeof adapted.unsendMessage === "function");
adapted.unsendMessage("m1", () => {});
check("adaptApi: idempotent", adaptApi(adapted) === adapted);

// 6) MqttConnectionManager مع fca-nx: _socketAlive عبر isMqttConnected
const { MqttConnectionManager } = await import("../src/fca/MqttConnectionManager.js");
const api2 = { isMqttConnected: () => true, listenMqtt: (cb) => ({ stopListeningAsync: async () => {} }) };
const mgr = new MqttConnectionManager(api2, { label: "TEST" });
check("MqttConnectionManager._socketAlive عبر isMqttConnected", mgr._socketAlive() === true);
const api3 = { listenMqtt: (cb) => ({ stopListeningAsync: async () => {} }) }; // بلا isMqttConnected ولا ctx
const mgr2 = new MqttConnectionManager(api3, { label: "TEST2" });
check("MqttConnectionManager._socketAlive=false عند غياب كل المصادر", mgr2._socketAlive() === false);
mgr.stop(); mgr2.stop();

// 7) إعدادات Client.js: online=false و autoMarkRead حسب الطبقة البشرية
const clientSrc = await Bun.file("./src/fca/Client.js").text();
check("Client.js: online:false", /online:false/.test(clientSrc));
check("Client.js: لا autoListen", !/autoListen/.test(clientSrc));
check("Client.js: يتطلب fca-nx", /require\("fca-nx"\)/.test(clientSrc));
check("bot-init.js: يتطلب fca-nx", /require\("fca-nx"\)/.test(await Bun.file("./src/fca/bot-init.js").text()));

// 8) لا بقايا للاسم القديم في المصدر
const proc = Bun.spawnSync(["grep", "-rl", "fcanew-r3nz75", "src/", "main.js", "package.json", "fca-config.json"]);
const leftovers = proc.stdout.toString().trim();
check("لا بقايا fcanew-r3nz75 في المصدر", leftovers === "", leftovers);

const failed = results.filter(r => !r.ok);
console.log(`\n${failed.length === 0 ? "🎉 كل الفحوص ناجحة" : "⚠️ فحوص فاشلة: " + failed.length} (${results.length - failed.length}/${results.length})`);
process.exit(failed.length === 0 ? 0 : 1);
