# Trent — Claude Context

> **This is `trent-os`** — a clean copy of the Trent app (no `node_modules`, `.next`, `.git`, build artifacts, or `.env`) set up to be built with the [Superpowers](https://github.com/obra/superpowers) methodology.

## ⚡ Superpowers Methodology (use it)

This project follows obra/superpowers. The 14 skills are installed at `.claude/skills/`. Before any build work:

1. Read `.claude/skills/using-superpowers/SKILL.md`.
2. Follow the loop: `brainstorming` → `using-git-worktrees` → `writing-plans` → `subagent-driven-development` (+ `test-driven-development`) → `requesting-code-review` → `verification-before-completion` → `finishing-a-development-branch`.
3. The build plans live in `docs/superpowers/plans/`:
   - `2026-05-28-trent-os-master-plan.md` — 15-phase sequencing, gates, and the per-phase superpowers loop.
   - `2026-05-28-phase-0-foundation-hardening.md` — worked bite-sized TDD example slice (RBAC). Copy this format for every new slice.
4. Source-of-truth scope: `../03-task-list.md` (advisor-readable) and `trent-master-tasklist.md` (canonical).

## ⚡ Start Every Session By Reading These Files

```
~/Projects/trent/README.md                    ← project overview (this repo)
~/Projects/trent/docs/RUN.md                  ← local setup (authoritative)
~/Projects/trent/trent-master-tasklist.md     ← canonical task list
~/Projects/trent/docs/superpowers/plans/      ← phase plans + gates
~/Projects/trent/CLAUDE.md                    ← agent context (this file)
```

Optional external Obsidian vault (may not exist on every machine): `~/Documents/obsidian/trent/` — use repo files above when absent.

## After Each Session

Append a new entry to your session log (Obsidian vault if present, otherwise a note in `docs/` or the PR description).

## Rules

- Do what has been asked; nothing more, nothing less
- NEVER commit secrets or .env files
- ALWAYS run `npm run typecheck` before committing
- After Prisma schema changes: push to **both** dev Postgres (`DATABASE_URL`) **and** test Postgres (`TEST_DATABASE_URL`) — see `docs/RUN.md`
- Files under 500 lines; split if larger
- Use `makeId("prefix")` for IDs, `nowIso()` for timestamps

## Security

- Local secrets live in **`.env.local`** (copy from `.env.example`) — NEVER commit
- `GITHUB_TOKEN`, `SECRET_ENCRYPTION_KEY`, and provisioning keys are real credentials when set

## Phase 0 Security Invariants (must hold before Phase 2 ships)

### RLS activation
Every API route that reads or writes tenant data MUST wrap its handler body in `withRlsContext(companyId, async () => { ... })` from `lib/with-rls.ts`. On Postgres this sets `app.current_company_id` so RLS policies fire. On SQLite it is a no-op.

**Forbidden pattern** — calling `store.*` outside a `withRlsContext` in a paid/data route:
```ts
// WRONG — RLS never fires
const tasks = await store.listTasks(companyId);

// CORRECT
const tasks = await withRlsContext(companyId, () => store.listTasks(companyId));
```

### Rate limiting
- `checkRateLimit` and `checkCycleRateLimit` fail open (OK during Redis outage — do not change).
- `checkAuthRateLimit` fails **closed** — a Redis outage returns 429 for auth endpoints. Never change this to fail open.

### Dev auth bypass
`canAccessCompany` in `lib/session.ts` returns `true` in `NODE_ENV=development`. NEVER deploy with `NODE_ENV=development` in production.

### Spend reservation
`assertToolSpendAllowed` reserves the full `estimatedCents` to prevent TOCTOU double-spend. The final charge must reconcile the reservation. Do NOT lower the reservation back to 0.

### Audit log
`appendAuditLog` uses a serializable transaction. Do not split the hash-read and create-row into two separate calls outside a transaction.

### Secrets rotation
`lib/secrets.ts` exports `rekeySecret(ciphertext, oldKey, newKey)`. Use this to re-encrypt stored secrets when rotating `SECRET_ENCRYPTION_KEY`. There is no automated migration — call it on every row in the `credentials` table during a key-rotation incident.

## Phase 3 — Infrastructure Provisioning (code complete; real-provider validation pending)

**Orchestrator wired today:** `lib/provisioning/orchestrator.ts` runs **GitHub → Neon → Vercel** only. R2, DNS, Sentry, Render, Expo, env-manager sequencing in slash-command docs are **not** in the orchestrator yet.

### Provisioning Dependency Graph

```
env-manager
  └─ resolveCredentialEnv (credential-boundary.ts)
       └─ store.getIntegration(companyId)   ← isolation boundary
       └─ decryptJson (secrets.ts)

Provisioning order (enforced by orchestrator):
  1. github-provisioner   ← repo must exist before hosting points to it
  2. neon-provisioner     ← DB must exist before hosting env vars injected
  3. vercel-provisioner   ← hosting provisioned last (gets neon conn string)

Rollback order (reverse dependency):
  hosting fail → rollback hosting + neon + github
  neon fail    → rollback neon + github
  github fail  → no rollback (nothing created)
```

### Provisioner Files (all in `lib/provisioning/`)

| File | Provider key | Rollback method | Tests |
|---|---|---|---|
| env-manager.ts | — (pure read) | — | 14 |
| github-provisioner.ts | GitHub-Provisioned | deleteRepo() | 14 |
| neon-provisioner.ts | Neon-Provisioned | deleteProject() | 12 |
| vercel-provisioner.ts | Vercel-Provisioned | deleteProject() | 14 |
| render-provisioner.ts | Render-Provisioned | deleteService() | 10 |
| r2-provisioner.ts | R2-Provisioned | deleteBucket() | 9 |
| dns-provisioner.ts | DNS-Provisioned | deleteRecord() | 8 |
| domain-provisioner.ts | Domain-Provisioned | removeCustomDomain() | 8 |
| expo-provisioner.ts | Expo-Provisioned | deleteProject() | 7 |
| sentry-provisioner.ts | Sentry-Provisioned | deleteProject() | 8 |
| cost-attributor.ts | Phase 2 UsageLedger | — (no rollback, read only) | 6 |
| teardown-engine.ts | Teardown-State | cancelTeardown() | 16 |
| orchestrator.ts | — (coordinator) | — | 7 |

**All provisioner unit tests pass in isolated runs.** Real GitHub / Neon / Vercel accounts not yet exercised on this tree — see checkboxes below.

### Real-Provider Validation Status

**Required before shipping any provisioner to production:**
- [ ] github-provisioner — test against real GitHub org + App installation
- [ ] neon-provisioner — test against real Neon account
- [ ] vercel-provisioner — test against real Vercel team
- [ ] r2-provisioner — test against real Cloudflare account
- [ ] dns-provisioner — test against real Cloudflare zone
- [ ] expo-provisioner — test against real EAS account
- [ ] sentry-provisioner — test against real Sentry org
- [ ] render-provisioner — test against real Render account

Dry-run checklist: `docs/RUN.md` § Provisioning.

## Master Task List

Full tasklist: `~/Projects/trent/trent-master-tasklist.md` (this repo)

### Locked Architectural Decisions

These decisions **cannot be changed** after the first company is provisioned:

1. **Neon branching strategy**: `main` / `staging` / `preview` — hardcoded in neon-provisioner.ts. Changing requires migrating every existing company's DB.

2. **GitHub org structure**: Single GitHub App installation with per-repo permissions. Each company gets one repo in `GITHUB_PLATFORM_ORG` (env var, default `"trent-platform"`). The workbench session `repoUrl` must resolve to `https://github.com/{GITHUB_PLATFORM_ORG}/{companySlug}`.

3. **Subdomain format**: `{companySlug}.{TRENT_PLATFORM_DOMAIN}` (default `trent.app`). Slug collision handling is the caller's responsibility — pass a unique slug. Reserved words not yet enforced (TODO before first provisioning in prod).

4. **Teardown cooling-off**: 30 days, platform-wide. Not configurable per company. Stored in `TeardownRecord.coolingOffEndsAt`. The n8n workflow `teardown-cooling-off-timer.json` manages the timer.

5. **Rollback scope**: Each provisioner only rolls back its own resource. The orchestrator rolls back in reverse dependency order. DNS failure does NOT roll back hosting. Hosting failure DOES roll back Neon and GitHub.

6. **Credential boundary pattern**: Every provisioner uses `sanitizeError()` to strip API keys and connection strings from error messages. The pattern is in every `*.provisioner.ts` file. Do not remove it.

7. **Cost attribution**: `recordProvisioningCost()` is idempotent by `(resourceId, period)`. Called by n8n daily cost sync. The daily sync is in `lib/provisioning/n8n-workflows/cost-attribution-sync.json`.

### Phase 3 → Phase 4 Edges (do not break)

Phase 4 content generation depends on these Phase 3 modules:
- **R2** (`R2-Provisioned` integration): generated images/video stored in per-company R2 bucket. Bucket name: `trent-{companySlug}`. CDN URL in `R2ProvisionedResource.cdnUrl`.
- **Sentry** (`Sentry-Provisioned` integration): content generation errors tracked per company. DSN stored encrypted — inject via `env-manager.buildProvisioningEnv(companyId, { providers: ["Sentry-Provisioned"] })` (needs CREDENTIAL_REGISTRY entry for Sentry DSN).
- **env-manager**: content generation API keys (Anthropic, OpenAI) injected per company via `buildProvisioningEnv(companyId, { providers: ["Anthropic", "OpenAI"] })`.

### API Surface

```
POST   /api/provisioning          — trigger provisioning (admin + budget check + RLS)
GET    /api/provisioning          — query status per provisioner
POST   /api/provisioning/rollback — manually roll back specific resources
POST   /api/teardown              — initiate teardown (cooling_off, 30-day timer)
GET    /api/teardown              — get current teardown state
DELETE /api/teardown              — cancel teardown during cooling_off
POST   /api/teardown/confirm      — confirm permanent deletion (throws if < 30 days)
```

### ECC Slash Commands

```
/provision-company [company-id]   — full provisioning run
/provision-status  [company-id]   — aggregate status
/provision-rollback [company-id]  — manual rollback
/teardown-company  [company-id]   — initiate teardown
/export-company-data [company-id] — data export bundle
/infra-cost [company-id]          — Phase 2 ledger cost breakdown
```

### n8n Workflows (in `lib/provisioning/n8n-workflows/`)

| File | Trigger | What it does |
|---|---|---|
| dns-propagation-poll.json | POST /trent/dns-provisioned | Polls cert status, notifies on active |
| teardown-cooling-off-timer.json | POST /trent/teardown-initiated | Day-25 reminder + day-30 escalation |
| cost-attribution-sync.json | Cron 06:00 daily | Provider billing sync + budget breach alert |
