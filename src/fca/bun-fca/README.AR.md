# bun-fca

محرك موحّد ومقوّى للتعامل مع واجهة ماسنجر غير الرسمية (FCA) على Node.js وBun.
يدعم CJS وESM معاً، باعتماديتين وقت تشغيل فقط (`mqtt` و`ws`)، ويزيد عن 90 دالة
API، مع حماية الجلسة، والبث الجماعي، وجدولة الرسائل، وويب-هوكس الصفحات.
مكتوب بالكامل بـ JavaScript خالص، ويُشحن مع الكود المصدري، بلا إرسال بيانات
خلفية وبلا رفع لجلسة الحساب إلى أي جهة خارجية.

## التثبيت

```bash
bun add bun-fca      # Bun >= 1.1
npm install bun-fca  # Node.js >= 18
```

## الواجهة الكلاسيكية (نمط Callback، متوافقة مع GoatBot/Mirai)

```js
const login = require("bun-fca");
const appState = require("./appstate.json");

login({ appState }, { listenEvents: true }, (err, api) => {
  if (err) return console.error(err);

  api.autoSaveSession("./appstate.json", { interval: 3 * 60 * 1000, backup: true });

  api.listenMqtt((err, event) => {
    if (err) return;
    if (event.type === "message" && event.body === "ping") {
      api.sendMessage("pong", event.threadID);
    }
  });
});
```

## الواجهة الحديثة (async/await + EventEmitter)

```js
import { loginAsync } from "bun-fca";

const api = await loginAsync({ appState }, { listenEvents: true });

api.events.on("message", async (event) => {
  if (event.body?.toLowerCase() === "ping") {
    await api.sendMessage("pong", event.threadID);
  }
});
```

كل دالة كلاسيكية تعمل تلقائياً بصيغة Promise أيضاً.

## ويب-هوكس الصفحات

```js
api.attachPageWebhook({
  port: 3000,
  path: "/webhook",
  verifyToken: process.env.VERIFY_TOKEN,
  appSecret: process.env.APP_SECRET, // تحقق اختياري بتوقيع X-Hub-Signature-256
});
```

تُوحَّد أحداث الصفحات وتُبَعث على `api.events`.

## المزايا

- مستمع MQTT مقوّى: بدائل متتالية عند الفشل، تراجع أُسّي مع عشوائية، فترة
  تهدئة قبل إعادة الاتصال، مهل حيوية، وحماية من الجلسات المكررة.
- SessionGuard: حفظ تلقائي لحالة الجلسة، نسخة احتياطية `.bak`، منع الكتابة
  فوق جلسة سليمة بجلسة تالفة، وكشف تسجيل الخروج والحسابات المشكوك بها.
- بث جماعي بتحكم في المعدل (`api.sendBroadcast`) ومجدول رسائل مدمج.
- طبقة HTTP مبنية على fetch الأصلي مع نظام كوكيز داخلي وفق RFC 6265؛ تتم
  متابعة إعادة التوجيه يدوياً لالتقاط `Set-Cookie` من كل خطوة.
- مرفقات من رابط أو Buffer أو stream أو data-URI عبر FormData داخلي.
- ملائم لـ Bun أولاً: استخدام fetch وWebSocket وFormData الأصلية عند توفرها.

## أهم دوال API

```js
await api.sendMessage("hi", threadID);
await api.sendMessage({ body: "hey", attachment: ["./photo.jpg"] }, threadID);
await api.sendMessageDM(msg, threadID);   // مسار HTTP بدون MQTT
await api.editMessage("edited", messageID);
await api.unsendMessage(messageID);
await api.setMessageReaction("...", messageID);
await api.sendTypingIndicator(threadID);
await api.getUserInfo(uid);
await api.getThreadInfo(threadID);
await api.getThreadHistory(threadID, 50);
await api.getThreadList(20);
await api.markAsRead(threadID);
await api.deleteMessage(messageID);
await api.createPoll(threadID, { title, options });
await api.sendBroadcast("hello", threadIDs, { delayMs: 1500 });
api.getAppState(); // كوكيز الجلسة الحالية للحفظ
```

الأحداث على `api.events`: `message`، `event`، `typ`، `read_receipt`،
`presence`، `message_reply`، `thread_name`، `thread_remove_participant`،
`message_unsend`، `error`، `*`.

## الإعدادات (ملف `fca-config.json` اختياري)

```json
{
  "autoUpdateCheck": false,
  "autoLogin": true,
  "webhook": { "enabled": false, "port": 3000, "path": "/webhook", "verifyToken": "" }
}
```

تسجيل الدخول بالبريد وكلمة المرور يتطلب تحديد `apiServer` تثق به. الطريقة
الموصى بها هي تسجيل الدخول عبر appState.

## الأمان

- جلسة الحساب لا تترك جهازك، ولا يوجد أي وسيط خارجي.
- فحص التحديثات معطّل افتراضياً (اختياري).
- لا يوجد eval ولا تحميل كود ديناميكي ولا وحدات native.

## تنبيه

واجهة غير رسمية. الاستخدام الآلي لحسابات ماسنجر قد يخالف شروط خدمة فيسبوك.
استخدمها على مسؤوليتك الخاصة مع حسابات تملكها. الرخصة MIT.
