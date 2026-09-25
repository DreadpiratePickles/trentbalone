# P2-8 spend truth: every cents figure a user sees is true (2026-09-25)

Opus agent, no subagents, no commits. HEAD 3061f90, branch feature/trent-fleet-v2; other agents edit
the tree concurrently. Source: docs/sessions/2026-09-25-p1c-model-cost.md follow-ups 2 and 3.
Owned: orchestrator/run-hooks.ts, apps/cli/src/runtime/headless-wiring.ts, model-gateway/pricing.ts
(additive), governance/spend-ledger.ts (additive), the two scoped apps/web files, their tests, a new
live test, the usage doc paragraph, this log.

## Investigation (before any code)

### (A) Can seat calls go through the wrapper's gateway? YES, and without touching apps/web at all.
- `apps/web/lib/orchestrator-runtime.ts:1494` already hands `runSeatAgent` the
  `executeSeatModelFn` from `runtime-eval-overrides`, and the wrapper installs its own there
  (`packages/trent-core/src/orchestrator/index.ts:200-211` `installPorts`).
- The wrapper's seat guard already forwards a `createChatCompletion` port into the app's
  `executeSeatModel` (`orchestrator/seat-guard.ts:116`; the app reads it at
  `apps/web/lib/model-gateway.ts:84` and calls it at `:238-241` instead of
  `createProviderChatCompletion`). In production that port is `undefined` (only tests set
  `deps.createChatCompletion`), so the app's non-streaming client answers and
  `estimateModelCostCents` (`:194`) prices it by TIER (sonnet = $3.00/1M input).
- A gateway-backed port there routes every seat ATTEMPT through `ModelGateway.complete`
  (Trent Google streamer with include_usage, cached tokens, redaction, retry, reasoning_effort, the
  pin policy inside the attempt), while the app's executor (prompt, JSON parse, semantic cache,
  provider loop) stays intact. Neither apps/web exception file is needed.
- What the port cannot change: the app still computes `costCents` by tier from the usage the port
  returns, so the wrapper must replace `SeatModelResult.costCents` (it already rewrites `output`
  in the same guard chain). The app's cross-provider loop still runs; each attempt is one gateway
  call pinned to the model the app resolved, so `fallback_on_pin` governs the attempt and the app's
  loop is the default-resolved fallback (unchanged behaviour for multi-key profiles).
- JSON mode: the gateway has no `response_format`; the port asks for JSON in the system message and
  isolates the object with `extractJsonObject`, exactly as the planner/critic port already does.
- The injected port disables the app's configured-provider filter (`model-gateway.ts:210-212`), so
  the port refuses an unconfigured provider itself, before any network call. `applyModelEnv` sets
  `MODEL_PREFERRED_PROVIDER`, so the chain starts at the configured provider.

### (B) Planner / critic / consolidator: observable, and never metered.
- Planner and critic: `callJsonWithFallback` / `callCriticJsonWithRepair` read
  `overrides.orchestration.createCompletion`; the wrapper installs `createCompletionPort(gateway)`
  (`index.ts:208`). Consolidator: the app's `consolidateRun` -> `callText` has no seam and is
  OpenAI-only; on a Google profile it returns the fallback literal and the wrapper writes the brief
  through `consolidateWithGateway(gateway)` (`provider-ports.ts`).
- All three return a `GatewayCompletion` with real usage, but `onCall` reports only ok/error and
  nothing records usage, so they reach no ledger row, no frame and no `trent run` total.
- Observable by metering the gateway object handed to those two ports, per run, in `drive()`.
- NOT observable: with an OPENAI key the app's own `callText` consolidator answers directly
  (`apps/web/lib/ai-client.ts` `callText`, called from `orchestrator-runtime.ts` `consolidateRun`);
  its usage never leaves apps/web. Recorded, not fixed (it would need `consolidateRun` to accept a
  port; `orchestrator-runtime.ts:1056`).
- The app's seat token counts are NOT char estimates: the non-streaming seat call reads
  `usage.total_tokens` (0 when absent, never chars/4). The chars/4 estimate is the gateway's STREAM
  path without include_usage, which P1-C already fixed for Google.
- Rounding: per-call round-up is what made a sub-cent call meter 1 cent; a 10-call flash-lite run
  would still read ~10 cents at list price. So the ledger prices EXACT micro-cents per call and
  rounds once per run pool (largest remainder across the rows), and the frames carry the same
  running total (ceil of the true running total), so `trent run` and `trent usage` agree.

## Design
1. `orchestrator/seat-gateway-port.ts` (new): the gateway-backed `createChatCompletion`, installed
   by default when no `executeSeatModelFn`/`createChatCompletion` dep is given. Returns real usage
   (+ `prompt_tokens_details.cached_tokens`) and the gateway's call record under `trent_usage`.
2. `orchestrator/spend-meter.ts` (new): wraps the app's seat executor so the result's `costCents`
   is the metered list price (seat pool, carried rounding), and meters the planner/critic
   (`planner` until the first seat call, `critic` after) and consolidator gateway calls.
   `consolidate_end` carries the orchestration charge (every surface already reads it there).
3. `run-hooks.ts`: `recordRunModelCall` (exact micro-cents per call from `pricing.ts`), frame
   charges for metered steps are skipped, rows allocated by largest remainder, `inputTokens`,
   `outputTokens`, `estimated` on rows.
4. `index.ts` (3 lines): install the port and the meter. Not on my owned list, not on the
   forbidden list, unmodified by anyone at the start of this session; flagged in the report.

## RED (tests first; `TRENT_QUEUE_FALLBACK=disabled npx vitest run <files>` from the root)
- `model-gateway/pricing.test.ts` 5 new: `priceCallMicroCents is not a function`.
- `governance/spend-ledger.test.ts` 3 new: 1 passed on RED (the append spread already kept unknown
  keys), 2 failed: a fractional `inputTokens` was not truncated; a negative/NaN count did not throw.
- `orchestrator/run-hooks.spend.test.ts` 9 new: `recordRunModelCall is not a function`.
- `orchestrator/seat-gateway-port.test.ts`, `orchestrator/spend-meter.test.ts`: fail to load (no module).
- `orchestrator/spend-truth.test.ts` (the fake app run through the REAL pipeline, gateway only):
  `Run failed: every model call failed: No model provider API keys are configured for the allowed
  provider chain` -- the seat call went to the app's own client, never to the wrapper's gateway.
- `apps/cli/src/runtime/headless.spend.test.ts` 1 new: `recordRunModelCall is not a function`.

## GREEN
- `model-gateway/pricing.ts` (additive): `priceCallMicroCents` -- the same override/table/local rules
  as `priceCall`, whole micro-cents rounded up per call, no round-up to cents; undefined = unpriced.
- `governance/spend-ledger.ts` (additive): `inputTokens`, `outputTokens` (written when known, zero
  included), `estimated` and `unpriced` (written only when true); non-negative counts enforced.
- `orchestrator/run-hooks.ts`: `recordRunModelCall` (exact micro-cents per call at the ANSWERING
  model's list price; seat calls return the cents newly due = true running total rounded up less
  what was charged), `takeOrchestrationCharge` (for `consolidate_end`: the whole run rounded up
  once, less what the seat frames charged), `CONSOLIDATION_FRAME`; a frame whose calls the meter
  holds is skipped by `recordRunSpend`; rows apportioned (largest remainder) to the run's exact
  total rounded up ONCE.
- `orchestrator/seat-gateway-port.ts` (new), `orchestrator/spend-meter.ts` (new),
  `orchestrator/index.ts` (+2 lines, 499 total), `apps/cli/src/runtime/headless-wiring.ts`
  (`wireRunSpend` names the frame).

## Live proof 1 (exit 0): $0.18 -- the seat port was NOT installed in production
Rows: planner/critic/consolidator present at list price (1/0/0) but content 3 and ceo 14 were
still tier-priced frames. Cause: production always passes `executeSeatModelFn` -- the improve
loop's skill injector (`apps/cli/src/commands/improve.ts:86-87`), a pass-through around the app's
real `executeSeatModel` -- and `index.ts` dropped the chat port whenever that dep was set. My offline
test had not mirrored production. RED added (`spend-truth.test.ts` "the production shape": run
failed "No model provider API keys are configured"), then fixed: the default port is installed
whenever no `createChatCompletion` dep is given; an injected executor that forwards its input hands
it to the app, and one that ignores it keeps its own figure (the meter only re-prices results the
port saw; the app's cached result object replayed with no call is 0, a cache hit).

## Live proof 2 (exit 0): $0.02, 5 rows
content 0 (6,008 in / 335 out), ceo 1 (7,067 / 270), planner 1 (3,996 / 481), critic 0 (955 / 82),
consolidator 0 (600 / 149): all gemini-3.5-flash-lite, google. Exact list: seats 0.5435 +
orchestration 0.3445 = 0.888 of a cent. Two separately rounded pools made that 2; changed to round
ONCE per run (requirement change inside this session, my own new tests only: `run_e` total 9 -> 8,
the end-to-end seat usage 4,000 -> 7,000 out so the seat carries the largest remainder; a new case
replays these live token counts and asserts 1 cent).

## Live proof 3 (final, exit 0): `trent run` $0.02; `trent usage --json` exit 0
Scratch TRENT_HOME, `( set -a; source gem.env; set +a; ... npx tsx apps/cli/src/index.ts run
"Write a one-line tagline for a neighbourhood bakery that opens at 6 am" --no-color )`, then
`trent usage --json` on the same home. Key prefix in the run log, usage JSON and stderr: 0 matches.
| seat | model | in | out | cents | exact list (micro-cents) |
|---|---|---|---|---|---|
| planner | gemini-3.5-flash-lite | 4,002 | 727 | 1 | 301,810 |
| content | gemini-3.5-flash-lite | 6,021 | 309 | 0 | 257,880 |
| critic | gemini-3.5-flash-lite | 2,282 | 152 | 0 | 106,460 |
| escalation | gemini-3.5-flash-lite | 6,224 | 285 | 0 | 257,970 |
| ceo | gemini-3.5-flash-lite | 7,101 | 326 | 1 | 294,530 |
| consolidator | gemini-3.5-flash-lite | 949 | 155 | 0 | 67,220 |
Exact total 1,285,870 micro-cents = 1.29 cents -> 2 cents; `usage --json` today/period: cents 2,
tokens 28,533, cachedInputTokens 0, rows 6. `trent run` printed $0.02 (frames: content step 1,
consolidate_end 1). Before (first-run transcript, same objective, HEAD 3061f90): $0.17, 13,677
tokens, 2 seat rows at the sonnet tier, no planner/critic/consolidator rows.
Spend this session (list price of the tokens): run 1 ~0.9, run 2 0.89, run 3 1.29 = ~3.1 cents
(the meters said 18 + 2 + 2; run 1 was still tier-priced). No other live calls.

## Verification (repo root, TRENT_QUEUE_FALLBACK=disabled)
- `npx vitest run packages/trent-core/src/orchestrator packages/trent-core/src/governance
  packages/trent-core/src/model-gateway apps/cli/src/runtime apps/cli/src/commands/__tests__/usage.test.ts
  apps/cli/src/commands/__tests__/budget.test.ts packages/trent-core/src/wrapped-modules.test.ts`
  -> exit 0, 59 files, 525 tests. (Earlier the same set failed only on P2-1's in-flight files:
  `child-run.test.ts`/`run.ts` importing a `child-run.js` not yet written, and its RED pin tests.)
- `cd packages/trent-core && npm run build` -> exit 0 (an earlier run hit one error in
  `cron/CronRunner.test.ts`, another agent's in-flight edit; green on rerun).
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0. `node scripts/ci/repo-scan.mjs` -> exit 0.
- apps/web: not touched (neither exception file was needed), so no web typecheck was run.
- Neighbours (commands __tests__, fleet-memory, improve, repl, tui, agent-runner, heartbeat, cron,
  gateway): 6 failures, none in files I touched: `docs-truth` command counts [34,146] vs [35,151]
  (failing identically before my doc edit), P2-7's new `orchestrator-hook.stable-first.test.ts`,
  P2-6's new `improve/docs-corpus.test.ts`.

## Follow-ups (recorded, not fixed here)
1. `trent usage` text does not name `estimated`/`unpriced` rows: the render is
   `apps/cli/src/commands/groups/usage.ts` `renderTotals` (commands/** was off-limits), and a count
   in `governance/spend-report.ts` `SpendTotals` changes the strict shape assertions in
   `usage.test.ts`/`spend-report.test.ts`.
2. With an OPENAI key the app's own consolidator answers through `callText` and is unmetered;
   metering it needs `consolidateRun` (`apps/web/lib/orchestrator-runtime.ts:1056`) to take a port.
3. Pin reach: each seat attempt is a gateway call pinned to the model the app resolved, so
   `fallback_on_pin` governs the gateway's fallback inside an attempt, but the app's own
   cross-provider loop (`apps/web/lib/model-gateway.ts` ~236-260) still runs on a multi-key
   profile. A run pin could make the seat port refuse attempts after the first (P2-1 owns the signal).
4. `runtime-eval-overrides` is process-global (pre-existing): two concurrent runs overwrite each
   other's ports, so the second run's meter would receive the first run's later seat calls, as the
   seat tally already does. Delegated child steps meter under the parent run; not separately tested.
5. Seats no longer send `response_format: json_object` (the gateway has none); JSON is asked in the
   system message and isolated with `extractJsonObject`. Three live runs parsed every turn; watch it.
6. The app's analyst semantic-cache hit now meters 0 cents (it re-reported the original tier cost).
