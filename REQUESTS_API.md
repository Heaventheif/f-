# Dashboard API (Requests + Broadcast)

All endpoints are served by `src/web/` (Bun.serve + a small router). Pages: `/requests`, `/broadcast`.

## Authentication
- Set `DASHBOARD_PASSWORD` (>= 12 chars). The legacy `PIN` env is only a fallback and logs a boot warning.
  If neither is valid, protected routes answer `503 not_configured`.
- `POST /api/dashboard/login` body `{"password": "..."}` (max 4 KB) sets cookie `sunkenbot_dashboard`
  (HttpOnly, SameSite=Strict, Secure behind HTTPS, Max-Age 12h).
- `GET /api/dashboard/session` -> `{authenticated}`; `POST /api/dashboard/logout` clears the session.
- Sessions live in kv namespace `sessions`: absolute lifetime 12h, idle timeout 2h.
- Failed logins back off exponentially per IP and per account (no global lockout): `429 rate_limited` + `Retry-After`.
- Client IP comes from `X-Forwarded-For` using `TRUSTED_PROXY_HOPS` (default 1; 0 = socket address).

## CSRF
Every state-changing request (POST/PUT/PATCH/DELETE, including login/logout) must carry a same-origin
`Origin` header (or `Sec-Fetch-Site: same-origin`). Otherwise `403 forbidden_origin`.

## Envelope and status codes
Success: `{"ok":true,"data":{...}}`. Failure: `{"ok":false,"error":{"code","message"},"data"?}`.
Status derives from `error.code`:

| code | HTTP |
|---|---|
| bad_request, bad_json, bad_multipart, invalid_param, blocked_url | 400 |
| unauthorized, invalid_credentials | 401 |
| forbidden_origin | 403 |
| not_found | 404 |
| method_not_allowed | 405 |
| conflict | 409 |
| payload_too_large | 413 |
| unsupported_media | 415 |
| rate_limited | 429 |
| internal | 500 |
| not_implemented | 501 |
| upstream | 502 |
| bot_offline, not_configured, unavailable | 503 |
| timeout | 504 |

## Limits
JSON bodies 256 KB (login 4 KB); broadcast uploads capped by `GET /api/broadcast/limits`.
Per-IP rate limits: requests read 60/min, write 30/min; broadcast read 120/min, write 20/min.
All API responses are `Cache-Control: no-store`; pages carry a strict CSP (scripts only from `/static/*.js`).

## Health
`GET /health` (also `/api/health`) -> `{mqtt,state,lastEventAt,uptime}`; `503 bot_offline` when MQTT is not connected.

## Requests (auth required)
- `GET /api/requests?kind=messages|friends|all&folder=PENDING|OTHER|INBOX&limit=1..100&cursor=` -
  default kind `messages`, default limit 50. Message results include `nextCursor`.
  Friends entries are only *candidates* (`isPendingCandidate`); friend actions are disabled.
- `POST /api/requests/refresh/messages` (optional JSON `{folder,limit,cursor}`), `POST /api/requests/refresh/friends`.
- `POST /api/requests/messages/:threadID/:action` (`accept|reject`): the thread must currently be in PENDING/OTHER, else `409`.
- `POST /api/requests/bulk` `{kind:"messages",action,ids:[...]}`: max 25 ids, each attempted once with jitter.
  Response `data`: `{requested,succeeded,failed,results:[{id,success,error?}]}`. If none succeeded: `502 upstream` with the same `data`.
- `POST /api/requests/friends/:id/:action` -> `501 not_implemented`.

## Broadcast (auth required)
- `GET /api/broadcast/limits` -> sizes, counts, allowed extensions, hourly/daily caps, `ephemeralStorage`.
- `GET /api/broadcast/groups[?refresh=1]` -> `{groups:[{id,name,participantCount}]}` (cached 30s, single-flight).
- `POST /api/broadcast` multipart: `text`, `targetIds` (JSON array), `files` (repeated); optional `Idempotency-Key` header
  (replay returns `200` with `replay:true`, creation `201`). Files are checked against an extension/MIME allowlist and size caps.
- `GET /api/broadcast/campaigns`, `GET /api/broadcast/campaigns/:id`.
- `POST /api/broadcast/campaigns/:id/{pause|resume|cancel|retry}`. Retry never unpauses a manual pause.
- `POST /api/broadcast/campaigns/:id/targets/:threadID/{resolve|skip}` for targets in `unknown` state.
- Statuses: campaign `queued|running|paused|cancelled|completed|completed_with_errors|review`;
  target `pending|processing|sent|failed|unknown|cancelled`. `waitReason` (`hourly_cap|daily_cap`) explains queued-by-cap.
  Missing attachment files after a restart fail targets with `file_missing`.
- Pacing and hourly/daily caps persist in kv; uploads live under `STATE_DIR` (or `BROADCAST_DATA_DIR`).

## Internal `/yt/*`
Server-to-server, header `X-Internal-Token` (= `INTERNAL_TOKEN`), no cookie/CSRF; URLs pass the SSRF guard.
`POST /yt/search`, `/yt/audio`, `/yt/video`. `/f/:name` serves hosted temp files (traversal-safe).
