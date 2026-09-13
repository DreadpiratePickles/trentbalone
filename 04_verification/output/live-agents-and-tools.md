# Live proof: agents run and call tools on `gemini-3.5-flash-lite` — 2026-09-12

Question answered: *"I want to know if the agents all run properly and they can call tools, put them on
gemini flash so it's cheaper."*

**Short answer.** Yes, with two qualifications that matter.

1. The agents run and a real tool call is provable end to end on `gemini-3.5-flash-lite`: the model
   emitted `{"toolCall":{"name":"memory:read","action":"count memory documents"}}`, the internal action
   executed against the store and returned `Read 4 memory document(s), including 3 semantic fact
   document(s).`, the next turn used that result, and it is recorded on `step.toolCalls`. Test
   `packages/trent-core/src/orchestrator/orchestrator.live.test.ts` asserts all of it: **6/6 pass, exit 0**.
2. With a Gemini-only key, **only the seat agents reach Gemini**. The planner, the critic and the
   consolidator are hard-wired to `OPENAI_API_KEY` and silently fall back (deterministic plan,
   auto-pass critic, literal summary). And the shipped REPL never tells the orchestrator which Google
   model to use, so as shipped every seat call 404s on the retired `gemini-2.0-flash`/`gemini-2.5-pro`
   and the REPL still prints `✓ Run complete`. Details and evidence below.

Raw machine-readable trace: `04_verification/output/live-agents-and-tools.trace.json`
(the API key was never captured; verified by grepping the file for it: `false`).

---

## 1. Exact commands

```
# Standalone env contract (TRENT_QUEUE_FALLBACK=disabled, REDIS_URL="", no DATABASE_URL) is applied
# by createOrchestrator() itself via applyStandaloneEnv(IN_MEMORY_DATABASE); assertStandaloneEnv()
# runs after. Every job therefore executes once (run_done seen exactly once, asserted).

cd /Users/bobbymeher/Desktop/trent
TRENT_TEST_LIVE=1 TRENT_LIVE_EVIDENCE_OUT=<scratch>/run-c.json \
  npx vitest run packages/trent-core/src/orchestrator/orchestrator.live.test.ts
#  ✓ packages/trent-core/src/orchestrator/orchestrator.live.test.ts (6 tests) 14607ms
#  Test Files 1 passed | Tests 6 passed          -> exit 0

npx vitest run packages/trent-core/src/orchestrator/      # default mode: live file excluded by root config
#  ✓ orchestrator.test.ts (8 tests)                -> exit 0

cd packages/trent-core && npx tsc -p tsconfig.json --noEmit  # 0 "error TS" lines
```

Environment the test imposes (values never printed): `NODE_ENV=production`, `GEMINI_API_KEY` from
`gem.env`, `GOOGLE_MODEL_FAST/DEFAULT/STRONG=gemini-3.5-flash-lite`, `MODEL_PREFERRED_PROVIDER=google`,
`MODEL_ALLOWED_PROVIDERS=google`, all other provider keys deleted, `GOOGLE_BASE_URL` pointed at a
loopback tracing proxy that forwards to `https://generativelanguage.googleapis.com/v1beta/openai/`
(the OpenAI SDK does not go through `globalThis.fetch`, so a fetch wrapper saw nothing in run A).

The company is seeded with 3 `memoryTier:"semantic"` documents; `createCompany` writes the brief as a
4th document. Read back from the store before the run: `{"total":4,"semantic":3}`.

Objective (worded to avoid `send`, see finding F4):

> Invoke the tool whose exact name is "memory:read" (toolCall {"name":"memory:read","action":"count
> memory documents"}) and report the exact number of memory documents this company has. Do not guess
> and do not count documents from context: the number must come from the tool result summary.

## 2. The run (run C, the one the test asserts on)

`runId orc_fo320pmx2tdj`, company `company_3bqx0ytq2o34`, status `completed`, wall **12,677 ms**
(includes seeding), 17 bus events, 4 provider calls, 3 steps, **2 distinct agent roles** (ceo, engineer).

Plan: `plan.reasoning = "LLM unavailable — using deterministic fallback plan."` — the planner did not
call any model (see F1).

### 2.1 Ordered event sequence from `__trentOrcBus` (all kinds)

```
 1. 00:08:24.638Z plan_start
 2. 00:08:24.667Z plan_end
 3. 00:08:24.672Z step_start        s1/ceo
 4. 00:08:27.232Z step_output       s1/ceo
 5. 00:08:27.232Z step_critic       s1/ceo      (verdict pass, "supervisor offline — auto-pass.")
 6. 00:08:27.232Z step_end          s1/ceo
 7. 00:08:27.236Z step_start        s2/engineer
 8. 00:08:29.072Z step_output       s2/engineer
 9. 00:08:29.073Z step_critic       s2/engineer
10. 00:08:29.073Z step_end          s2/engineer
11. 00:08:29.073Z step_start        s3/ceo
12. 00:08:30.456Z step_output       s3/ceo
13. 00:08:30.456Z step_critic       s3/ceo
14. 00:08:30.456Z step_end          s3/ceo
15. 00:08:30.458Z consolidate_start
16. 00:08:30.460Z consolidate_end
17. 00:08:30.461Z run_done                      <- exactly once (asserted)
```
`run_start` is emitted inside `launchOrchestration` before the subscription and is intentionally not
in the stream (wrapper comment, `orchestrator/index.ts`). No `run_failed`, no approval events.

`emitJobEvent` phases surfaced on the job feed: `plan_end "Plan ready — 3 steps"`, then
`agent_start` for `ceo → Scope objective…`, `engineer → Execute primary workstream with tasks:create`,
`ceo → Consolidate and surface the final artifact`, then consolidate. Full list in the trace JSON.

### 2.2 Provider trace (loopback proxy, all `POST /v1beta/openai/chat/completions`)

| seq | seat / turn | model | HTTP | ms | prompt tok | completion tok | model reply (raw `content`) |
|---|---|---|---|---|---|---|---|
| 1 | ceo, tool-use step 1 of 6 | gemini-3.5-flash-lite | 200 | 951 | 4107 | 39 | `{"toolCall":{"name":"memory:read","action":"count memory documents"},"summary":null}` |
| 2 | ceo, tool-use step 2 of 6 | gemini-3.5-flash-lite | 200 | 1442 | 4148 | 187 | `{"toolCall":null,"summary":"…The exact number of memory documents retrieved from the tool result summary is 4.", "findings":["The tool result for memory:read confirmed exactly 4 memory documents exist…"], …}` |
| 3 | engineer, step 1 of 15 | gemini-3.5-flash-lite | 200 | 1813 | 4175 | 400 | `{"toolCall":null,"summary":"…the exact count confirmed in the previous step's dependency output is 4.", …}` |
| 4 | ceo, step 1 of 6 | gemini-3.5-flash-lite | 200 | 1377 | 4470 | 238 | `{"toolCall":null,"summary":"Operating summary: …confirming a total count of 4 memory documents from the tool result summary…", …}` |

Prompt lines the model saw on call 1 (excerpt):
```
Seat: ceo
Available tools: memory:read, tasks:create, reports:create, approvals:request, Email, Stripe, PostHog,
  Sentry, Steel Browser, steel:scrape, steel:screenshot, steel:pdf, steel:sessions, Vault Memory,
  vault:read, vault:write, vault:graph, gitnexus:search, gitnexus:context
Tool-use step 1 of 6.
```
and on call 2:
```
Prior tool results (use these in your answer):
- memory:read("count memory documents"): [completed] Read 4 memory document(s), including 3 semantic fact document(s).
```

### 2.3 The tool-call proof (`step.toolCalls` on the `step_end` snapshot)

Where it is recorded: `runSeatAgent` (`apps/web/lib/seat-agent-loop.ts`) parses the JSON turn,
`executeNamedToolCall` resolves `memory:read` to an `internal_action` contract and calls
`runInternalAction` → `readMemory` (`apps/web/lib/internal-actions.ts:96`), which does
`store.listDocuments(companyId)`. The `ToolCallRecord` is pushed onto `toolCalls`, returned by
`executeStepWithRuntime` (`orchestrator-runtime.ts:1532-1597`), set on `step.toolCalls`
(`orchestrator-run-phases.ts:270`) and persisted with the `AgentExecution` (`store.saveExecution`).

```json
s1 (ceo) toolCalls:
[
  { "adapter": "memory:read", "action": "count memory documents", "status": "completed",
    "summary": "Read 4 memory document(s), including 3 semantic fact document(s)." },
  { "adapter": "platform_readiness", "action": "check", "status": "completed",
    "summary": "Platform readiness passed for this content/social/ads mission." }
]
s2 (engineer) toolCalls: []
s3 (ceo) toolCalls: [ platform_readiness/check only ]
```
`platform_readiness` is not model-invoked; `executeStepWithRuntime` appends it from `liveContext`
(`orchestrator-runtime.ts:1534-1545`). The only model-chosen tool call in the run is the `memory:read`
above. The tool's result (4 total / 3 semantic) matches the store exactly — asserted with `toBe` against
the read-back count, not against a guess.

### 2.4 Final consolidated output

`run.summary` = `"Run completed — see step outputs."` — the consolidator's **fallback literal**
(`consolidateRun` → `callText` → throws `OPENAI_API_KEY is not configured`; see F1). The real founder-facing
content lives in s3's output:

> Operating summary: The company has successfully executed the live proof objective, confirming a total
> count of 4 memory documents from the tool result summary. … Exact number of memory documents confirmed
> via previous execution steps is 4. No external integrations or risky write actions were triggered.

### 2.5 Cost and tokens (run C)

| step | role | model | tokens | app `costCents` |
|---|---|---|---|---|
| s1 | ceo | gemini-3.5-flash-lite | 8,481 (2 turns) | 15 |
| s2 | engineer | gemini-3.5-flash-lite | 4,575 | 2 |
| s3 | ceo | gemini-3.5-flash-lite | 4,708 | 9 |
| **total** | | | **17,764** | **26** |

All integers (asserted). **The `costCents` figures are not Gemini prices.** `estimateModelCostCents`
(`apps/web/lib/model-gateway.ts:194`) prices by *tier* — the ceo seat is routed to the `opus` tier
(1.5¢/1k in, 7.5¢/1k out), engineer to `sonnet` — regardless of provider. See §5.

## 3. REPL transcript (`apps/cli/src/repl/engine.ts` + `createOrchestrator()`, wired as `index.ts` does)

Harness: `ReplEngine` with `createTheme("none")`, `DEFAULT_CONFIG` (provider google / model
gemini-3.5-flash-lite), `MemoryStore`, `runner = orchestrator.run({companyId, objective, trigger:"manual", signal})`,
then `engine.submit(objective)`. Scratch runner (not committed): `<scratch>/repl-transcript.test.ts`,
`npx vitest run --root . --config <scratch>/vitest.scratch.config.ts`. Same seeded company, same objective.

### 3.1 As shipped — only `GEMINI_API_KEY` set, nothing else (what `trent` does today)

```
Ctrl+J for a newline, Enter to send
●
· Planning...
· Plan ready
● [CEO] Scope objective and identify the leverage points...
    Model returned an invalid tool-use turn.
    Model returned an invalid tool-use turn.
✓ [CEO] Scope objective and identify the leverage points
● [Engineer] Execute primary workstream with tasks:create...
    Model returned an invalid tool-use turn.
    Model returned an invalid tool-use turn.
✓ [Engineer] Execute primary workstream with tasks:create
● [CEO] Consolidate and surface the final artifact...
    Model returned an invalid tool-use turn.
    Model returned an invalid tool-use turn.
✓ [CEO] Consolidate and surface the final artifact
· Consolidating...
· Consolidated
✓ Run complete
●
```
stderr during the turn:
```
executeSeatModel(ceo/google): failed 404 status code (no body)
executeSeatModel(engineer/google): failed 404 status code (no body)
executeSeatModel(ceo/google): failed 404 status code (no body)
```
Steps: s1 model `gemini-2.5-pro` tokens 0, s2 `gemini-2.0-flash` tokens 0, s3 `gemini-2.5-pro` tokens 0.
Budget ticker: 0¢. Wall 2,897 ms. **Zero model output, zero tool calls, and the run reports success.**

### 3.2 With `GOOGLE_MODEL_FAST/DEFAULT/STRONG=gemini-3.5-flash-lite` (what the fix must make the default)

```
Ctrl+J for a newline, Enter to send
●
· Planning...
· Plan ready
● [CEO] Scope objective and identify the leverage points...
    Executed the CEO scoping objective by verifying the tool result for memory count (4 memory documents
    total, including 3 semantic fact documents) and defining success and risk for the current operating cycle.

    The memory:read tool confirmed exactly 4 memory documents exist in the company namespace.
    Provider readiness is mostly unavailable except for draft execution, meaning all external actions
    remain strictly gated.

    Proceed with internal operating plan scoping without relying on unconfigured external provider integrations.
    [same block printed a second time — see F6]
✓ [CEO] Scope objective and identify the leverage points
● [Engineer] Execute primary workstream with tasks:create...
    Reviewed the engineering domain boundaries and the founder's objective. Counting memory documents via
    memory:read … belongs to vault/operational or CEO analysis rather than code implementation, but since
    the previous step already established that exactly 4 memory documents exist … this goal is outside the
    core engineering domain (no code, no PRs, no tests needed).
    …
    [printed twice]
✓ [Engineer] Execute primary workstream with tasks:create
● [CEO] Consolidate and surface the final artifact...
    Operating summary: The company has exactly 4 memory documents recorded in its namespace (1 brief and
    3 seeded memory notes). No external integrations or code changes are required for this cycle.

    Total memory documents: 4 (comprising 1 company operating brief and 3 agent notes).
    …
    [printed twice]
✓ [CEO] Consolidate and surface the final artifact
· Consolidating...
· Consolidated
✓ Run complete
●
```
Steps: s1 ceo `gemini-3.5-flash-lite` 8,329 tok 15¢ with `toolCalls[0] = memory:read → "Read 4 memory
document(s), including 3 semantic fact document(s)."`; s2 engineer 4,395 tok 2¢; s3 ceo 4,567 tok 9¢.
Budget ticker after the turn: **26¢**. Wall 15,107 ms. stderr empty. `engine.context.runIds = []` (F5).

## 4. Findings — honest, in priority order

**F1. Only seat execution reaches Gemini. Planner, critic and consolidator are OpenAI-only.**
`callJson`/`callText` (`apps/web/lib/ai-client.ts:307,367`) throw `OPENAI_API_KEY is not configured`
unless an eval `createCompletion` override is injected; `orchestrator-runtime.ts:523` treats that as the
"benign offline" case and silently substitutes the deterministic fallback plan
(`"LLM unavailable — using deterministic fallback plan."`), an auto-pass critic
(`"supervisor offline — auto-pass."`), and the literal summary `"Run completed — see step outputs."`.
Evidence: 4 provider calls for a run with 3 steps and no plan/critic/consolidate call; the strings above
in the snapshot. Consequence: on a Gemini-only key the plan is always the canned 3-step
ceo/engineer/ceo shape and step quality is never checked. The wrapper's `createCompletion` port
(`OrchestratorDeps`) can carry planner+critic to Gemini via `createProviderChatCompletion("google", …)`,
but nothing wires it today and the consolidator has no port at all.

**F2. The shipped REPL sends every seat call to a retired Google model and calls the run a success.**
`resolveModelName(tier,"google")` (`ai-client.ts:72-75`) defaults to `gemini-2.0-flash` /
`gemini-2.5-pro`, which 404. `ClassicRepl.start()` (`apps/cli/src/repl/index.ts`) reads
`config.model = gemini-3.5-flash-lite` but never exports `GOOGLE_MODEL_*` / `MODEL_PREFERRED_PROVIDER`,
so the config value never reaches the orchestrator. `executeSeatModel` swallows the 404 into
`{error}` → `"Model returned an invalid tool-use turn."` → critic auto-passes → `✓ Run complete`.
Transcript §3.1 is the proof. Fix: map config → env in `packages/trent-core` before the first
`apps/web` import (the gateway's `seedEnv` already does this for the workbench vars, not for these).

**F3. Tool naming is fragile.** Run A (first attempt) the model returned
`{"name":"memory","action":"read"}`; `executeNamedToolCall` found no contract, no adapter, no
router fallback and recorded `Tool "memory" is not allowed for this seat.` (status `failed`). The seat
then answered "3" from the context bundle (the seeded docs are visible in `sourceDocuments`), i.e. a
correct-looking answer with **no successful tool call**. Only after the objective spelled the exact
name did the call succeed (runs B, C, REPL pinned). A resolver that accepts `name:action` split across
the two fields would remove this failure mode.

**F4. The fallback planner's approval regex fires on the word "send" in the objective.** Run B's
objective contained "(send toolCall …)"; `generateOrchestrationPlan` matched
`/\b(publish|send|merge|deploy|spend|charge|refund|withdraw|delete)\b/`, produced a 4-step plan with
`s2.needsApproval=true`, and the run parked at `run_awaiting_approval` after s1 (which had already made
the successful `memory:read` call). Not a bug in tool use, but a surprise for a user typing normally.

**F5. The REPL can never approve a step.** `engine.#afterEvent` records `runIds` only on `run_start`,
which the wrapper deliberately does not stream; `engineRunIds` is `[]` after both turns, so
`onApprovalAnswer` in `index.ts` returns early (`runId === undefined`) and `orchestrator.approve` is never
called. With F4 this means a "send…" objective would hang at the approval card.

**F6. Every step output is rendered twice.** `render.ts:174-179` prints `event.step?.output` for
`step_output` *and* `step_critic` (the critic event has no `detail`). Cosmetic, visible in §3.2.

**F7. No filesystem or shell tool exists for the seats.** The `file_ops`/`terminal` toolsets in
`config/defaults.ts` are a trent-core config concept only; the orchestrator's registry
(`apps/web/lib/tools.ts`) holds SaaS adapters (mostly `test_only` mocks), the Workbench Sandbox (needs
Daytona/E2B, `unavailable` under `NODE_ENV=production`), and the internal actions. That is why this
proof uses `memory:read` and not "read a file in the repo" — a seat cannot read a file in this build.

**F8. The default `tasks:create` route is a write action that needs approval.** The fallback plan's s2
title is "Execute primary workstream with tasks:create"; had the engineer seat obeyed it, the run would
have paused for approval (internal write actions are `approvalRequired`). It declined instead.

## 5. What "cheaper" means in numbers

Whole exercise (5 live runs: A, B, C, REPL as-shipped, REPL pinned):

| run | provider calls | tokens | app ledger (¢) |
|---|---|---|---|
| A (name split) | 4–5 (untraced) | 17,163 | 25 |
| B (paused on approval) | 2 | 8,518 | 15 |
| C (asserted) | 4 | 17,764 | 26 |
| REPL as shipped | 3 × HTTP 404 | 0 | 0 |
| REPL pinned | 4 | 17,291 | 26 |
| **total** | ~17 | **60,736** | **92** |

- **App-reported total: 92 integer cents.** This is what the REPL budget ticker would have charged.
- **Actual Google bill: $0** — the key is on the free tier; no 429 was hit during these runs.
- **One typical turn on this model:** ~4.1k prompt tokens (the seat system prompt + context bundle
  dominate; the objective is a few dozen tokens) and 40–400 completion tokens, ~1–1.8 s. A 3-step run
  is ~17–18k tokens and ~6–8 s of model time.
- The app ledger over-reports by roughly two orders of magnitude for this model: 26¢ per run comes from
  the Anthropic-tier table (ceo→opus 1.5¢/7.5¢ per 1k). Google's Flash-Lite tier is priced per
  million tokens at cents, not per thousand at cents — at the 2.5 Flash-Lite list rate ($0.10/M in,
  $0.40/M out) run C would be about **0.2¢**; confirm the 3.5 rate on Google's pricing page before
  quoting it. Either way: cheaper by ~100×, and `estimateModelCostCents` needs a Gemini row before the
  daily cap (1000¢) is meaningful on this provider.

## 6. Files

- Test (new, gated `TRENT_TEST_LIVE=1` + key, `describe.skipIf`, asserts ≥1 completed `memory:read` tool
  call whose summary equals the store's real count):
  `/Users/bobbymeher/Desktop/trent/packages/trent-core/src/orchestrator/orchestrator.live.test.ts`
- This report and its raw trace: `/Users/bobbymeher/Desktop/trent/04_verification/output/live-agents-and-tools.md`,
  `/Users/bobbymeher/Desktop/trent/04_verification/output/live-agents-and-tools.trace.json`
- No other source was modified. No git commands were run.
