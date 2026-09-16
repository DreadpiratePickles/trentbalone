# Webhooks API Contracts

Date: 2026-09-15

Implementation: `lib/webhooks.ts`, `lib/webhooks-schema.ts`, `app/api/companies/[id]/webhooks/`,
`app/api/hooks/[id]/route.ts`. Storage: `Webhook`, `WebhookDelivery` (`prisma/schema.prisma`).
Shared error envelopes follow `security-readiness-api-contracts.md`.

## Outbound events

| Event | Source on the internal bus (`lib/job-events.ts`) |
|---|---|
| `run.completed` | `JobRunEvent.status === "completed"` |
| `run.failed` | `JobRunEvent.status === "failed"` |
| `approval.created` | `status === "step"` with `step.phase === "approval_required"` |

`approval.resolved`, `task.completed` and `spend.paused` have no emitter on the bus. They are
reported under `eventsWithoutSource` by `GET /api/surfaces` and are not accepted by the
management routes until something publishes them (`publishWebhookEvent`).

## Delivery format

```
POST <webhook.url>
content-type: application/json
x-trent-timestamp: 1789000000            (unix seconds)
x-trent-signature: sha256=<hex>          (HMAC-SHA256(secret, timestamp + "." + body))
user-agent: trent-webhooks/1

{ "id": "whe_...", "event": "run.completed", "companyId": "co_...",
  "occurredAt": "2026-09-15T00:00:00.000Z", "data": { ... } }
```

Receivers should recompute the signature over the raw body, compare in constant time, and reject
timestamps older than 300 seconds (`verifyWebhookSignature` in `lib/webhooks.ts` does exactly this
and can be copied).

Retry: 5 attempts, exponential backoff 30s, 60s, 120s, 240s, 480s (capped at 15 minutes), run as
`webhook_delivery` jobs on the existing queue. Each attempt updates `WebhookDelivery.attempts`,
`lastError`, `nextAttemptAt`; a 2xx sets `status: "delivered"` and `deliveredAt`; the last failed
attempt sets `status: "dead"`. After 10 consecutive failed attempts across deliveries the webhook is
set `enabled: false` and an audit row `webhook.disabled` is written. Re-enabling through `PATCH`
resets the counter.

## GET /api/companies/:id/webhooks

Authentication: session; role `admin`. RLS context: company.

Response `200`:

```json
{ "webhooks": [ { "id": "wh_...", "companyId": "co_...", "url": "https://...",
  "secretRef": "********", "hasSecret": true, "events": ["run.completed"],
  "action": "create_task", "enabled": true, "consecutiveFailures": 0,
  "createdAt": "...", "updatedAt": "..." } ] }
```

`secretRef` is always masked. The ciphertext never leaves the store.

## POST /api/companies/:id/webhooks

Body (zod, `createWebhookSchema`):

```json
{ "url": "https://receiver.example/hook", "events": ["run.completed", "approval.created"],
  "action": "create_task", "enabled": true }
```

`url` must be https. `events` must be a subset of the outbound events above. `action` is optional
and enables the inbound trigger.

Response `201`: `{ "webhook": { ...masked }, "secret": "whsec_..." }`. The plaintext secret is
returned in this response only. Errors: `400 invalid_body`, `401`, `403`.

## GET / PATCH / DELETE /api/companies/:id/webhooks/:webhookId

Role `admin`. `GET` returns `{ webhook, deliveries }` (last 50 deliveries, newest first).
`PATCH` accepts any of `url`, `events`, `action` (nullable), `enabled`, `rotateSecret: true`; a
rotation returns the new `secret` once. `DELETE` returns `{ "ok": true }`. Missing webhook: `404`.

## POST /api/hooks/:id (inbound trigger)

Authentication: `Authorization: Bearer <webhook secret>` compared with `timingSafeEqual`. The route
bypasses the session middleware, is rate limited per IP (`webhook:inbound`), and limits the body
to 64 KiB. The webhook must be `enabled` and have an `action`.

Headers: `x-trent-idempotency-key` (optional). The key is unique per webhook; a replay returns
`200 { "duplicate": true, "receiptId": "whd_...", "status": "delivered" }` and performs nothing.

Bodies (zod, `inboundWebhookBodySchema`):

```json
{ "event": "task.create", "data": { "title": "...", "prompt": "...", "priority": "high", "tags": ["x"] } }
{ "event": "run.start",   "data": { "objective": "...", "fullTeam": false } }
```

| Hook `action` | Accepted event | Effect |
|---|---|---|
| `create_task` | `task.create` | `store.createTask` (status `queued`, tag `webhook`) |
| `start_run` | `run.start` | `launchOrchestration` (trigger `manual`) |

Responses: `201 { duplicate: false, receiptId, task | run }`; `200` duplicate; `400 invalid_json`
or `invalid_body`; `401`; `404` unknown, disabled or outbound-only hook; `413 body_too_large`;
`422 unsupported_event` for an unknown event or one the hook's action does not accept;
`502 action_failed`. Every accepted request writes a `WebhookDelivery` row with
`direction: "inbound"` and an audit row `webhook.inbound.<action>`.
