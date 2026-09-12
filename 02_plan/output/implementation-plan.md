# Trent Fleet v2 — Implementation Plan (Superpowers Phase 3)

Written for an engineer with no project context and an aversion to testing. Follow it literally.
Every task is 2-5 minutes of work. **Do not skip the RED step.** A test that passes the first time you
run it is a broken test — fix the test before you touch any source.

Baseline: `02_plan/output/baseline.txt`. Branch: `feature/trent-fleet-v2`.
Design: `02_plan/output/design-doc.md`. Invariants: `AGENTS.md`.

## Before every task
```bash
cd /Users/bobbymeher/Desktop/trent
git rev-parse --abbrev-ref HEAD          # must print feature/trent-fleet-v2
```
## After every task
```bash
cd apps/web && npm test                  # must exit 0 — the existing app must never regress
cd .. && npx tsc --noEmit -p apps/web/tsconfig.typecheck.json
git add <explicit paths>                 # never `git add .`
git commit -m "<type>(<scope>): <hypothesis>"
```

---

# Milestone 1 — Core wrappers and the environment contract

## Task 1.1 — Prove the env contract stops double execution
**Why:** measured, not theoretical. Without `TRENT_QUEUE_FALLBACK=disabled` a 3-step run produced 31
worker invocations and fired `run_done` 10 times, while still reporting success.

- **Create** `packages/trent-core/src/runtime/env.test.ts`
- **RED test:** launch an orchestration offline with mock providers and assert `run_done` is emitted
  **exactly once** and each step exactly once.
- **Expected failure:** `expected 10 to be 1` (or the file does not exist yet).
- **Then create** `packages/trent-core/src/runtime/env.ts` exporting:
  ```ts
  export type StandaloneEnv = { TRENT_QUEUE_FALLBACK: "disabled"; REDIS_URL: ""; DATABASE_URL: string };
  export function applyStandaloneEnv(dbUrl: string): void;   // writes process.env BEFORE any lib import
  export function assertStandaloneEnv(): void;               // throws TrentError if violated
  ```
- **Verify:** `npx vitest run packages/trent-core/src/runtime` exits 0.
- **Commit:** `feat(core): standalone env contract that prevents duplicate job execution`

## Task 1.2 — Error taxonomy and exit codes
**Why:** `--json` on every command is meaningless without an error envelope (review finding E1).

- **Create** `packages/trent-core/src/errors/TrentError.test.ts`, then `TrentError.ts`.
- **Interface:**
  ```ts
  export type ExitCode = 0|2|3|4|5|6|130;   // ok, usage, config, auth, provider, budget, interrupt
  export class TrentError extends Error {
    constructor(opts: { code: ExitCode; operation: string; target?: string; context?: Record<string,unknown>; cause?: unknown });
    toJSON(): { error: { code: ExitCode; operation: string; message: string; target?: string; context?: Record<string,unknown> } };
  }
  ```
- **RED test:** asserts `toJSON()` never includes a key whose name matches `/key|token|secret|password/i`,
  even when such a key is passed in `context`.
- **Expected failure:** module not found.
- **Commit:** `feat(core): typed errors with exit codes and secret-safe serialization`

## Task 1.3 — Config manager rebuild (secrets must reach process.env)
**Why:** the kept implementation parses `.env` but never writes `process.env`, and `MODELS`/`MAX_TOKENS`
freeze at import time — so every model name silently falls back to a default.

- **RED test** `config/ConfigManager.test.ts`: write a secret to `~/.trent/.env` in a temp HOME, call
  `loadSecrets()`, assert `process.env.GEMINI_API_KEY` is populated; assert `config.yaml` is written
  atomically (temp file then rename); assert `.env` mode is `0600`; assert a `version` key exists.
- **Expected failure:** `expected undefined to be 'test-value'`.
- **Commit:** `fix(core): config manager writes secrets to process.env, atomically, with a version key`

## Task 1.4 — Model gateway wrapper: THE anti-pattern #1 test
**Why:** this is the test that proves the product is real.

- **Create** `packages/trent-core/src/model-gateway/ModelGateway.live.test.ts`
- **RED test**, `describe.skipIf(!process.env.GEMINI_API_KEY)`:
  stream `"Reply with exactly: PONG-7423"` and assert all four:
  1. more than one token frame arrived (real incremental streaming, not one blob),
  2. the joined output contains `PONG-7423`,
  3. the output does **not** match `/^Trent proxy response/` (the canned proxy literal at
     `ai-proxy/openai-compatible.ts:93`),
  4. `usage.outputTokens > 0`.
- **Expected failure:** `Cannot find module './index.js'`.
- **Then create** `model-gateway/index.ts` per `01_discovery/output/model-gateway-contract.md` §6.
  It must be an **async factory** that seeds `process.env` and then `await import()`s the real module.
- **Verify:** `npx vitest run packages/trent-core/src/model-gateway` exits 0 and the live test does
  **not** report as skipped.
- **Commit:** `feat(core): model gateway wrapper streaming real tokens from the live provider`

## Task 1.5 — Prisma SQLite store port
- Derive `schema.sqlite.prisma` from the canonical schema with a script (two-line datasource swap plus
  the `prisma-client` generator with `engineType="client"`, `runtime="bun"`). The script is the artifact;
  never hand-edit the derived file.
- Vendor the ~90-line `bun:sqlite` driver adapter with a version stamp. `startTransaction` issues
  `BEGIN`; `commit`/`rollback` only release the mutex.
- **RED test:** create a company, a run, a step and an approval; kill and reopen the client; assert all
  four are still readable and a cascade delete removes children.
- **Commit:** `feat(core): prisma-on-sqlite store with a vendored bun:sqlite adapter`

## Task 1.6 — Orchestrator wrapper with a real drain loop
- **RED test:** run offline with mock providers; assert `>= 3` steps, `> 1` distinct agent role, the
  event sequence contains `plan_end`, `step_start`, `step_end`, `consolidate_end`, and `run_done`
  appears exactly once.
- Implement per `01_discovery/output/orchestrator-contract.md` §7: async-iterable handle, injected ports,
  and the drain loop ported from `orchestration-eval-integration.ts:126-144`.
- **Commit:** `feat(core): orchestrator wrapper with async-iterable events and an owned drain loop`

## Task 1.7 — Wrap the remaining modules to satisfy anti-pattern #2
Thin typed re-exports: traces, evals, readiness, mcp, agent-catalog, marketplace.
Async factories with `skipLLM` honored: skills, gepa, heartbeat sweep.
- **RED test:** assert `@trent/core` transitively imports **>= 8** distinct files from `apps/web/lib/`,
  computed by reading the import graph, not hard-coded.
- **Commit:** `feat(core): wrap 12 lib modules, satisfying the 8-module floor`

---

# Milestone 2 — Doctor and setup (moved BEFORE the REPL by review)
**Why first:** the live test is `skipIf(!KEY)`. Without a doctor that proves a key with a real
authenticated call, a skipped test reads as green. That is the exact placeholder-key trap already found.

- **2.1** Credentials check that (a) validates key shape and (b) makes one cheap authenticated call.
  **RED test:** a 16-character `sk-ant-` placeholder must produce `fail`, not `ok`.
- **2.2** Replace the three lying checks. MCP pings configured servers; cron inspects real scheduler
  state; workbench probes the sandbox. Each RED test induces a failure and asserts the check reports it.
- **2.3** Database check per mode: `PRAGMA integrity_check` standalone, health endpoint connected.
- **2.4** `--fix` with copy-pasteable remediation; never touches credentials, never deletes data.
- **2.5** Setup wizard with real prompts: Quick, Full, Blank Slate. Blank Slate writes explicit
  `platform_toolsets.cli` and `agent.disabled_toolsets`.
- **2.6** `--json` on every command plus the error envelope from Task 1.2.

---

# Milestone 3 — REPL that talks to the fleet
Real streaming with agent-coloured prefixes from the 20-event bus. Budget ticker fed by real gateway
costs in integer cents. Ctrl+C aborts the in-flight stream and keeps the REPL alive — branch on
`signal.aborted`, never on `error.name`. Ctrl+J is the guaranteed newline; Alt+Enter also bound;
Shift+Enter only under the Kitty protocol, and the protocol must be popped on exit. Slash dropdown on
`/`. Approval cards that block until answered and survive a restart. An explicit offline-degraded banner
when no key is present, because the planner silently falls back to deterministic plans.

# Milestone 4 — TUI on the same session engine
# Milestone 5 — Installer: staged, checksummed, real download
# Milestone 6 — Desktop: Tauri v2 + vendored Bun runtime + standalone web build
# Milestone 7 — Width: gateway transports, TLS egress, Docker lifecycle, voice, ACP

Milestones 3-7 are expanded to task level when their milestone begins, so the tasks reflect what the
previous milestone actually produced rather than what was guessed months earlier.

---

## Definition of done for any task
1. The test failed first, for the expected reason.
2. It now passes, and `cd apps/web && npm test` still exits 0.
3. `npx tsc --noEmit` exits 0.
4. No file over 500 lines. No canned strings. No `--external` used to force a build.
5. Reviewed by someone who did not write it.
6. Committed with explicit paths and a message naming the hypothesis.
