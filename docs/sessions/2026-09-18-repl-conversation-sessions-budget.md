# 2026-09-18 — A0.1: REPL conversation, sessions, budget stop, session export

Branch `feature/trent-fleet-v2`, from HEAD `c9de8bf`. `TRENT_QUEUE_FALLBACK=disabled` in every shell.
Closes shortfalls 1, 2 and 4 of `01_discovery/output/harness-parity-audit-2026-09-18.md` section D,
plus the unreachable `SessionExport` runner-up.

## What was wrong

- `repl/engine.ts` `#runTurn` started a fresh orchestration run per line; `OrchestratorRunOptions`
  took an objective only, so a follow-up referred to nothing.
- `repl/index.ts:101` called `resumeLastSession()` and discarded it; the REPL never wrote a session.
- `repl/budget.ts` only warned; nothing refused a turn at 100% of `daily_cap`.
- `telemetry/session-export.ts` was tested and unreachable from the CLI.

## RED, then GREEN

| Test | RED observed | Now |
|---|---|---|
| `repl/__tests__/conversation.test.ts` | `Cannot find module '../conversation.js'`, then `histories[1]` was `[]` | 9 pass |
| `repl/__tests__/continue.test.ts` | no recap on screen; `listSessions()` returned `[]` | 3 pass |
| `fleet-memory/prelude-history.test.ts` | prelude contained the memory blocks and no transcript | 3 pass |
| `commands/__tests__/sessions.test.ts` | `sessions export` exited 2 (unknown command) | 5 pass |
| `apps/web/lib/model-gateway.test.ts` (new case) | `expected 1 to be 2`: a cached analyst result was served to a different `dynamicPrompt` | 10 pass |
| `gateway/agent-handler.test.ts` (new cases) | thread history never reached the run | 9 pass |

## Decisions worth remembering

- The transcript is rendered **after** the frozen fleet-memory prelude (`orchestrator-hook.ts`
  `buildPrelude`), so the cacheable prefix stays byte-stable across turns. It rides as a message
  list on `OrchestratorRunOptions.history`, never flattened into the objective.
- The session file is created on the **first turn**, not at launch, so opening and closing the REPL
  leaves no empty session.
- An interrupted turn is persisted with `metadata.status = "interrupted"` and is never re-threaded;
  `--continue` filters those out when seeding.
- `SessionMessageMetadata` gained `run_id`, `tokens_total` and `status`. `tokens_total` exists
  because the run stream reports one number per step and never a prompt/completion split — writing
  `tokens` would have meant inventing the two halves.
- `bindApprovalAnswers` / `ApprovalTarget` / `GateAnswer` moved from `engine.ts` to `approvals.ts`
  (re-exported) to keep `engine.ts` under the 500-line rule: it is 486.

## The 500-line ceiling on `orchestrator/index.ts`

`run-hooks.ts` was extracted (open/close the per-run scope: the fleet-memory prelude and the
delegation ledger), so this task's net effect on `orchestrator/index.ts` is **0 lines**: HEAD 495,
`git diff -U0` shows my three hunks at +1 (import), 0, -1. The file is 512 because the concurrent
D-7 provider-routing change adds +17 (`applyModelEnv` guard, `EXIT`/`TrentError` import). The
`wrapped-modules` 500-line assertion fails on that overflow, not on this one.

## Verification (exit codes measured, not assumed)

```
npx vitest run apps/cli/src/repl packages/trent-core/src/sessions \
  apps/cli/src/commands/__tests__/sessions.test.ts apps/cli/src/gateway \
  packages/trent-core/src/fleet-memory packages/trent-core/src/orchestrator/orchestrator.test.ts
    32 files, 219 tests passed                                        exit 0
npx tsc --noEmit -p apps/cli/tsconfig.json                            exit 0
npm --prefix packages/trent-core run build                            exit 0
node scripts/ci/repo-scan.mjs                                         exit 0  (canned/hex/emoji all PASS)
npx vitest run --reporter=dot    1919 passed | 27 skipped | 1 failed  exit 1  (the ceiling above)
cd apps/web && npm test          2793 passed | 125 skipped           exit 0
```

## Pre-existing, not mine

`npx tsc --noEmit -p apps/cli/tsconfig.json` reports one error in
`packages/trent-core/src/model-gateway/index.ts:243` (`unpriced` missing). That file and
`model-gateway/types.ts` are another agent's in-flight work in the shared tree; stashing their
`types.ts` moves the error to their `pricing.ts`, so none of it is this task's.

Related finding, deliberately NOT fixed: `cacheKeyForSeatModel` still omits `toolLoopContext`, so an
analyst step's tool loop can be served its own first iteration. Same defect class, separate change.
