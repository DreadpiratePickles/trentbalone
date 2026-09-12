# Baseline Discovery Report — Trent

Date: 2026-09-12. Repo: `/Users/bobbymeher/Desktop/trent` (branch `main`, clean at start).
No source files were modified. Scratch experiments were run in the session scratchpad.

## 1. Environment

| Tool | Command | Result |
|---|---|---|
| node | `node --version` | `v26.8.2` (exit 0) — note `apps/web/package.json` declares `"engines": {"node": "22.x"}` |
| npm | `npm --version` | `11.19.1` (exit 0) |
| bun | `which bun` | NOT on PATH |
| cargo | `cargo --version` | `cargo 1.75.0 (1d8b05cdd 2023-11-20)` at `/Users/bobbymeher/.cargo/bin/cargo` |
| docker | `docker --version` | `Docker version 29.5.3, build d1c06ef` at `/usr/local/bin/docker` |
| docker daemon | `docker info` | **exit 1 — daemon NOT running** |

Implication: any plan depending on a Docker-based Postgres (or embedded-Postgres-via-Docker) is
blocked on this machine until the user starts Docker Desktop.

## 2. Baseline build

Command: `cd apps/web && npx next build`

**Exit code: 0. PASS.** Full route table emitted, middleware 43.9 kB, shared JS 103 kB.
No errors, no warnings matching `error|failed` in the log.

Note: the package's own `build` script is `prisma generate && next build`; I ran `next build`
directly per instruction. The Prisma client was already generated, so this is representative.

## 3. Baseline tests

### 3a. Repo root: `npx vitest run` (uses `/vitest.config.ts`)

**Exit code: 1.**

```
Test Files  2 failed | 520 passed | 13 skipped (535)
     Tests  2 failed | 2798 passed | 125 skipped (2926)
  Duration  49.40s
```

Both failures are **harness/cwd artifacts, not product regressions**:

1. `apps/web/gbrain/server.test.mjs` — collection error: `No test suite found in file`.
   The root config has no `exclude` for it; the `apps/web` config does not collect it.
2. `apps/web/railway.config.test.ts` (2 tests) — `Error: ENOENT: no such file or directory,
   open 'railway.json'` at `railway.config.test.ts:6:34` and `'railway-worker.json'` at
   `:16:34`. The test reads a **relative** path; those files live in `apps/web/`, so it only
   passes when cwd is `apps/web`.

Root cause: `/vitest.config.ts` excludes only `lib/**` and `app/**` (top-level), so it sweeps up
`apps/web/**` tests but without `apps/web/vitest.setup.ts`, the `next/server` mock alias, or the
`apps/web` cwd. **The root `vitest run` is not the project's real test entrypoint.**

### 3b. `apps/web` own test script — it DOES differ

`apps/web/package.json`: `"test": "vitest run --pool=forks --poolOptions.forks.singleFork=true"`

Command: `cd apps/web && npm test`

**Exit code: 0. PASS.**

```
Test Files  505 passed | 13 skipped (518)
     Tests  2743 passed | 125 skipped (2869)
  Duration  90.15s
```

`apps/web/vitest.config.ts` probes for Postgres and falls back to an in-memory store, skipping
DB-specific suites, which is why it is green with no database running.

**Conclusion: the true baseline is green.** Use `cd apps/web && npm test` as the gate.

## 4. Prisma / persistence analysis

Schema: **`/Users/bobbymeher/Desktop/trent/apps/web/prisma/schema.prisma`** (1327 lines, the only
`schema.prisma` outside `node_modules`).

### Datasource (lines 5–9)

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

Provider `postgresql`; URL from **`DATABASE_URL`**; migrations/direct connections from
**`DIRECT_URL`** (Supabase/Neon pooler pattern). Generator is plain `prisma-client-js`, **no
`previewFeatures`, no `extensions`**.

### Models — 64 models, 10 enums

Core: **User** (person), **Company** (tenant root; budget, autonomy, cycle cadence),
**CompanyMember**+**CompanyMemberRole** (membership/RBAC), **Agent** (per-company agent config),
**AgentPlugAssignment** (agent→profile binding), **AgentEntitlement** (agent product access).

Work: **Task**, **RecurringTaskTemplate**, **Cycle**, **Goal**(+**GoalStatus**),
**CompanyCustomSkill**, **McpServer**, **AgentExecution** (one agent invocation),
**ToolConnection** (encrypted OAuth creds), **Approval**(+**ApprovalStatus**), **Document**,
**Artifact**, **Report**, **Comment**, **CeoMessage**, **CeoSuggestion**.

Workbench: **WorkbenchSession**, **WorkbenchEvent**, **WorkbenchArtifact**, **WorkbenchAttempt**,
**WorkbenchCheckpoint**, **WorkbenchChatMessage**.

Orchestration: **OrchestratorRun**, **OrchestratorStep**, **OrchestratorEvent**;
**AgentMissionRun/Step/Event**; **ContentMissionRun/Action**.

Ops/audit/billing: **UsageLedgerEntry**, **AuditLog** (hash-chained), **JobRun**(+**JobRunStatus**),
**Invoice**, **LedgerEntry**, **PayoutHold**, **StripeCustomer**, **StripeSubscription**,
**StripeWebhookEvent**.

Marketing: **MarketingAccount**, **AdCampaign**, **AdCreativeVariant**, **ConversionEvent**,
**AudienceSegment**, **AdSpendCharge**, **OptimizationRun**, **CreativePerformanceMemory**.

Social: **SocialAccount**, **SocialPost**, **SocialConversation**, **SocialContact**,
**SocialMessage**, **SocialVoicePolicy**, **SocialAnalyticsSnapshot**, **SocialOutreachDraft**.

Learning: **AgentTrace**, **SkillDraft**, **SelfImprovementIteration**, **CompanyPlaybookEntry**.

Other enums: **CompanyStatus**, **AutonomyLevel**, **CycleFrequency**, **AgentRole**,
**TaskStatus**, **CycleStatus**.

### Models required for the CLI's five concerns (exact names)

| Concern | Models |
|---|---|
| Orchestration run | `OrchestratorRun` (line 501) — plus `Company` (21) as required FK parent |
| Per-step traces | `OrchestratorStep` (524), `OrchestratorEvent` (553), `AgentTrace` (1261) |
| Sessions | `WorkbenchSession` (382), `WorkbenchEvent` (415), `WorkbenchChatMessage` (687) |
| Approvals | `Approval` (318) + enum `ApprovalStatus` (843) |
| Budget / cost | `UsageLedgerEntry` (712); `Company.budgetCents`/`weeklyBudgetCents` (37, 47-ish); `OrchestratorRun.budgetCents`/`costCents`; `OrchestratorStep.costCents`/`tokens`; `AgentTrace.costCents` |

`OrchestratorRun`, `OrchestratorStep`, `OrchestratorEvent`, `Approval`, `UsageLedgerEntry` and
`AgentTrace` all carry a **required `companyId` with `onDelete: Cascade` to `Company`** — a CLI
must seed a local `Company` row before it can write anything.

### Can this run on SQLite? — YES. Verified, not assumed.

I copied the schema to scratch, changed only `provider = "sqlite"` and dropped `directUrl`
(SQLite rejects `directUrl`), then:

- `npx prisma validate --schema <copy>` → **"The schema is valid 🚀"**
- `npx prisma migrate diff --from-empty --to-schema-datamodel <copy> --script` → **exit 0**,
  1367 lines of SQLite DDL, **64 `CREATE TABLE`** statements — one per model, all 95 indexes.

Incompatibility scan of the real schema — every category came back clean:

| Hazard | Grep | Finding |
|---|---|---|
| `@db.*` native types | `grep -n "@db\."` | **0 matches** |
| `Unsupported(...)` / pgvector | `grep -n "Unsupported("` | **0 matches** |
| Scalar arrays (`String[]` etc.) | regex over scalar types | **0 matches** — all 45 `[]` fields are relation lists (e.g. line 517 `steps OrchestratorStep[]`) |
| `Decimal` / `BigInt` / `Bytes` | grep | **0 matches** — money is `Int` cents throughout (`budgetCents`, `costCents`, `amountCents`) |
| `dbgenerated()` | grep | **0 matches** |
| citext / full-text index / `previewFeatures` | grep | **0 matches** |
| Enums (10) | — | Prisma 6.19.3 emits them as `TEXT` for SQLite; validate + diff both pass |
| `Json` (64 occurrences) | — | Supported; emitted as `JSONB` in the SQLite DDL (e.g. `OrchestratorStep.dependsOn`, `critique`, `toolCalls`) |

The **only** required edits for a SQLite datasource are the two datasource lines: `provider` and
removing `directUrl`.

Caveats that are runtime, not schema-level:
- Enums become plain TEXT — no DB-level constraint; Prisma enforces at the client layer only.
- `Json` on SQLite has no JSON-path filtering (`path:`/`array_contains`); any query using Postgres
  JSON filters must be re-expressed in application code. Worth grepping the orchestrator query
  layer before committing.
- Case-insensitive `mode: "insensitive"` string filters are Postgres-only and silently unsupported
  on SQLite.
- No concurrent writers — fine for a single CLI process, not for the BullMQ worker fleet.

### Recommendation: **(a) SQLite via a second Prisma schema**

Reasoning:
- It is empirically proven to work — 64/64 tables generate. Cost is ~2 changed lines plus a
  generate step, versus writing and maintaining a hand-rolled port.
- (b) better-sqlite3 behind a port interface means re-implementing ~6 models' worth of CRUD,
  indexes and cascade semantics by hand, and the CLI and web app then drift. Reach for this only
  if the JSON-filter caveat proves pervasive.
- (c) JSON files cannot express the `Company → Run → Step/Event` cascade or the `@@unique([runId,
  seq])` ordering guarantee without rebuilding a database badly; concurrency and partial-write
  corruption are real for a long orchestration run.
- (d) Requiring Postgres kills the "standalone CLI, no server" goal outright, and on this machine
  it is not even reachable — the Docker daemon is down.

Concretely: add `apps/cli/prisma/schema.sqlite.prisma` generated from the canonical schema by a
small script (sed the datasource block) so it can never drift, emit the client to a distinct
`output` path, and keep both behind one repository interface. Default the CLI to
`DATABASE_URL="file:~/.trent/trent.db"`. Keep the Postgres path for the server.

## 5. Prisma client singleton

File: **`/Users/bobbymeher/Desktop/trent/apps/web/lib/db.ts`** (12 lines; there is no
`lib/prisma.ts`).

```ts
 1  import { PrismaClient } from "@prisma/client";
 ...
 8  export const db = globalThis.__prisma ?? new PrismaClient();
10  if (process.env.NODE_ENV !== "production") {
11    globalThis.__prisma = db;
12  }
```

**Does importing it from a CLI process throw when `DATABASE_URL` is unset? No — not at import.**

Verified: `env -u DATABASE_URL npx tsx <script importing apps/web/lib/db.ts>` printed
`IMPORT_OK typeof db = object`. The constructor at **`apps/web/lib/db.ts:8`** is lazy.

It throws on **first query**:

```
QUERY_ERR: Invalid `prisma.$queryRawUnsafe()` invocation:
error: Environment variable not found: DATABASE_URL.
  -->  schema.prisma:7
```

So a CLI can safely import `db`, but must set `DATABASE_URL` (or construct its own client with an
explicit `datasources.db.url`) before any query. The failure mode is a runtime error deep in the
first orchestration step, not a fast startup failure — worth adding an explicit preflight check.

Second hazard for CLI reuse: **line 11 mutates `globalThis.__prisma`** whenever
`NODE_ENV !== "production"`, so a CLI importing this module inherits the web app's singleton and
cannot point a second client at SQLite in the same process. Prefer a CLI-owned factory over
importing `lib/db.ts`.

## 6. `apps/web/package.json`

Scripts of interest:

| Script | Value |
|---|---|
| `build` | `prisma generate && next build` |
| `test` | `vitest run --pool=forks --poolOptions.forks.singleFork=true` |
| `test:ci` | same + `--reporter=json --outputFile=artifacts/ci/vitest-results.json` |
| `lint` | `next lint` |
| `typecheck` | `tsc --noEmit --incremental false -p tsconfig.typecheck.json` |
| `dev` / `start` | `next dev` / `next start` |
| `worker` | `tsx lib/worker.ts` |
| `prisma:generate` / `prisma:migrate` | `prisma generate` / `prisma migrate dev` |

There are ~30 further `tsx scripts/evals/*` proof scripts and a very long
`preflight:perfection` chain that requires live provider credentials — not runnable here.

Relevant dependencies (declared):

| Package | Version |
|---|---|
| `next` | `^15.5.19` |
| `react` / `react-dom` | `^19.1.0` |
| `prisma` | `^6.8.2` (installed CLI resolves to **6.19.3**) |
| `@prisma/client` | `^6.8.2` |
| `bullmq` | `^5.77.2` |
| `openai` | `^4.103.0` |
| `@modelcontextprotocol/sdk` | `^1.29.0` |
| `@daytona/sdk` | `^0.189.0` |
| `e2b` | `^2.30.4` |
| `next-auth` | `^5.0.0-beta.28` |
| `zod` | `^3.25.28` |
| `tsx` | `^4.22.4` |
| `vitest` (dev) | `^3.2.6` |
| `typescript` (dev) | `^5.8.3` |

Notable absences:
- **`ioredis` is not a direct dependency.** It is present only transitively via `bullmq`
  (`node_modules/ioredis` → **5.11.1**). Any direct `import "ioredis"` relies on hoisting.
- **No Vercel AI SDK** (`ai`, `@ai-sdk/*`) and **no `@anthropic-ai/sdk`** — confirmed absent from
  `node_modules`. Model access goes through the `openai` client (v4) plus bespoke provider code.
- `playwright` `^1.60.0` is a **runtime** dependency, not a devDependency.

Root `/package.json` is an npm-workspaces monorepo (`packages/*`, `apps/*`) with
`test: vitest run`, `build: npm run --workspaces --if-present build`, and CLI entrypoints
`tsx apps/cli/src/index.ts`.
