# Requests API

تستخدم المسارات جلسة لوحة التحكم عبر Cookie:

```text
POST /api/dashboard/login {"pin":"1234"}
```

جميع عمليات `POST` تتطلب نفس `Origin` الخاص بالخدمة.

## قراءة الطلبات

```text
GET /api/requests?kind=message&folder=PENDING&limit=50
GET /api/requests?kind=message&folder=OTHER&limit=50
GET /api/requests?kind=message&folder=INBOX&limit=50
GET /api/requests?kind=friend
GET /api/requests?kind=all
```

القيم المدعومة لـ `folder`:

- `PENDING`: طلبات مراسلة معلقة.
- `OTHER`: مراسلات مهملة أو منقولة إلى Other.
- `INBOX`: الرسائل الموجودة في الوارد.

استجابة `kind=friend` تحتوي `items` كما يعيدها `getFriendsList`، وتحتوي أيضًا على:

- `pendingCandidates`: مستخدمون `isFriend=false`، وهم مرشحون فقط.
- `pendingCandidateCount`.
- `warning` يوضح أن `getFriendsList` ليست مصدرًا مضمونًا لقائمة طلبات الصداقة المعلقة.

## تحديث القوائم

```text
POST /api/requests/refresh/friends
POST /api/requests/refresh/messages
```

Body اختياري لتحديث الرسائل:

```json
{"folder":"OTHER","limit":20}
```

## قبول أو رفض طلب مراسلة

يعمل مع محادثة فردية أو مجموعة:

```text
POST /api/requests/messages/<threadId>/accept
POST /api/requests/messages/<threadId>/reject
```

قبول طلب موجود في `OTHER` ينقله إلى `INBOX` عبر `handleMessageRequest(threadId, true)`.

## قبول أو رفض طلب صداقة

```text
POST /api/requests/friends/<userId>/accept
POST /api/requests/friends/<userId>/reject
```

هذا المسار مغلق داخل الكود حاليًا، ويعيد `501 FRIEND_ACTIONS_NOT_IMPLEMENTED` دائمًا:

```text
FRIEND_ACTIONS_ENABLED=0
```

متغير البيئة لم يعد يفتح العملية، ولا توجد طريقة لتفعيلها من الإعدادات. هذا مقصود حتى تتم إضافة Adapter موثوق.

السبب أن `fcanew-r3nz75@10.1.15` تعرض `handleFriendRequest(userID, accept)`، لكن تنفيذها الداخلي المنشور لا يمرر `userID` ضمن نموذج طلب Facebook بشكل واضح. لذلك لا تعتبر هذه العملية جاهزة للإنتاج حتى يتم اعتماد Adapter موثوق أو نسخة مكتبة مصححة.

## عمليات جماعية

```text
POST /api/requests/bulk
```

Body:

```json
{"kind":"message","action":"accept","ids":["1","2"]}
```

أو:

```json
{"kind":"friend","action":"reject","ids":["1","2"]}
```

الحدود:

- القراءة: 30 طلبًا في الدقيقة لكل IP.
- التعديل: 10 طلبات في الدقيقة لكل IP.
- أقصى عدد في العملية الجماعية: 25 معرفًا.
- `limit`: من 1 إلى 100.

عمليات الرسائل الجماعية تمرر المصفوفة إلى fcanew، وإذا فشلت تعيد المحاولة عنصرًا عنصرًا وتعرض نتيجة كل عنصر.
