# bun-fca

Unified, hardened Facebook Messenger Chat API (FCA) engine for Node.js and Bun.
Dual CJS/ESM, two runtime dependencies (`mqtt`, `ws`), 90+ API methods, session
guard, broadcast, scheduler and Page webhooks. Pure JavaScript, source shipped,
no telemetry, no credential uploads.

## Installation

```bash
bun add bun-fca      # Bun >= 1.1
npm install bun-fca  # Node.js >= 18
```

## Classic API (callback style, GoatBot/Mirai drop-in)

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

## Modern API (async/await + EventEmitter)

```js
import { loginAsync } from "bun-fca";

const api = await loginAsync({ appState }, { listenEvents: true });

api.events.on("message", async (event) => {
  if (event.body?.toLowerCase() === "ping") {
    await api.sendMessage("pong", event.threadID);
  }
});
```

Every classic callback method is also promisified automatically.

## Page webhooks

```js
api.attachPageWebhook({
  port: 3000,
  path: "/webhook",
  verifyToken: process.env.VERIFY_TOKEN,
  appSecret: process.env.APP_SECRET, // optional X-Hub-Signature-256 check
});
```

Page events are normalized and emitted on `api.events`.

## Features

- Hardened MQTT listener: cascade fallback, exponential backoff with jitter,
  reconnect cooldown, liveness timeouts, duplicate-session guards.
- SessionGuard: debounced appState auto-save, `.bak` backup, corruption guard,
  logout/checkpoint detection.
- Broadcast with rate control (`api.sendBroadcast`) and a message scheduler.
- HTTP stack built on native fetch with an internal RFC 6265 cookie jar;
  redirects are followed manually so `Set-Cookie` from every hop is captured.
- Attachments from URL, Buffer, stream or data-URI via an internal FormData.
- Bun-first: native fetch / WebSocket / FormData used wherever available.

## API surface

```js
await api.sendMessage("hi", threadID);
await api.sendMessage({ body: "hey", attachment: ["./photo.jpg"] }, threadID);
await api.sendMessageDM(msg, threadID);   // HTTP path, no MQTT
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
api.getAppState(); // fresh session cookies for persistence
```

Events emitted on `api.events`: `message`, `event`, `typ`, `read_receipt`,
`presence`, `message_reply`, `thread_name`, `thread_remove_participant`,
`message_unsend`, `error`, `*`.

## Configuration (optional `fca-config.json`)

```json
{
  "autoUpdateCheck": false,
  "autoLogin": true,
  "webhook": { "enabled": false, "port": 3000, "path": "/webhook", "verifyToken": "" }
}
```

Email/password login requires an explicit `apiServer` you trust. appState login
is the recommended method.

## Security

- appState never leaves your machine; no third-party relays.
- Update check is opt-in (disabled by default).
- No eval, no dynamic code loading, no native modules.

## Disclaimer

Unofficial API. Automated use of Messenger accounts can violate Facebook's
Terms of Service. Use at your own risk with accounts you own. MIT licensed.
