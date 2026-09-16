# 2026-09-15 — T3.5 per-profile concurrent-run cap and `trent jobs failed|retry`

Branch `feature/trent-fleet-v2`. One agent, one task; other agents edit sibling files concurrently,
so nothing here is committed by this session.

## What was built

- `packages/trent-core/src/orchestrator/run-slots.ts` (new): `RunSlots`, a FIFO slot pool with
  `acquire(onQueued)` returning an idempotent release. `DEFAULT_MAX_CONCURRENT_RUNS = 2`.
- `packages/trent-core/src/orchestrator/index.ts`: `createOrchestrator({ maxConcurrentRuns })`.
  `run()` takes a slot before `launchOrchestration`; a queued run pushes one `heartbeat` frame
  (`runId: ""`, `detail: "queued: N ahead; max_concurrent_runs is <cap>"`) to the handle and the
  trace sink only, not to the bus hooks (they key state by run id). The slot is released in the
  `finished` finally, before overrides are cleared. A parked-on-approval run keeps its slot.
  `cancel()` on a run that never launched returns `true`.
- `packages/trent-core/src/config/schema.ts` + `defaults.ts`: `runtime.max_concurrent_runs`
  (int, positive, default 2). No version bump.
- `apps/cli/src/runtime/headless.ts`: passes `config.runtime.max_concurrent_runs` into
  `createOrchestrator` when set.
- `apps/cli/src/commands/groups/jobs.ts` (new) + registered in `commands/index.ts`:
  `jobs failed [--last N]`, `jobs retry <id> [--objective <text>]`. Both open the headless
  runtime (`ctx.overrides.gatewayRuntime` is the seam) because the store lists job rows per
  company and only that graph knows the company id.
- `docs/jobs.md` (new), `docs/configuration.md` (`runtime` block + section).

## Decisions

- Retry link: `StorePort.JobRunRecord` has no `metadata`, so the failed row's run id is read
  structurally when present; otherwise `--objective` is required (exit 3 with the hint). The new
  run is linked by an `orchestration_retry` row with `metadata: { retryOf, runId }` and a summary
  naming both. Widening `JobRunRecord` with `metadata` is out of scope (StorePort.ts not owned).
- A retry whose run fails exits 5 (PROVIDER), completed exits 0.

## Evidence

- RED: `npx vitest run packages/trent-core/src/orchestrator/orchestrator.concurrency.test.ts`
  -> `expected [ 'third started' ] to deeply equal []` (third run launched immediately), exit 1.
- RED: `npx vitest run apps/cli/src/commands/__tests__/jobs.test.ts` -> 9 failed, exit 2 (USAGE:
  no `jobs` command).
- GREEN: both files pass (2 + 9 tests), exit 0.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` exit 0.
- `npm --prefix packages/trent-core run build` exit 2 ONLY on
  `src/orchestrator/orchestrator.human.test.ts` (another agent's untracked RED test:
  `humanAnswers`, `answer`); with that one file excluded, core tsc exit 0.
- `node scripts/ci/repo-scan.mjs` exit 0.
- Full `npx vitest run`: see the final report of this session.
