# Railway Deployment Topology

Trent runs as **two services off this one repo**, plus managed Redis and Postgres:

| Service | Config path | Start command | Purpose |
|---|---|---|---|
| `trent-web` | `railway.json` (default) | `npm start` (`next start`) | HTTP app — enqueues orchestration jobs |
| `trent-worker` | `railway.worker.json` | `npm run worker` (`tsx lib/worker.ts`) | BullMQ consumer — drains the queue and runs plan/execute/critic/consolidate |
| `Redis` | — (Railway plugin) | — | BullMQ queue + worker heartbeat |
| `Postgres` | — (Railway plugin) | — | Durable store (`DATABASE_URL`) |

## Why two services

Orchestration is queue-driven. `trent-web` calls `launchOrchestration`, which only
**enqueues** a `plan` job to BullMQ and returns. Nothing in the web process
consumes the queue — that is `trent-worker`'s job (`lib/worker.ts`, a standalone
BullMQ `Worker` that requires `REDIS_URL`). Without the worker, runs are created
but sit at `planning` forever: agents never get assigned, the critic never runs.

`/api/health` reports the worker heartbeat (`readWorkerHeartbeat`); a null/stale
`workerSeenAt` means the worker is down or pointed at the wrong Redis.

## Required shared env (both web + worker)

Both services **must** resolve to the **same** Redis and Postgres, or web enqueues
into one place and the worker listens on another:

- `REDIS_URL` → `${{Redis.REDIS_URL}}`
- `DATABASE_URL` → `${{Postgres.DATABASE_URL}}`
- plus the app secrets (`OPENAI_API_KEY`, `SECRET_ENCRYPTION_KEY`, etc.)

## Configuring the worker service in the Railway dashboard

The worker service is **not** auto-created by pushing this file. To point an
existing/new service at it:

1. Create a service from this repo (or use the existing `trent-worker`).
2. Settings → **Config-as-code** → set the path to `railway.worker.json`.
3. Variables → add the shared `REDIS_URL` / `DATABASE_URL` references above.
4. Deploy. Confirm the logs show:
   `[Worker] Connected to Redis; consuming queue "trent-autonomy-queue"`

## Migrations

Only `trent-web` runs `npx prisma migrate deploy` (its `preDeployCommand` in
`railway.json`). `railway.worker.json` intentionally omits it so the two
services don't race the same migration on deploy.

## Smoke test

Press **Run** in the app, then watch `trent-worker` logs. Within ~1–2s you should
see `[Worker] Received job … (type: orchestration_step)`. If that line appears,
the loop is healthy end-to-end.
