# Broadcast dashboard

The dashboard is served by the existing Bun web server at `/broadcast`. It uses the bot's existing `global.botApi` connection and the project's `global.safeSend` / `global.mediaSend` helpers.

## Enable it

Set a strong secret in the deployment environment:

```env
BROADCAST_TOKEN=replace-with-a-random-secret-at-least-32-characters
BROADCAST_DATA_DIR=/app/data/broadcast
BROADCAST_MAX_FILE_MB=50
BROADCAST_MAX_TOTAL_MB=100
BROADCAST_MAX_TARGETS=300
```

Generate a secret locally with:

```sh
openssl rand -hex 32
```

On Render, `render.yaml` creates `BROADCAST_TOKEN` automatically and stores campaign state/uploads under `/app/data/broadcast`, on the existing persistent disk. After deployment, open `https://YOUR-SERVICE/broadcast` and enter the environment value of `BROADCAST_TOKEN`.

Do not put the token in a URL, commit it to source control, or share it with untrusted users. Keep the dashboard behind HTTPS. API requests require the `X-Broadcast-Token` header.

## Included behavior

- Arabic RTL dashboard with group search, selection, preview, and multiple attachments.
- Text, images, video, audio, and general file attachments (subject to FCA/Meta's actual support and file limits).
- Persistent campaign/target state stored in `campaigns.json`, with atomic file replacement.
- One target at a time; uses the bot's current connection.
- Pause, resume, cancel remaining targets, and retry targets whose failures are clear.
- Per-target progress checkpoints so a retry skips items already confirmed as sent.
- Timeouts or network failures with ambiguous outcomes are marked `unknown` and are not automatically retried.
- Old terminal campaigns and their uploads are pruned after seven days.

## Important operational notes

- The current group list is based on the conversations returned by the FCA `getThreadList` call (up to 500 entries); it is not a guarantee of an exhaustive lifetime group inventory.
- `sent` means the send operation was confirmed by the library callback, not that every member read or received the message.
- A timeout can occur after the remote side accepted a message. Review `unknown` targets manually; automatically retrying them could duplicate messages.
- Cancellation stops targets that have not started; it cannot retract messages already sent or reliably cancel a request already in progress.
- This implementation assumes one active bot/server worker writing to this local store. Do not scale this service to multiple active instances without moving the campaign store/queue to a shared database and adding distributed job locking.
- The persistent disk must be enabled and writable in deployment. Without persistent storage, campaign history and queued work may be lost on redeploy/restart.
- Use only for messages to groups you administer or are authorized to contact, and comply with the platform's rules and limits.

## Pacing and safety (added in review)

```env
BROADCAST_MIN_DELAY_MS=8000            # random delay between groups (min)
BROADCAST_MAX_DELAY_MS=20000           # random delay between groups (max)
BROADCAST_MAX_PER_HOUR=120             # groups per rolling hour; the queue waits automatically
BROADCAST_MAX_CONSECUTIVE_FAILURES=4   # campaign auto-pauses (pauseReason) after N failures in a row
FB_MEDIA_TIMEOUT_MS=180000             # upload+send timeout for attachments
```

- The campaign pauses automatically when MQTT health reports `AUTH_FAILED`, a cooldown, or `STOPPED`. Fix the session, then press Resume.
- Library errors such as `Timeout waiting for ACK` are classified as `unknown` (not retried automatically): the library may also re-send over HTTP after an MQTT timeout, so the message may already be delivered.
