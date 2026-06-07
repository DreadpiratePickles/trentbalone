# GBrain sidecar

Per-company mission-memory service for Trent. It **advises; it never executes
actions or bypasses Trent's approval gates**. Every time an agent mission
finishes, Trent ingests the memory log here; when a new mission starts, agents
recall prior context. Degrades gracefully: if this service is unreachable,
Trent falls back to its local store-backed brain.

Zero dependencies — pure `node:http`. Same repo as Trent (monorepo), deployed as
a **second Railway service** with its own root directory and runtime.

## Endpoints

| Method | Path      | Body                                              | Returns                                            |
|--------|-----------|---------------------------------------------------|----------------------------------------------------|
| GET    | `/health` | —                                                 | `{ status: "ok" }`                                 |
| POST   | `/ingest` | `{ companyId, runId, title, content, source, tags }` | `{ documentId }`                                |
| POST   | `/recall` | `{ companyId, query, limit? }`                    | `{ answer, citations[], gaps[] }`                  |
| POST   | `/advise` | `{ companyId, objective, question, context? }`    | `{ guidance, suggestedNextStep, clarifyingQuestions[] }` |

All POST routes require `Authorization: Bearer ${GBRAIN_API_KEY}` when that env
var is set. The contract matches `lib/gbrain/gbrain-client.ts` in Trent.

## Run locally

```bash
cd gbrain
GBRAIN_API_KEY=dev_key PORT=8080 node server.mjs
node --test          # 8 tests
```

## Railway: second service, same repo

1. In the **same Railway project** as Trent, add a new service from the **same
   repo**.
2. Set its **Root Directory** to `gbrain`.
3. Railway picks up `gbrain/railway.json` (Nixpacks, `node server.mjs`,
   healthcheck `/health`).
4. Set service variables: `GBRAIN_API_KEY` (shared secret), `PORT` (Railway
   injects this; the server honors it).

### Wire Trent → GBrain over private networking

On the **Trent** service set:

```
GBRAIN_URL=http://gbrain.railway.internal:8080
GBRAIN_API_KEY=<same shared secret as the gbrain service>
```

`gbrain.railway.internal` is the private DNS name (replace `gbrain` with the
actual service name). Trent's `resolveGbrainConnection` reads these env vars as
the platform-wide fallback; a per-company connection saved via
`POST /api/companies/[id]/gbrain` overrides them.
