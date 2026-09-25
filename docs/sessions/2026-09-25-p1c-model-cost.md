# P1-C model cost: cached tokens, pinned models, reasoning_effort (2026-09-25)

Wave P1 agent C (Opus, no subagents, no commits). Scope from the lead: `model-gateway/**`,
`config/sections/models.ts`, `governance/spend-ledger.ts` + `spend-report.ts`, the `usage` render,
the docs lines for keys added, and this log. Sources: 09-22 parity proposal 1, 09-23 proposal 4,
09-21 proposal 2. HEAD 1d1418c, branch feature/trent-fleet-v2; other agents edit the tree concurrently.

## Discovery (before any code)
- The default stream path for every OpenAI-compatible provider is `apps/web/lib/ai-client.ts`
  `streamOpenAiCompatibleChat` (read-only). It sends `stream_options.include_usage` for `openai` only,
  reads `prompt_tokens`/`completion_tokens` only, and has no way to carry `reasoning_effort`. So the
  three changes cannot be made in that function; they need a Trent-side streamer for `google`.
- There is no explicit per-request model in `GatewayStreamRequest` today: `provider?` forces one
  provider, `route.explicitModel` is the CONFIGURED model (WORKBENCH_EXECUTOR/PLANNER_MODEL), not a pin.
- Seat calls do not go through the Trent gateway at all: `apps/web/lib/model-gateway.ts`
  `executeSeatModel` calls `createProviderChatCompletion` (non-streaming, read-only), prices by TIER
  (`estimateModelCostCents`, Anthropic list: sonnet = $3/1M input) and its own fallback loop runs over
  the configured providers. `step_end.step.costCents` is that tier estimate and it is what
  `wireRunSpend` writes to the ledger. Nothing re-prices it (`grep priceCall` outside the gateway: 0).
- The STABLE tier is appended to `dynamicPrompt`, which `buildSeatUserPrompt` renders AFTER
  `Company/Seat/Objective/Boundaries/Context/Input` in the USER message; the system message is the
  seat's own prompt. So in the seat path the STABLE tier is not a provider-visible prefix across runs
  with different objectives.

## Live probes (raw, scratchpad script, key never printed; model gemini-3.5-flash-lite unless noted)
- Stream WITHOUT `stream_options.include_usage`: 0 usage frames -> every Google gateway call today is
  priced on the chars/4 estimate (`estimated: true`). WITH it: usage frames arrive.
- `reasoning_effort: "high"` on "17*23": prompt 16, completion 3, total 254. The 235 thinking tokens
  are in `total_tokens` only, not in `completion_tokens` (Gemini bills them as output).
- 11,018-token identical system prefix, 3 compat calls + 2 native calls within ~1 min on
  gemini-3.5-flash-lite: no `prompt_tokens_details` on compat, no `cachedContentTokenCount` on native.
  Same prefix on gemini-3.6-flash: native calls 1-2 no cache field; compat calls 3-4
  `prompt_tokens_details.cached_tokens: 8165` of 11,018. The field name is right; flash-lite did not
  cache in that window.
- Docs read 2026-09-25: https://ai.google.dev/gemini-api/docs/pricing (3.5-flash-lite input $0.30,
  cached $0.03; 3.5-flash $1.50 / $0.15; 3.6-flash $0.75 / $0.075 through 2026-12-31;
  2.5-pro $1.25 / $0.125; 2.5-flash $0.30 / $0.03), https://ai.google.dev/gemini-api/docs/caching
  (implicit caching on 2.5 and newer; minimum 4,096 tokens for 3.5-3.8 Flash, 2,048 for 2.5),
  https://ai.google.dev/gemini-api/docs/openai ("Thinking": reasoning_effort minimal|low|medium|high,
  and "none" for 2.5 models only; omitted = model default).
- Probe spend (raw scratchpad calls above, before any Trent code): ~4 cents (5 x 11k tokens on
  flash-lite at $0.30/1M, 2 x 11k native + 2 x 11k compat on 3.6-flash at $0.75/1M with 8,165 cached
  at $0.075/1M; the 3.5-flash 503s and 2.5-flash 404s are not billed).

## RED (tests written first; `TRENT_QUEUE_FALLBACK=disabled npx vitest run <files>` from the root)
- (1) cached tokens: `pricing.test.ts` 4 new tests fail (`cachedInputRatio` undefined, 30 not 9,
  300 not 75, 100 not 10); `ModelGateway.test.ts` "a usage frame with cached_tokens prices them at
  the cached ratio and the ledger row records them" fails (`cachedInputTokens` undefined), "no
  cached_tokens field means zero and full price" fails (undefined, not 0), thinking-tokens test
  fails; `spend-ledger.test.ts` new test fails (8165.9 not truncated); `spend-report.test.ts` sum
  test fails (undefined) and the zero-shape test fails (no `cachedInputTokens` key);
  `usage.test.ts` 3 fail the same way; `openai-compat.test.ts` fails to load (no module).
- (2) pin: `ModelGateway.retry.test.ts` "an explicit model fails with the provider error and no
  fallback attempt is made" fails (no error: anthropic answered), "a transient failure on a pinned
  model is retried on that model only" fails, "a default-resolved model still falls back" fails
  (no `pinned` field on the log), "fallback_on_pin true restores the chain" fails (pinned model
  ignored). The env-bridge test passed on RED (it only exercised the fallback half) and was tightened
  to first prove the pin holds with the bridge at `false`.
- (3) reasoning_effort: `ModelGateway.test.ts` "the body carries reasoning_effort when configured and
  omits it otherwise" fails with `400 status code (no body)`: the default google path was the app's
  SDK streamer, which ignored the injected fetch and sent the fake key to Google (400, unbilled);
  `call-policy.test.ts` fails to load (no module).
- Requirement change recorded (rulebook 11): `SpendTotals` gains `cachedInputTokens`, so the five
  strict zero/shape assertions in `spend-report.test.ts` and `usage.test.ts` now include
  `cachedInputTokens: 0`. Groups are unchanged (the lead asked for a total).

## GREEN
- New: `model-gateway/openai-compat.ts` (Google streamer: include_usage, cached + thinking tokens,
  reasoning_effort, ProviderHttpError on non-2xx and on an error chunk), `model-gateway/call-policy.ts`
  (REASONING_EFFORTS, env bridge TRENT_MODEL_FALLBACK_ON_PIN / TRENT_REASONING_EFFORT, planAttempts),
  `model-gateway/complete.ts` (complete() moved out of index.ts for the 500-line limit).
- `pricing.ts`: `cachedInputRatio` per row (Gemini rows 0.1 per Google's page), default 0.25, cached
  share priced on the table, override and tier paths; `gemini-3.6-flash` row added ($0.75/$3.75,
  promotional through 2026-12-31, noted).
- `index.ts`: google -> Trent streamer; `GatewayStreamRequest.model` pins; `pinned` on the
  provider_failed log; `cachedInputTokens` (always) and `reasoningTokens` (when > 0) on usage.
- `config/sections/models.ts`: `models.fallback_on_pin` (bool, absent = false) and
  `models.reasoning_effort` (enum, absent = omitted). `orchestrator/model-env.ts` bridges both.
  No per-seat override: the `models` block has per-TIER fields only, not per-seat ones.
- Ledger: `SpendRow.cachedInputTokens` (written only when > 0, truncated, negative refused);
  `orchestrator/run-hooks.ts` RunSpendUsage carries and sums it; `spend-report` totals sum it;
  `trent usage` text shows `N cached` only when non-zero, `--json` always has the total.
- Snapshot: `npx tsx scripts/dev/regen-snapshot.mjs` (exit 0) after adding both keys to
  `schema-split.input.json`; the diff against the snapshot other agents had already regenerated is
  exactly the two new keys under `models`.

## LIVE proofs (subshell `( set -a; source gem.env; set +a; TRENT_TEST_LIVE=1 npx vitest run <file> )`)
Cents are the gateway's own integer cents per call (rounded UP per call, so a sub-cent call meters 1).

### (1) prompt-cache.live.test.ts, profile default gemini-3.5-flash-lite: exit 1 (a REAL finding)
| call | input | cached | output | cents |
|---|---|---|---|---|
| STABLE-prefix call 1 | 10,542 | 0 | 2 | 1 |
| STABLE-prefix call 2 | 10,543 | **0** | 2 | 1 |
| seat layout call 1 | 10,592 | 0 | 29 | 1 |
| seat layout call 2 | 10,592 | 0 | 48 | 1 |
The main assertion (`second.cachedInputTokens > 0`) FAILS on the profile default and is left
failing. Together with the raw probes (5 more flash-lite calls, compat and native, 11k identical
prefix: no cache field at all), gemini-3.5-flash-lite showed no implicit-cache hit in 7 attempts.
Google's caching page lists minimums for 3.5-3.8 Flash and 2.5 Flash/Pro and does not list
Flash-Lite. So on the model every profile ships with, the STABLE tier's cacheability is worth 0 today.

### (1b) same file, contrast `TRENT_LIVE_CACHE_MODEL=gemini-3.6-flash`: exit 0
| call | input | cached | output | cents |
|---|---|---|---|---|
| STABLE-prefix call 1 | 10,542 | 0 | 167 | 1 |
| STABLE-prefix call 2 | 10,543 | **8,164** | 142 | 1 |
| seat layout call 1 | 10,592 | 0 | 252 | 1 |
| seat layout call 2 | 10,592 | **0** | 252 | 1 |
The tier ORDER works when the STABLE tier is the prefix: 77% of the second prompt was a cache hit.
The seat layout does not: the fleet-memory hook appends the tiers to `dynamicPrompt`, which
`buildSeatUserPrompt` renders after Company/Seat/Objective/Boundaries/Context/Input, so two
objectives diverge ~40 tokens in and 0 of ~11.4k stable-tier tokens were cached. Fixing it means
moving the STABLE tier ahead of the objective (the system message, or the head of the user message)
through the seat seam, which is orchestrator/fleet-memory work, not done here.

### (3) reasoning-effort.live.test.ts, gemini-3.5-flash-lite, one golden (bat and ball, answer 5): exit 0
| effort | input | output (billed) | of which thinking | cents | answer |
|---|---|---|---|---|---|
| low | 42 | 169 | 168 | 1 | 5 |
| high | 42 | 321 | 320 | 1 | 5 |
`high` spent 152 more output tokens (+90%) on the same golden; at this size both meter 1 cent. Before
this change neither number was visible: Google sent no usage frame, and even with one its
`completion_tokens` is 1 here (the thinking is only in `total_tokens`).

### Existing ModelGateway.live.test.ts through the new google path (gemini-3.6-flash)
First run: 2 pass, `complete()` got HTTP 429 "You exceeded your current quota" three times (the
streamer classified it `rate_limit` and retried twice, as designed); exit 1. Rerun a few minutes
later: 3/3 pass, exit 0; usage now real (`estimated: false`, 12 in, 86 out of which 79 thinking).

### Spend this session
- Gateway-metered: 4 (1, default) + 4 (1b) + 2 (3) + 2 + 3 (existing live suite, two runs) =
  **15 cents** metered; the true bill is lower because every sub-cent call rounds up to 1.
- Raw probes before the code: ~4 cents at list prices (not metered; estimated from the usage printed).

## Findings for the lead (not fixed here; outside the files this agent owns)
1. Seat calls never touch the Trent gateway: `executeSeatModel` (apps/web, read-only) prices by
   TIER at Anthropic list and `wireRunSpend` writes that to the ledger, so a flash-lite seat is
   metered at $3.00/1M input (sonnet tier), 10x its $0.30 list; cached tokens on seats cannot reach
   the ledger either. Planner/critic/consolidator gateway calls are not written to the ledger at all.
   The seam to fix both exists (`SeatModelExecutionInput.createChatCompletion` / the seat guard).
2. `models.fallback_on_pin` governs `GatewayStreamRequest.model`, which no production caller sets
   yet; seat fallback happens inside `executeSeatModel` over the configured providers, which this
   key cannot reach without the same seam. A cron pin (P1-D) that reaches seats via env tier
   variables is also outside it.
3. The profile default model does not implicitly cache (1 above). Either the default moves to a
   caching model, or the tier design's cost claim is recorded as zero on flash-lite.
4. The STABLE tier is not a prefix in the seat layout (1b above).

## Verification (from the repo root, TRENT_QUEUE_FALLBACK=disabled)
- `npx vitest run packages/trent-core/src/model-gateway packages/trent-core/src/governance
  packages/trent-core/src/config apps/cli/src/commands/__tests__ packages/trent-core/src/wrapped-modules.test.ts`
  -> exit 0, 73 files, 1433 tests. (An earlier run the same hour hit 5 failures from other agents'
  in-flight edits: P1-D's `connect-schema.test.ts` RED, and `audit`/`acp` subprocess tests failing on
  a transient `SecretsConfigSchema` import while P1-D moved that section; both re-ran green.)
- Neighbours: `npx vitest run packages/trent-core/src/orchestrator apps/cli/src/runtime
  packages/trent-core/src/tools/vision packages/trent-core/src/tools/media packages/trent-core/src/fleet-memory
  packages/trent-core/src/improve packages/trent-core/src/sessions apps/cli/src/repl` -> exit 0, 122 files, 885 tests.
- `cd packages/trent-core && npm run build` -> exit 0. `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.
  `node scripts/ci/repo-scan.mjs` -> exit 0. `docs-truth.test.ts` -> 11/11.
- Live: prompt-cache default exit 1 (finding), prompt-cache 3.6-flash exit 0, reasoning-effort exit 0,
  ModelGateway.live exit 0 on rerun. No secret value was printed: every live log grepped for the key
  prefix, 0 matches.
- Nothing committed, stashed or pushed.

## Coordinator decisions (after the first report) and the adjustment
- (a) The default model stays `gemini-3.5-flash-lite` (Bobby chose the cheap model). Its prompt-cache
  saving is recorded as ZERO: 0 cached in 9 attempts on 2026-09-25 (7 before, 2 in the run below).
- (b) `prompt-cache.live.test.ts` no longer goes red on a known model limitation. Its assertion runs
  on a model that caches (`gemini-3.6-flash`, overridable with `TRENT_CACHE_PROOF_MODEL`); a second,
  INFORMATIONAL case runs the profile default, logs input/cached/cents and prints
  `no cache hit on <model>: <n> input, 0 cached` without failing when cached is 0 (it still asserts
  the usage is real, not the chars/4 estimate). The seat-layout case stays, on the proof model.
- (c) Docs: `docs/configuration.md` (Conversation history; The three tiers) and `docs/brain.md` (the
  context-tier paragraph) no longer say "cacheable prefix". They say the tiers are ordered so a
  provider cache can hit the stable tier, give the 2026-09-25 numbers (0 cached on
  gemini-3.5-flash-lite; 8,164 of 10,543 on gemini-3.6-flash on the second call), and say that in
  seat prompts the stable tier follows the objective today, so it is not a shared prefix (follow-up 1).

### Adjusted live run (once): `TRENT_TEST_LIVE=1 npx vitest run .../prompt-cache.live.test.ts` -> exit 0, 3/3
| case | call | model | input | cached | output | cents |
|---|---|---|---|---|---|---|
| proof | 1 | gemini-3.6-flash | 10,542 | 8,164 | 124 | 1 |
| proof | 2 | gemini-3.6-flash | 10,543 | **8,164** | 210 | 1 |
| informational | 1 | gemini-3.5-flash-lite | 10,542 | 0 | 2 | 1 |
| informational | 2 | gemini-3.5-flash-lite | 10,543 | **0** | 2 | 1 |
| seat layout | 1 | gemini-3.6-flash | 10,592 | 0 | 252 | 1 |
| seat layout | 2 | gemini-3.6-flash | 10,592 | **0** | 267 | 1 |
Printed: `no cache hit on gemini-3.5-flash-lite: 10543 input, 0 cached`. The proof's call 1 also hit
(8,164): the implicit cache from the earlier run this evening was still warm. Spend: **6 cents**
metered; session total now 21 cents metered plus ~4 cents of raw probes.

## Follow-ups (recorded, NOT fixed here, per the coordinator)
1. **Stable-tier placement in seat prompts.** The fleet-memory hook appends the three tiers to
   `dynamicPrompt` (`packages/trent-core/src/fleet-memory/orchestrator-hook.ts`, `wrapSeatModel`,
   ~line 443), and `apps/web/lib/model-gateway.ts` `buildSeatUserPrompt` (~line 306, read-only)
   renders `Company/Seat/Objective/Boundaries/Tool guidance/Context/Input` BEFORE it, after the seat's
   own system prompt. Two objectives therefore diverge ~40 tokens in and 0 of ~11.4k stable-tier tokens
   cache (seat-layout case above). Fix direction: carry the STABLE tier ahead of the objective (the
   system message, or the head of the user message) through the seat seam
   (`packages/trent-core/src/orchestrator/seat-guard.ts` / `SeatModelExecutionInput.systemPrompt`).
2. **Seat ledger rows are tier-priced.** `apps/web/lib/model-gateway.ts` `executeSeatModel`
   (~line 204) prices every seat call with `estimateModelCostCents` (~line 194, Anthropic list per
   haiku/sonnet/opus tier), `step_end.step.costCents` carries that, and
   `apps/cli/src/runtime/headless-wiring.ts` `wireRunSpend` (~line 206) writes it through
   `packages/trent-core/src/orchestrator/run-hooks.ts` `recordRunSpend` to the ledger. A flash-lite
   seat is metered at $3.00/1M input on the sonnet tier against a $0.30 list; nothing re-prices it
   through `packages/trent-core/src/model-gateway/pricing.ts`, and seat cached tokens cannot reach the
   row. Planner/critic/consolidator gateway calls (`model-gateway/completion-port.ts`,
   `orchestrator/provider-ports.ts` `consolidateWithGateway`) reach no ledger row at all. Seam:
   `SeatModelExecutionInput.createChatCompletion` (installed via `orchestrator/index.ts` `installPorts`).
3. **Pin reach.** `models.fallback_on_pin` governs `GatewayStreamRequest.model`
   (`packages/trent-core/src/model-gateway/types.ts`, `call-policy.ts` `planAttempts`), which no
   production caller sets yet. Seat fallback runs inside `executeSeatModel`'s own provider loop over
   the configured chain (`apps/web/lib/model-gateway.ts` ~line 240), and a cron pin that reaches seats
   through the tier variables (`packages/trent-core/src/orchestrator/model-env.ts`) is outside it too.
   Same seam as follow-up 2.

## Verification after the adjustment (repo root, TRENT_QUEUE_FALLBACK=disabled)
- vitest set (model-gateway, governance, config, apps/cli commands __tests__, wrapped-modules) -> exit 0, 73 files, 1433 tests.
- `cd packages/trent-core && npm run build` -> exit 0. `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.
- `node scripts/ci/repo-scan.mjs` -> exit 0. Adjusted live test -> exit 0 (6 cents). Key prefix in every live log: 0 matches.
