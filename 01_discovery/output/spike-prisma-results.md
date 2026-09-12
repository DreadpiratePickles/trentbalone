# Spike: Prisma inside a Bun-compiled binary — VERDICT: IT WORKS

The earlier claim ("Prisma cannot go in the binary") was generalized from a `better-sqlite3`
experiment and is **falsified**. Every failure observed is the *driver*, never Prisma.

## Proven
A `bun build --compile` binary, executed from `/` with `node_modules` renamed away, ran real Prisma
queries against SQLite: creates, relation includes, Json and Json?, enum, `$transaction` (array AND
interactive), `$queryRaw`, and `onDelete: Cascade`. **Exit code 0.**

| runtime | adapter | result |
|---|---|---|
| Node | better-sqlite3 | pass |
| Node | libsql | pass |
| Bun | better-sqlite3 | FAIL — Bun cannot dlopen it |
| Bun | libsql | pass |
| compiled | libsql | build ok, run FAIL — native module not embedded |
| compiled | better-sqlite3 | build ok, run FAIL |
| **compiled** | **custom bun:sqlite adapter** | **PASS, exit 0** |

## What it costs
- Prisma 6.16.0 GA stabilized `driverAdapters` + `queryCompiler`; no preview flags. Becomes default in v7.
- Requires the NEW generator: `generator client { provider = "prisma-client", engineType = "client",
  runtime = "bun" }` — `engineType` does not work with the old `prisma-client-js`.
- No official `bun:sqlite` adapter exists, so we write one: **~90 lines** implementing
  `SqlDriverAdapter` over `bun:sqlite`, reusing Prisma's own conversion helpers.
  Two semantics matter: `startTransaction` must issue `BEGIN` itself, and `commit`/`rollback` must
  ONLY release the mutex — with `usePhantomQuery: false` Prisma sends COMMIT/ROLLBACK itself, and
  doubling them yields P2028.
- Binary size cost: **2.7 MB** (62.2 MB empty Bun binary -> 65.1 MB with Prisma + client + adapter).
- No `.node` and no `libquery_engine*` embedded — the Rust engine is genuinely gone.

## Why this changes the design
It collapses the invented second persistence tier. We keep ONE schema, real cascades, real
transactions, generated types, and `prisma migrate` — instead of hand-maintaining a parallel 64-model
DDL against a schema that will keep moving.

**Crucially it also answers reviewer finding C-1**: we can now persist OrchestratorRun / Step / Event /
Approval / JobRun to local SQLite using the real models, so `--continue` can genuinely resume a run
rather than just replaying a transcript.

## Schema derivation
The canonical schema needs no model changes: 0 `@map`/`@@map`, 0 `@db.*`, 0 Decimal/Bytes/Unsupported,
0 scalar lists. A second generator block is NOT enough (provider is per-datasource, and you cannot have
two datasources), so CI derives `schema.sqlite.prisma` by a mechanical two-line datasource swap plus
the new generator block. Neither `$metrics` nor `relationLoadStrategy` — the two known client-engine
gaps — appears anywhere in the repo.

## Risks accepted
1. **The adapter is ours.** Prisma does not test against bun:sqlite. It needs its own test suite, re-run
   on every Prisma bump.
2. **Vendored internals.** The conversion helpers were lifted from a bundled dist; stamp the version and
   diff on upgrade. A silent coercion change would surface as wrong values, not a crash.
3. Prisma v7 will rename config.
4. **Migrations at runtime**: `prisma migrate` needs the schema-engine binary, which will not be in the
   CLI. Embed migration SQL and apply via `executeScript`.
5. **Only darwin-arm64 was executed.** Cross-target binaries must be RUN in CI before we promise them.

Fallback if risk 1 is rejected: ship the CLI as a Bun script with node_modules (where the official
better-sqlite3 adapter works today) — NOT the hand-written tier.

## Housekeeping
Repo untouched; `grep -c bun ~/.zshrc` still 0.
