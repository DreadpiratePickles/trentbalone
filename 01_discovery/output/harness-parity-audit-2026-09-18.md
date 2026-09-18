# Harness and Hermes-parity audit — 2026-09-18

Read-only audit of the agent LOOP/HARNESS and of Hermes feature parity.
Branch `feature/trent-fleet-v2`, HEAD `0572c51`. Nothing was modified except this file.

Scope: `apps/cli/`, `packages/trent-core/`, and the parts of the read-only `apps/web/lib/` the
wrapper drives. The fleet/memory/self-improvement side is another agent's remit and is only cited
where it changes the prompt or the loop.

Evidence rule used throughout: a claim is `REAL` only when a test exercises the behaviour, not the
string. Where a test asserts a hard-coded literal it is called out, because `AGENTS.md:4` says a
test that asserts a hard-coded string is not a test.

Executable evidence run for this audit:

```
npx vitest run packages/trent-core/src/a2a/A2A.test.ts packages/trent-core/src/acp/ACPServer.test.ts --reporter=dot
  Test Files  2 passed (2)   Tests  5 passed (5)          # exit 0
TRENT_QUEUE_FALLBACK=disabled npm run cli -- --help        # exit 0; 24 commands, listed in C.5
```

---

## A. THE AGENT LOOP

### A.0 One REPL turn, end to end

| # | Step | File:line |
|---|---|---|
| 1 | `trent` with config present returns `launch: "repl"` | `apps/cli/src/commands/index.ts:283` |
| 2 | binary constructs `ClassicRepl`, passes `-c/--continue` | `apps/cli/src/index.ts:36-41` |
| 3 | `start()`: config + secrets into `process.env`, degraded probe, boot animation | `apps/cli/src/repl/index.ts:104-124` |
| 4 | builds the headless object graph (store, tools, fleet memory, improve, orchestrator, company) | `apps/cli/src/repl/index.ts:130-139` -> `apps/cli/src/runtime/headless.ts:187-278` |
| 5 | the turn runner is one orchestrator run per submitted line | `apps/cli/src/repl/index.ts:150`; `apps/cli/src/runtime/headless.ts:272-273` |
| 6 | raw mode + Kitty protocol, stdin bytes -> `KeyDecoder` | `apps/cli/src/repl/index.ts:189-218` |
| 7 | `submit()` -> slash command, `/stop`, double-text policy, or `#runTurn` | `apps/cli/src/repl/engine.ts:332-351` |
| 8 | `#runTurn` iterates the event stream under an `AbortController` | `apps/cli/src/repl/engine.ts:378-406` |
| 9 | wrapper `run()`: slot acquire, env writes, `wireSeatTools`, `launchOrchestration`, synthetic `run_start` | `packages/trent-core/src/orchestrator/index.ts:316-386` |
| 10 | bus subscribe + drain loop | `packages/trent-core/src/orchestrator/index.ts:406-418`, `:143-172` |
| 11 | phase worker -> `runSeatAgent` tool loop | `apps/web/lib/seat-agent-loop.ts:223`, loop at `:282-447` |
| 12 | seat executor wrapped: human hook -> delegate -> fleet prelude -> seat guard | `packages/trent-core/src/orchestrator/index.ts:246-252` |
| 13 | planner/critic go through the gateway completion port | `packages/trent-core/src/model-gateway/completion-port.ts`; installed at `index.ts:249` |
| 14 | gateway streams from the real provider | `packages/trent-core/src/model-gateway/index.ts:89-120`, `:157-264` |
| 15 | tool call -> `TrentToolAdapter.execute` via policy + idempotency dispatch | `packages/trent-core/src/tools/index.ts:135+`, `governance/policy-dispatch.ts`, `governance/idempotent-dispatch.ts` |
| 16 | events shaped (`PortShaper`, `shapeEvent`) then delivered to trace sink, improve hook, channel | `packages/trent-core/src/orchestrator/index.ts:328-332`, `:406-412`; `seat-guard.ts:143-164` |
| 17 | REPL renders each event; budget recorded; approval gates block input | `apps/cli/src/repl/engine.ts:385-428`, `:431-474`; `apps/cli/src/repl/render.ts` |

Tests: `apps/cli/src/repl/__tests__/orchestrated.test.ts:109` (a run whose every model call 404s
renders as a failure) and `:123` (an approval gate is opened and `y` calls `approve(runId, stepId)`);
`packages/trent-core/src/orchestrator/orchestrator.test.ts:120-205`;
`apps/cli/src/runtime/headless.test.ts:130-343`.

**Structural fact that shapes everything below: a "turn" is a whole orchestration run, and the REPL
keeps no conversation.** `ReplEngine` holds a transcript of *rendered lines* only
(`engine.ts:140-142`). Nothing carries message history from turn N into turn N+1. Continuity is
attempted entirely through fleet memory's per-run prelude and cross-run recall
(`packages/trent-core/src/fleet-memory/orchestrator-hook.ts:92-108`), which is retrieval, not a
transcript. Ask a follow-up question that depends on the previous answer and the only path back to it
is lexical recall over stored step outputs.

---

### A.1 Context-window management

| Question | Answer | Evidence |
|---|---|---|
| Compaction / summarisation when context fills | **None.** | `grep -rni "compact\|summariz\|context.window\|contextWindow\|token.budget\|maxContext"` over `apps/cli/src` + `packages/trent-core/src` returns only `ui/frame.ts` string truncation, `ui/banner.ts` `COMPACT_BELOW_WIDTH`, and prose in comments. No compaction module exists. |
| Token counting | Only a 4-chars-per-token estimate used to synthesise a *usage* frame when a provider emits none. | `packages/trent-core/src/model-gateway/index.ts:70-73`, used at `:237-240` |
| Truncation policy | Per-tool-output only: `fitSummary` at 24,000 chars with spill to `<profile>/cache/spillover/` (15,000 for browser, 15,000 for web, 6,000 for `skills_list`). Nothing truncates the *prompt*. | `packages/trent-core/src/tools/spillover.ts`; `tools/skills/schemas.ts:4` |
| Prompt caching | **None.** No `cache_control`, no `ephemeral` blocks, no provider cache headers. The only nod to caching is that the fleet-memory prelude is frozen per run so a prefix *could* cache. | `grep -rn "cache_control\|prompt.cach"` -> 0 hits; `fleet-memory/orchestrator-hook.ts:7-8` comment |
| What actually bounds the prompt | Three ceilings, all on *inputs*: memory blocks 2200 + 1375 + 1500 chars (`tools/memory/blocks.ts:31,38,45`), recall 3000 chars (`fleet-memory/config.ts:24`), tool history is every prior `ToolCallRecord` of that step re-sent each iteration (`apps/web/lib/seat-agent-loop.ts:291-294`). `MAX_TOKENS` on the *output* is frozen at import (`apps/web/lib/ai-client.ts:109`); the wrapper's own default is 4096 (`model-gateway/index.ts:67`). |
| So what happens when it fills? | The provider errors. The seat loop turns that into `error` on the result; the seat guard tallies it; if *every* call in the run failed, the wrapper rewrites the run to `failed` with the provider's message (`orchestrator/index.ts:266-285`). A partial overflow just fails that step. |

**Verdict: no context management of any kind.** A long-running step grows its own prompt
monotonically (tool history is cumulative within the step, capped only by `maxSteps` = 6, or 15 for
engineer/analyst — `apps/web/lib/seat-agent-loop.ts:83-85,579-583`), and a long-running *session*
does not grow at all because there is no session context. Both failure modes exist for opposite
reasons.

Test that proves the behaviour: **no test.** No test asserts a compaction, a token budget, or a
prompt-size ceiling.

---

### A.2 Session persistence and `--continue`

| Aspect | Finding | Evidence |
|---|---|---|
| Where sessions live | `<profileDir>/sessions/` — `~/.trent/sessions/` for `default`, `~/.trent/profiles/<name>/sessions/` otherwise. One JSON per session, schema v2, migrated on every read. | `config/ConfigManager.ts:80-81`; `sessions/SessionStore.ts`; `sessions/schema.ts:16,130-164` |
| What a session record holds | `messages[]` (role, content, agent, timestamp, metadata incl. `cost_cents`, `tokens`, `tool_calls` names/args/result), `total_cost_cents`, `total_duration_ms`, status, title. | `sessions/schema.ts:18-58` |
| **Does the REPL write sessions?** | **No.** `ClassicRepl` constructs a `SessionManager` and never calls `startSession` or `appendMessage`. | `apps/cli/src/repl/index.ts:92-101`; `grep -rn "appendMessage"` finds only the gateway handler, the TUI hook and tests |
| **What `--continue` restores** | **Nothing.** `resumeLastSession()` is called and its return value is discarded; `#sessions` is never read again in `start()`. No messages, no tool results, no approvals, no working directory. | `apps/cli/src/repl/index.ts:101` |
| What *is* restored across restarts | (a) pending approvals, from the SQLite store, re-rendered as cards at boot (`engine.ts:192-202`); (b) the run index for `/wiki` (`repl/memory.ts:16-42`); (c) fleet memory files on disk. None of this is the conversation. | `apps/cli/src/repl/__tests__/approvals.restart.test.ts:68-81` |
| Which surface *does* write sessions | The messaging gateway handler (`apps/cli/src/gateway/agent-handler.ts:78,98,104`) and the TUI hook (`apps/cli/src/tui/hooks/useSession.ts:14-31`). The REPL — the primary surface — does not. |
| Listing | `trent sessions list [--limit n]` | `apps/cli/src/commands/groups/sessions.ts:30-58` |
| Search | **Absent.** No search over sessions. `/wiki [query]` searches *runs*, not sessions. | `repl/commands.ts:196-218`; `grep` for a sessions search command -> none |
| Export | `SessionExport` exists in core (`telemetry/session-export.ts`, `includeContent: false` by default, redacted) but **no CLI command exposes it**: `sessions` has `list`, `resume`, `prune` only. | `commands/groups/sessions.ts:29-127` |
| Fork | **Absent.** `grep -rni "fork"` over the CLI -> no session fork. |
| Prune | `trent sessions prune --max-age-days --max-count`, active session exempt. | `sessions/SessionManager.ts:74-79` |

Test that proves `--continue`: **no test.** `grep -rn "continueSession"` returns only production
wiring; `apps/cli/src/repl/__tests__/boot.test.ts` does not exercise it. `SessionManager.test.ts:84`
tests `resumeLastSession()` in isolation, which is not the same claim.

---

### A.3 Streaming and interrupt

| Aspect | Finding | Evidence |
|---|---|---|
| Streaming granularity | **Event-level, not token-level.** The bus carries 20 event kinds; none is a token. `step_output` arrives whole. | `01_discovery/output/orchestrator-contract.md` ("Event stream"); `packages/trent-core/src/orchestrator/types.ts:18` |
| Where tokens *do* stream | Inside the gateway (`model-gateway/index.ts:157-264`) and then immediately re-accumulated by `complete()` (`:266-298`) before the planner/critic port returns. The seat path goes through the app's `executeSeatModel`, also non-streaming to the caller. |
| Consequence | The user sees `[Engineer] Reading files...` then a pause then a whole paragraph. There is no visible first-token latency improvement. |
| Ctrl+C semantics | Bound as a **key**, not a signal, because raw mode clears ISIG. First press with a run in flight aborts it and returns the prompt with the process alive; a press with nothing running exits 130. During the boot animation it exits 130 cleanly. | `repl/interrupt.ts:63-81`; `repl/engine.ts:131-135`, `:226-228`; `repl/index.ts:38` |
| Abort correctness | Branches on `signal.aborted`, never on `error.name` — an abort carrying a reason is not named `AbortError`. | `repl/interrupt.ts:23-25`; `repl/engine.ts:393-399`; `model-gateway/index.ts:227-234` |
| Abort propagation | The signal reaches the drain loop (`orchestrator/index.ts:325-326, 414-418`) and the gateway's `for await` (`model-gateway/index.ts:206-209`), whose `break` calls the upstream generator's `return()`. An in-flight HTTP call to the provider is **not** cancelled — there is no `AbortSignal` on the upstream fetch (`01_discovery/output/model-gateway-contract.md` trap 5). |
| Cleanup on exit | `runtime.cleanup()` runs on stdin end, a throw, and Ctrl+C, before `process.exit`. | `repl/index.ts:142-147, 178-181` |
| `/stop` | Same path as Ctrl+C under every double-text policy. | `repl/engine.ts:335-339` |

Tests: `apps/cli/src/repl/__tests__/interrupt.test.ts:18,26,31,53,70,85`;
`packages/trent-core/src/model-gateway/ModelGateway.test.ts:162,203`;
`packages/trent-core/src/orchestrator/orchestrator.test.ts:161,181`.

---

### A.4 Error recovery

| Mechanism | State | Evidence |
|---|---|---|
| Provider **retry** on the same provider | **ABSENT.** One attempt per provider. | `model-gateway/index.ts:181-235` — a single `for` over the provider list, no inner retry |
| **Backoff** | **ABSENT** on the model path. Exponential backoff exists only in the messaging gateway's `CircuitBreaker` (30 s base, 15 min cap). | `gateway/queue/CircuitBreaker.ts:25,45-53` |
| **429 / rate-limit** handling | **ABSENT** on the model path — no `Retry-After` read, no status-aware branch. `429` is treated as authenticated-and-ok only by `trent doctor`'s credential probe. | `doctor/probe.ts:94`; `grep -rn "Retry-After"` -> 0 hits |
| Provider **fallback chain** | Present but narrow: the next provider is tried **only if no token was emitted yet**. A failure mid-stream re-throws. | `model-gateway/index.ts:232` (`if (!emittedToken && index < providers.length - 1) continue;`) |
| Tool failure | Recorded as a `ToolCallRecord` with status `failed`/`blocked` and fed back into the next loop iteration. `blocked` ends the step immediately. | `apps/web/lib/seat-agent-loop.ts:386-441` |
| Max tool iterations per turn | **6** per step, **15** for `engineer` and `analyst`. On exhaustion the step returns `Stopped after max tool-use steps.` | `apps/web/lib/seat-agent-loop.ts:83-85`, `:194-200`, `:579-583` |
| Step retry | One critic-driven retry, then replan or escalate. | `apps/web/lib/orchestrator-run-phases.ts:293-319` |
| Drain bound | `DEFAULT_MAX_JOBS = 60` per run; exceeding it exits `"bounded"` rather than hanging. | `orchestrator/index.ts:82`, `:143-171`; test `orchestrator.test.ts:205` |
| **Loop detection** | Two partial mechanisms, neither a live stop. (a) `repeatedToolMisuse` degrades after 2 identical *recoverable misuse* records — and only when the step has source-grounding context (`seat-agent-loop.ts:110-118`, gated at `:393,431`). (b) `repetitive_loop` is a **post-hoc trace tag** computed from stored tool calls for the improvement gate; it never interrupts a run. | `packages/trent-core/src/improve/repetitive-loop.ts:1-18` |
| Idempotency / dead-letter | Real: per-key single execution with a retry limit and dead-letter status for irreversible actions. | `governance/IdempotencyManager.ts:78-144`; `governance/idempotent-dispatch.ts:74` |
| Run-level failure honesty | If every seat call failed, the run is rewritten `failed` in the live cache and the store with the provider's message, instead of the pipeline's false `completed`. | `orchestrator/index.ts:266-285`; `seat-guard.ts:47-81` |

Tests: `orchestrator.defects.test.ts`, `orchestrator.test.ts:205`,
`governance/IdempotencyManager.test.ts`, `governance/idempotent-dispatch.test.ts`,
`improve/repetitive-loop.test.ts`. **No test** covers provider retry, backoff or 429, because none
exists.

---

### A.5 Parallel tool calls

**ABSENT, at both levels.**

1. **Within a step:** the seat loop reads exactly one `toolCall` per model turn and executes it
   before the next turn (`apps/web/lib/seat-agent-loop.ts:282-447` — one `toolCall` variable, one
   `executeNamedToolCall`, then `continue`). There is no `tool_calls[]` array, no parallel dispatch,
   no `Promise.all` over tool calls anywhere in `packages/trent-core/src/tools/`.
2. **Across steps:** the DAG scheduler *does* enqueue up to `ORC_MAX_CONCURRENCY` (default 4) ready
   steps (`apps/web/lib/orchestrator.ts:47-53`), but the CLI's own drain loop picks
   **one** job — `.sort(...)[0]` — and awaits it before looking again
   (`packages/trent-core/src/orchestrator/index.ts:148-164`). So the wrapper serialises what the
   scheduler parallelised. A 4-wide plan runs 4 steps back to back.
3. What *is* concurrent: whole **runs**, bounded by `runtime.max_concurrent_runs` (default 2) with a
   FIFO wait and one `heartbeat` event announcing the queue (`orchestrator/run-slots.ts`;
   `orchestrator/index.ts:339-348`). Test: `orchestrator.concurrency.test.ts:101,146`.

---

### A.6 Cost ledger

| Question | Finding | Evidence |
|---|---|---|
| Per run | Yes — per-step `costCents` summed into `BudgetLedger` as `step_end`/`consolidate_end` arrive. Integer cents; a float throws. | `repl/engine.ts:413-421`; `repl/budget.ts:57-68` |
| Per seat | Not aggregated. Cost is recorded per *step* on the trace (`improve/trace-writer.ts`) and per *agent* in `fleet/FleetUsage.ts`, but no CLI surface reports cost by seat. |
| Per model / provider | The gateway's `usage` event carries `provider`, `model`, `modelTier`, `costCents`, `estimated`, `priced_as_default` (`model-gateway/index.ts:243-253`) — but `BudgetLedger.record(costCents)` takes the number only. Provider and model are dropped before the ledger. |
| **Is Gemini priced?** | **Yes**, three ids: `gemini-3.5-flash-lite` ($0.30/$2.50 per 1M), `gemini-3.5-flash` ($1.50/$9.00), `gemini-3.5-pro` ($2.00/$12.00, marked `unverified`). | `model-gateway/pricing.ts:33-42` |
| Everything else | **Priced as Anthropic tier list.** OpenAI, Mistral, OpenRouter and every Anthropic model id fall through to `estimateModelCostCents` and are flagged `priced_as_default: true`. An OpenAI `gpt-5`-class call is billed at the sonnet tier price. | `pricing.ts:72-77`; `model-gateway/index.ts:146-155` |
| Usage accuracy | Only `openai` sets `stream_options.include_usage`; Anthropic always emits usage; google/mistral/openrouter emit none and the cost is a 4-chars-per-token **estimate** marked `estimated: true`. | `01_discovery/output/model-gateway-contract.md` trap 4; `model-gateway/index.ts:237-252` |
| **Budget stop** | **ABSENT.** `daily_cap` and `per_run_cap` produce *warning lines only*. `BudgetLedger` has `record`, `takeCrossed`, `warning`, `warningLine` — and no `exceeded()` and no throw. Nothing in the REPL or the orchestrator consults the ledger before starting a turn. `EXIT.BUDGET` (6) is used in exactly one place, `fleet install` (`commands/groups/fleet.ts:162`). | `repl/budget.ts:33-99`; `repl/engine.ts:413-421` |
| Where `per_run_cap` *is* enforced | Only as an advisory number written into the seat's environment block (`Budget per run: N cents`, `apps/web/lib/agent-runtime.ts:122`) and as a cap in the improvement sweep's meter (`improve/meter.ts`). Not in the REPL. |

Test: `apps/cli/src/repl/__tests__/budget.test.ts:72` proves the ticker equals the sum of three real
gateway costs. **No test** asserts a run stops at the cap, because none does.

---

### A.7 Model routing

Routing is `config.provider`/`config.model` -> env (`orchestrator/model-env.ts:58-72`) ->
`buildModelPolicySnapshot()` -> `routeWorkbenchStream(role, policy)`
(`model-gateway/index.ts:131-140`). Roles: `planner` (strong tier), `executor`, `critic`.

| Provider | Config accepts | Gateway knows | Env mapping | Doctor probe | Wire test | Verdict |
|---|---|---|---|---|---|---|
| anthropic | yes | yes (`ai-client.streamAnthropicMessages`) | 3 tier vars | live `POST /v1/messages` | `ModelGateway.live.test.ts` (key-gated) | **REAL** |
| openai | yes | yes (`streamOpenAiCompatibleChat`) | 4 tier vars | live `GET /v1/models` | `ModelGateway.live.test.ts` | **REAL** |
| google | yes | yes | 3 tier vars | live `GET /v1beta/models` | `ModelGateway.live.test.ts`, `repl/__tests__/live.gemini.test.ts`, `vision.live.test.ts` | **REAL** |
| mistral | yes | yes | 3 tier vars | live `GET /v1/models` | key-gated only | **REAL (untested live here)** |
| openrouter | yes | yes | **provider preference only, no model var** — `TIER_VARS.openrouter = []`, so a configured model id is silently dropped and the anthropic tier table with an `anthropic/` prefix is used | live `GET /api/v1/key` | key-gated only | **PARTIAL** |
| deepseek | **yes** (`ProviderSchema`) | **no** (`ModelProvider` is 5 values) | **none** — `applyModelEnv` returns `unsupportedProvider: true` | yes (`bearerProvider`) | none | **CONFIG-ONLY** |
| groq | **yes** | **no** | **none** | yes | none | **CONFIG-ONLY** |
| ollama | **yes**, offered by the setup wizard (`setup/detect.ts:19,31` default `llama3.2`) and by the TUI model modal (`tui/modals/ModelModal.tsx:18`) | **no** | **none** | listed `KEYLESS_PROVIDERS` so the credential check passes | none | **CONFIG-ONLY** |
| LM Studio / llama.cpp / vLLM | no | no | no | no | no | **ABSENT** (`grep -rni "lm.?studio\|llama\.cpp\|vllm\|11434"` -> 0 hits outside this file) |

**The silent failure.** `applyModelEnv` returns `{ unsupportedProvider: true }` for deepseek, groq and
ollama (`model-env.ts:65`) and **nobody reads that field** — `grep -rn "unsupportedProvider"` finds
only the definition and its own unit test (`model-env.test.ts:65`). So a user who picks `ollama` in
the setup wizard gets a config Trent accepts, a doctor that passes (keyless provider), and a run that
quietly routes to whatever provider `buildModelPolicySnapshot()` defaults to — or to the degraded
deterministic planner if no key exists at all.

Per-seat model: **ABSENT**. `CatalogAgent.modelPolicy` is advisory only; real routing is the three
global env vars (`01_discovery/output/orchestrator-contract.md`, "Catalog").
`AgentInstaller` can set a per-role *budget* cap (`fleet/AgentInstaller.ts:40`) but not a model.

Fallback chain: `route.providers` from the app's policy, tried in order, with the
`!emittedToken` restriction in A.4. `trent model` shows and sets one global provider/model pair
(`commands/groups/configuration.ts:13`).

---

### A.8 System prompt assembly

Assembled in two halves by `getAgentRuntime` (`apps/web/lib/agent-runtime.ts:60-152`), then extended
by the wrapper:

| Order | Block | Source | Bound |
|---|---|---|---|
| 1 | granted skill instruction blocks | `loadGrantedSkillInstructions(grantedSkills)` — `agent-runtime.ts:80-82` | unbounded |
| 2 | base persona (or the plugged specialist profile's prompt) | `agents.agentSystemPrompt(role)` / catalog v3 `specialistPrompt` — `:87-103` | unbounded |
| 3 | seat manifest: role, when to use/not use, methodology, tool-use strategy, anti-patterns, DoD, allowed tools, tool details, contracts, success criteria, handoff, budget | `seat-manifest.ts:359-378` | ~1.5-3 KB/seat (21 KB file for 9 seats) |
| — | (1..3 joined = `staticPrompt`) | `:135` | |
| 4 | slot contract (mission, inputs, deliverables, metrics) | `:128-133` | |
| 5 | plugged profile block | `:105-112` | |
| 6 | memory plan block | `buildMemoryPlanBlock` — `:114` | |
| 7 | outcome snapshot (CEO/analyst only) | `:115` | |
| 8 | capability gate block | `:116` | |
| 9 | environment: memory namespace, **allowed tools**, approval-required list, budget cents, max runtime, required outputs, granted skills | `:118-126` | |
| — | (4..9 joined = `dynamicPrompt`) | `:136` | |
| 10 | **fleet-memory prelude, appended to `dynamicPrompt`**: memory blocks snapshot, shared-skills index, cross-agent recall | `fleet-memory/orchestrator-hook.ts:92-108, 127-133` | 2200+1375+1500 chars of blocks; recall capped 3000 chars |
| 11 | per-step tool-loop context: step/maxSteps, **cumulative tool history**, `availableTools`, `toolInstructions` | `apps/web/lib/seat-agent-loop.ts:285-295` | unbounded within the step |
| 12 | per-adapter usage text for every available tool, appended to `toolInstructions` | `orchestrator/seat-guard.ts:110-116`, built by `seat-wiring.ts:37-39` | one JSON schema block per toolset |

**What is NOT in the prompt:**

- `AGENTS.md`, `CLAUDE.md`, `.trent/` or any project instruction file from the working directory.
  `grep -rn "AGENTS\.md\|CLAUDE\.md"` over `apps/cli/src` + `packages/trent-core/src` returns only
  comments and `~/.trent/` path strings. The cwd is used as the tool **workspace**
  (`runtime/headless.ts:200`) and nothing more.
- The **personality**. `config.personality` is stored, `PersonalityManager.getActivePersonality()`
  returns a `systemPromptSuffix`, and `grep -rn "systemPromptSuffix"` shows it is read **only inside
  `personalities/`**. `improve/protected-prompt.ts:3` states the design plainly: "personality never
  touches the system prompt".
- Any conversation history (A.0).

**Size:** never measured, never capped, never logged. There is no token count of the assembled
prompt anywhere. Floor from the bounded parts alone is ~8 KB of memory + recall plus the seat
manifest plus one JSON schema block per enabled toolset (12 toolsets are implemented); the unbounded
parts are skills, the plugged profile prompt and the cumulative tool history.

---

## B. HERMES PARITY TABLE

Sources: `Trent Fleet Hermes Implementation Plan.md` §1 and `02_plan/output/tools-build-spec.md`.
`REAL` = implemented and covered by a behavioural test. `PARTIAL` = present with a material gap.
`ABSENT` = not implemented (grep patterns given).

### B.1 Toolsets and exact tool names

| Hermes feature | Trent implementation | Test | Verdict | Note |
|---|---|---|---|---|
| file toolset: `read_file` `write_file` `patch` `search_files` | `tools/file_ops/{index,adapter,paths,fuzzy}.ts` | `file_ops/file-ops.test.ts` | REAL | realpath confinement, deny globs, protected instruction files always-approve |
| terminal: `terminal` `process_manage` | `tools/terminal/{adapter,processes}.ts` | `terminal/terminal.test.ts`, `terminal/DockerBackend.test.ts` | REAL | 50K output, head/tail, spill |
| web: `web_search` `web_extract` | `tools/web/index.ts` | `web/web.test.ts` | REAL | through egress proxy; skipped with a visible reason when the proxy is off |
| code execution: `execute_code` | `tools/code_execution/index.ts` | `code-execution.test.ts`, `sandbox-image.docker.test.ts` | REAL | python/node; Hermes's `hermes_tools` RPC bridge not built (documented) |
| memory: `memory` `fleet_search` (`fleet_skill_view`) | `fleet-memory/`, `tools/memory/` | `fleet-memory.test.ts`, `memory/memory.test.ts` | REAL | registered by the fleet-memory hook, not the tool builder (`tools/index.ts:118`) |
| delegation: `delegate_task` | `tools/delegate/`, `orchestrator/delegate-port.ts` | `delegate.test.ts`, `delegate-port.test.ts`, `repl/__tests__/delegate.repl.test.ts` | REAL | 6 children/run, depth 2; no `action=list\|steer\|stop` control plane |
| cron: `cronjob_manage` | `tools/cron/index.ts` | `cron/cron.test.ts` | REAL | prompt-injection scan on stored prompts |
| skills: `skills_list` `skill_view` `skill_manage` | `tools/skills/{index,store,schemas}.ts` | `skills/skills.test.ts` | REAL | see B.2 for the hub |
| plugins: `plugins_list` + manifest commands | `tools/plugins/{index,manifest}.ts` | `plugins.test.ts` | REAL | command-form only; no Python `register(ctx)` |
| browser: `browser_navigate` `browser_snapshot` `browser_click` `browser_type` `browser_scroll` `browser_back` `browser_press` `browser_get_images` `browser_vision` `browser_console` (+ Trent `browser_screenshot` `browser_get_text`) | `tools/browser/` on `playwright-core` | `browser.test.ts`, `browser.chromium.test.ts` (skips without Chromium) | REAL | needs a Chromium on the machine; refs are `@eN` attributes, not the CDP a11y snapshot |
| vision: `vision_analyze` | `tools/vision/` | `vision.test.ts`, `vision.live.test.ts` | REAL | Hermes's `region` crop not built |
| MCP **client**: `mcp_<server>_<tool>` `mcp_status` | `tools/mcp/{index,client,config,scan}.ts` | `mcp.test.ts` (fake stdio server), `scan.test.ts` | REAL | no SSE, no OAuth, no resources/prompts |
| MCP **server** (Trent exposed over MCP) | none | — | **ABSENT** | `grep -rni "mcp.*serve"` over `apps/cli/src/commands` + `packages/trent-core/src/mcp` finds only client-side `trent mcp` |
| image generation (Hermes tool gateway) | none | — | **ABSENT** | `grep -rni "image_gen\|generate_image\|image generation"` over `packages/trent-core/src` + `apps/cli/src` -> 0 hits |
| TTS | none in the harness | — | **ABSENT** | exists only in the read-only web app (`apps/web/lib/generation/audio-router.ts`), unreachable from the CLI |
| STT / voice mode / `/voice on` / Ctrl+B | `voice/index.ts` **always throws** | `voice/voice.test.ts` | **ABSENT (honest stub)** | the previous fabricated `Transcribed N bytes` string was deliberately deleted; `transcribeVoice()` throws `EXIT.USAGE` |
| `ask_human` (Trent extension, not Hermes) | `tools/human/index.ts` | `human/human.test.ts`, `repl/__tests__/questions.test.ts` | REAL | |

### B.2 Skills hub

| Question | Verdict | Evidence |
|---|---|---|
| `skills_list` / `skill_view` / `skill_manage` | REAL | `tools/skills/index.ts:39-43`; `skills.test.ts` |
| **Can the agent create a skill itself after a task?** | REAL *as a tool call*: `skill_manage {action:"create"}` writes a `<category>/<name>/SKILL.md`, security-scanned, no `force` override. | `tools/skills/schemas.ts:46`; `tools/skills/index.ts:76-80` |
| Does it create one **automatically** after a task? | **ABSENT** as an automatic reflex. The improvement loop produces `SkillDraft`s that need `trent improve promote <draftId>`; `README.md` "Not done" confirms the sweep runs on command only. | `improve/lifecycle.ts`, `improve/skill-injection.ts:1-18` |
| Import skills from Claude Code / other formats | **ABSENT** | `grep -rni "claude.code"` over `packages/trent-core/src/skills` -> 0 hits. Only `trent fleet export/import <dir>` moves `<dir>/skills/<slug>/SKILL.md`, and it drops `scripts/` and `tools/` (`docs/skills.md`, "Not yet implemented") |
| Skills marketplace / hub sync | **ABSENT** | `SkillsHub.browse()` returns a hard-coded 6-entry array (`skills/SkillsHub.ts:16-65`); there is no network fetch, no manifest hash, no `skills opt-in --sync` |
| Pre-install scanner | PARTIAL | `SecurityScan` runs before every write and cannot be forced — but it is **8 regexes** against Hermes's ~110 across 12 categories, and `docs/skills.md` says so explicitly |
| Two divergent stores | **Defect.** `SkillsHub`/`SkillLoader` read flat `<slug>.md`; the `skills` toolset reads Hermes's `<category>/<name>/SKILL.md` directory layout and exposes the flat files read-only as `builtin`. `trent skills install` writes the flat form the agent cannot edit. | `tools/skills/store.ts:1-9, 32-39`; `skills/SkillsHub.ts:113` |
| Skill -> slash command | Documented (`docs/skills.md`: "Every skill gets a slash command") but **not implemented in the live REPL** — `repl/commands.ts` has a fixed 9-command map with no skill lookup. | `repl/commands.ts:59-266` |

### B.3 Platform, protocol and packaging features

| Hermes feature | Trent implementation | Test | Verdict | Note |
|---|---|---|---|---|
| Personalities (`/personality pirate`) | `personalities/{PersonalityManager,built-in}.ts`, `config.personality` | `PersonalityManager.test.ts` | **PARTIAL — inert** | the suffix never reaches a prompt (A.8); `/personality` lives only in the dead `apps/cli/src/slash/index.ts:202` |
| Messaging gateway: Telegram, Discord, Slack, WhatsApp, Signal, Email, Teams, Home Assistant | `gateway/platforms/*.ts` (8 adapters) | one `.wire.test.ts` + one `.live.test.ts` each | REAL | pairing default-deny, durable approvals, reaction decisions, thread-as-session, double-text queueing |
| Cron | `cron/CronRunner.ts`, `trent cron`, `cronjob_manage` | `CronRunner.test.ts`, `commands/__tests__/cron.test.ts` | REAL | 30 s tick, run history, pid lock, delivery to a gateway target |
| Plugins | `tools/plugins/` + `~/.trent/plugins/<name>/plugin.json` | `plugins.test.ts` | REAL | 0600 manifests, no name shadowing, every call needs approval |
| ACP editor integration (`hermes acp`) | `acp/ACPServer.ts`, `trent acp` | `ACPServer.test.ts` | **PARTIAL / canned** | HTTP JSON-RPC on 7890, not the stdio ACP editors speak; `agent/chat` returns the literal `` `[ACP Editor Dispatch]: Processing task "..." in editor workspace.` `` (`ACPServer.ts:123`) — never a model call |
| A2A | `a2a/{A2AServer,AgentCard}.ts`, `trent a2a serve\|card` | `A2A.test.ts` | **PARTIAL / canned** | agent-card signing is real (HMAC-SHA256, tamper test at `A2A.test.ts:32`); `POST /a2a/tasks` returns `status: "completed"` and `` `A2A delegation for task ${id} resolved successfully.` `` (`A2AServer.ts:88,92`) with no orchestrator call, and `A2A.test.ts:79-81` asserts that canned shape |
| Browser | see B.1 | | REAL | |
| Vision | see B.1 | | REAL | |
| Voice (STT/TTS) | `voice/index.ts` throws | `voice.test.ts` | ABSENT | |
| Image generation | none | — | ABSENT | |
| Delegation | see B.1 | | REAL | |
| Sandbox backends: local / docker | `terminal/{LocalBackend,DockerBackend}.ts` | `LocalBackend.test.ts`, `DockerBackend.test.ts`, `TerminalBackend.test.ts` | REAL | docker: cap-drop ALL, no-new-privileges, network none; local: scrubbed env, no isolation |
| Sandbox backends: ssh / e2b | **removed on purpose** — `config` v2->v3 collapses `ssh`/`e2b` to `docker` because they were mocks returning success | `config/migrate.test.ts` | ABSENT (deliberate) | `config/migrate.ts:41-44` |
| Sandbox backends: modal / daytona | never built (`DAYTONA_API_KEY` survives in the secrets schema only) | — | ABSENT | `config/schema.ts:126` |
| Egress credential proxy | `egress/{EgressProxy,CredentialBroker,CertificateAuthority,TokenManager}.ts` | 5 test files incl. `EgressProxy.test.ts` and `browser.chromium.test.ts` (proves the token is stripped upstream) | REAL | strongest component in the harness |
| Doctor | `doctor/DoctorRunner.ts` + 12 check modules, `--json`, `--fix` | `DoctorRunner.test.ts`, `FixRunner.test.ts`, `credentials.test.ts`, `database.test.ts`, `environment.test.ts`, `telemetry.test.ts` | REAL | credentials check makes one real authenticated call |
| Setup wizard (quick / full / blank-slate) | `setup/{SetupWizard,QuickSetup,FullSetup,BlankSlate}.ts` | `SetupWizard.test.ts` | REAL | runs automatically on first bare `trent` (`commands/index.ts:266-275`) |
| Profiles | `--profile <n>`, `TRENT_PROFILE`, `~/.trent/profiles/<n>/`, `listProfiles()` | `ConfigManager.test.ts` | PARTIAL | `listProfiles()` exists (`ConfigManager.ts:351-360`) but **no CLI command exposes it** — no `trent profile list`/`create` |
| Updater | `updater/` (release, minisign + ECDSA verify, install, selfUpdate, desktop), `trent update` | `updater/__tests__/updater.test.ts`, `publicKey.test.ts`, `desktop.test.ts` | PARTIAL | code is real and tested; **no release exists to update from** (README: no tag, no signed SHA256SUMS) |
| `trent web --start` | `commands/web-server.ts` + `groups/servers.ts:353-404` | `commands/__tests__/web.test.ts:92-244` incl. `:243` "starts on a random port and serves /" | **REAL — README is stale** | see the note below |
| Desktop | `apps/desktop/` Tauri v2, vendored Bun + Next standalone; `trent desktop install\|launch\|status\|uninstall` | `commands/__tests__/desktop.test.ts`, `updater/__tests__/desktop.test.ts` | PARTIAL | builds and runs; `install` downloads from GitHub Releases, which do not exist yet; no signed `.dmg`/`.msi`/`.AppImage` |
| Installer (`curl \| bash`) | `scripts/install.sh`, `install.ps1`, `scripts/installer/` with two embedded public keys and a threat model | `scripts/install.test.sh`, `scripts/installer/testserver.py` | PARTIAL | written and tested; `agent.let-trent.uk/install.sh` is 404 and no workflow publishes or signs a release |
| Todo / planning tool (`update_plan`-style) | none | — | **ABSENT** | `grep -rni "todo\|task_list\|plan_tool\|update_plan"` over `packages/trent-core/src/tools` + `apps/cli/src` -> 0 hits. Planning is the orchestrator's 1-12-step Zod plan, invisible as a tool |
| Batch / parallel runs | run-level only: `runtime.max_concurrent_runs` FIFO slots | `orchestrator.concurrency.test.ts:101,146` | PARTIAL | no `trent run "objective"` and no batch command exist (see C.5), so batching is only reachable from cron or the gateway |
| Session export | `telemetry/session-export.ts` | `session-export.test.ts` | **PARTIAL — no CLI** | redaction-safe exporter exists; `trent sessions` offers only `list`/`resume`/`prune` |
| Config yaml/env split | `~/.trent/config.yaml` + `~/.trent/.env` (0600), secrets routed by `secrets-policy.ts`, `config get <SECRET>` prints `[set]` | `ConfigManager.test.ts`, `commands/__tests__/behaviour.test.ts` | REAL | |
| Model selection CLI (`hermes model`) | `trent model [name]` | `commands/__tests__/behaviour.test.ts` | REAL | one global pair, no per-seat |
| `--continue` / `sessions list` | `--continue` restores nothing (A.2); `sessions list` real | list: `commands/__tests__/registry.test.ts`; continue: **no test** | `--continue` **ABSENT in effect**, `sessions list` REAL | |
| TUI (`--tui`) | `apps/cli/src/tui/` Ink app with 5 modals | `tui/__tests__/events.test.ts` | PARTIAL | its own `useSession` hook writes sessions the REPL does not; modals are real state readers |
| Toolset toggles | `trent tools --enable/--disable <toolset>` | `commands/__tests__/behaviour.test.ts` | REAL | |
| 164 specialists (Trent's advantage over Hermes) | `fleet/` + `agents/` over the app catalog | `FleetManager.test.ts`, `AgentInstaller.test.ts`, `commands/__tests__/fleet.test.ts` | REAL | |

**The `trent web --start` question, settled from code.** The README claim at `README.md:138`
("`trent web --start` refuses: the server entry point is not built") is **stale and wrong**. The
command is fully implemented: it locates `apps/web/.next/standalone/server.js` (or the nested
`.next/standalone/apps/web/server.js`, or a desktop bundle's `server/apps/web/server.js`), derives a
0600 per-profile `AUTH_SECRET` exactly as the Tauri app does, symlinks `.next/static` and `public`
into the standalone tree, spawns the entry with the standalone env contract, polls `/` until it
answers 2xx-3xx, and keeps the process alive
(`apps/cli/src/commands/web-server.ts:132-148, 191-203, 257-270, 359-385`;
`apps/cli/src/commands/groups/servers.ts:362-404`). `--build` runs `next build apps/web` from the
repo root first (`web-server.ts:294-321`). It refuses in exactly one case — the standalone tree is
missing and `--build` was not passed (`servers.ts:383-389`). `apps/cli/src/commands/__tests__/web.test.ts:243`
starts it on a random port and asserts it serves `/`. The commit is `59bf131 feat(cli): trent web
--start serves the real web UI`. **The memory note is correct; `README.md:138` and
`docs/troubleshooting.md:165` need updating.**

---

## C. HARNESS HYGIENE

### C.1 Hooks

**ABSENT** for users. There is no pre/post-tool-call hook, no session-start/stop hook, no
notification hook, and no `hooks:` block in `config/schema.ts` (the full top-level key list is at
`schema.ts:204-229`: version, profile, provider, model, toolsets, disabled_toolsets, budget,
terminal, egress, gateway, repl, runtime, heartbeat, fleet, memory, mcp_servers, telemetry, privacy,
policy, personality, theme).

Greps run: `preToolUse`, `postToolUse`, `pre_tool`, `post_tool`, `hooks:` over `packages/trent-core/src`,
`apps/cli/src`, `docs/` — the only matches are `composeBusHooks` (`traces/bus-hook.ts:216`) and the
`busHooks` dependency on `createHeadlessRuntime` (`runtime/headless.ts:68`), which are **code-level
DI seams**, reachable only by editing TypeScript. The nearest user-facing equivalent is
`policy.rules` (`governance/policy-rules.ts`), which can *require approval* or *deny* on a tool-class
sequence but cannot run a command.

### C.2 Slash commands in the REPL

Live set — `apps/cli/src/repl/commands.ts:59-266`, dispatched at `engine.ts:340-345`, with
autocomplete over the same names (`repl/autocomplete.ts`):

| Command | Reads |
|---|---|
| `/help` | the command map itself |
| `/status` | provider/model, active agents, sandbox, registered tools, egress, spend, pending approvals, live-vs-degraded |
| `/model` | provider, model, per-run cap |
| `/budget` | spend today, cap, alert thresholds |
| `/tools` | registered adapters and their scopes, sandbox, egress |
| `/mcp [list]` | `mcp.servers` from config |
| `/approvals [approve\|reject <id>]` | the durable approval store |
| `/wiki [query <text>]` | the durable run index, searched over objectives/summaries/step outputs |
| `/workbench` | sandbox backend and `workbench` job rows |
| `/traces [<task-type>]` | the trace store |

Plus `/stop` handled before dispatch (`engine.ts:335`). Test: `repl/__tests__/commands.test.ts`
(behavioural: mutate state, re-run, output must change), `autocomplete.test.ts`.

**Missing versus Hermes:** `/save`, `/personality`, `/voice`, `/skills`, `/fleet`, `/doctor`,
`/sessions`, `/config`, `/marketplace`, `/clear`, `/compact`.

**Dead code:** `apps/cli/src/slash/index.ts` defines a **second, richer 18-command set**
(`help fleet tools model skills personality voice budget doctor sessions save config mcp approvals
wiki workbench marketplace traces`) that **nothing imports** — `grep -rn "SLASH_COMMANDS"` finds only
`apps/cli/src/slash/slash.test.ts`. It uses `chalk` directly, contains emoji-free but check-mark
prose, and calls `transcribeVoice` (which always throws). It is a tested module wired to no surface.

### C.3 Project-level instructions from the cwd

**ABSENT.** Nothing reads `AGENTS.md`, `CLAUDE.md`, `TRENT.md`, `.trent/` or any repo-local
instruction file from the working directory into the prompt. Greps: `AGENTS\.md`, `CLAUDE\.md`,
`\.trent/`, `TRENT\.md` over `apps/cli/src` and `packages/trent-core/src` — every hit is a comment
or a `~/.trent/` profile path. `docs/skills.md` confirms the same for skills: "Repository-local
`.trent/skills/` discovery. Only the profile directory is read."

The cwd is used only as the tool workspace root (`runtime/headless.ts:200`, "never the home
directory") and for `file_ops` path confinement (`tools/file_ops/paths.ts`).

### C.4 Permission modes and approval floors

How a tool call is classified, in order:

1. **`PolicyDispatcher`** — trace-level rules over tool classes evaluated against the run's recent
   history at dispatch (`governance/policy-dispatch.ts`, defaults in `governance/policy-rules.ts:55-56`,
   e.g. "destructive after network" -> require approval). Config-extensible via `policy.rules`.
2. **`idempotentAdapters`** — per-key single execution, retry limit, dead-letter
   (`governance/idempotent-dispatch.ts`).
3. **`requiresApproval(action)`** on the adapter — `file_ops` on writes to protected files,
   `terminal`/`code_execution` on dangerous findings, `plugins` and `mcp` on every call unless
   `auto_approve`, `human` unless delegated; `memory`, `web`, `delegate`, `vision`, `browser` never.
4. **`floorBlock(command)` inside `execute`** — hardline patterns matched over deobfuscated variants
   (NFKC, quote/escape strip, `$IFS`, env unwrap, basename), re-checked inside `execute` because the
   seat loop grants approval loop-wide once a human says yes
   (`tools/approval-floors.ts:1-12, 21-28, 54-79`).
5. **Seat environment gate** — `approvalRequiredFor` written per seat by
   `orchestrator/seat-wiring.ts:20-24, 42-61`.
6. The parked call surfaces as `step_awaiting_approval`; the REPL blocks all ordinary input until
   `y`/`n` (`repl/engine.ts:422-474`), persists the decision, and releases the step through
   `bindApprovalAnswers` (`engine.ts:87-96`).

**Autonomy level: ABSENT.** There is no `ask-always` / `ask-dangerous` / `never` setting. `grep -rni
"autonomy\|yolo\|approval_mode\|permission"` over `config/schema.ts` and `docs/configuration.md`
returns nothing. An autonomy control plane *does* exist in the read-only app
(`apps/web/lib/orchestrator-autonomy-gate.ts`, consumed at `seat-agent-loop.ts:510-517` when
`input.autonomy` is set) — and the wrapper **never sets it**: `grep -rn "autonomy"` over
`packages/trent-core/src` returns zero hits. The only knob a user has is
`tools --enable/--disable <toolset>`, which is all-or-nothing per family.

### C.5 Config surface

- **Split:** `~/.trent/config.yaml` (settings) + `~/.trent/.env` (secrets, 0600). Secrets are routed
  by name/prefix (`config/secrets-policy.ts`), `config get <SECRET>` prints `[set]`, values never
  reach logs. Schema v3 with a migration ladder (`config/migrate.ts:34-44`). Unknown top-level keys
  pass through (`schema.ts:228` `.passthrough()`), so a newer Trent's config is not destroyed by an
  older one.
- **`trent config`:** `get <key>`, `set <key> <value>`, `unset <key>`, `list`
  (`commands/groups/configuration.ts:108-180`). Dotted paths with scalar coercion
  (`ConfigManager.ts:364-378`).
- **Profiles:** `--profile <name>` / `-p` / `TRENT_PROFILE`, resolving to `~/.trent/profiles/<n>/`.
  `listProfiles()` exists but is not exposed by any command.
- **Full command surface (24), verified by running `trent --help`:** doctor, setup, model, fleet,
  skills, improve, tools, sandbox, sessions, config, mcp, cron, heartbeat, audit, jobs, a2a, acp,
  gateway, egress, web, desktop, update, uninstall, serve (hidden shim, exits 2).
  Every command carries `--json`, `--profile`, `--no-color`, `-c/--continue`, `--dry-run`, enforced
  by `assertRegistryInvariants` (`commands/registry.ts:117+`).
  **There is no one-shot prompt command** — no `trent run "objective"`, no `trent -p "..."`.
  The only way to get a turn out of Trent is the interactive REPL/TUI, cron, or the messaging gateway.

### C.6 The "no canned responses" invariant

Three enforcement layers exist:

| Layer | Covers | File |
|---|---|---|
| `no-canned.test.ts` | `apps/cli/src/repl/**` and `apps/cli/src/tui/**` for canned prose, invented money, `setTimeout` replies, emoji, hex colours, 500-line files; plus `generateAutonomousReply` and `^"Trent proxy response` across the whole CLI and core | `apps/cli/src/repl/__tests__/no-canned.test.ts` |
| `scripts/ci/repo-scan.mjs` | `apps/cli/src`, `packages/trent-core/src`, `apps/desktop/src` for 4 literal patterns: `Trent proxy response`, "this is a mock/placeholder/canned/stub/simulated response", `lorem ipsum`, "not implemented yet"/"coming soon"/"implement me" | `scripts/ci/repo-scan.mjs:47-52` |
| gateway assertion | the wrapper never imports `apps/web/lib/ai-proxy/*` | `model-gateway/index.ts:1-8`; `ModelGateway.test.ts:148` |

**Two live violations the scanners do not catch**, because both scanners look for *known literals*
and neither covers the server surfaces:

1. `packages/trent-core/src/acp/ACPServer.ts:123` — `agent/chat` answers every editor request with
   `` `[ACP Editor Dispatch]: Processing task "${params?.prompt || "inspect"}" in editor workspace.` ``.
   No model, no orchestrator.
2. `packages/trent-core/src/a2a/A2AServer.ts:88,92` — `POST /a2a/tasks` answers
   `status: "completed"` with `` `A2A delegation for task ${payload.taskId} resolved successfully.` ``.
   No model, no orchestrator. Worse, `packages/trent-core/src/a2a/A2A.test.ts:79-81` **asserts** that
   shape (`expect(taskResult.status).toBe("completed")`), which is the exact anti-test `AGENTS.md:4`
   forbids. Both files pass their suites today (verified: 5 tests, exit 0).

Two lesser cases: `SkillsHub.browse()` returns a hard-coded 6-item catalog presented as "the
catalog" (`skills/SkillsHub.ts:16-65`); and `apps/cli/src/slash/index.ts:346` returns
`"0 pending approvals. All agent operations running within safe autonomy thresholds."` unconditionally
— dead code, but it is the shape the invariant exists to prevent.

---

## D. TOP 10 HARNESS SHORTFALLS

Ranked by how much they hurt a daily user. Fleet/memory/self-improvement issues excluded.

| # | Shortfall | Evidence | Smallest change that closes it |
|---|---|---|---|
| 1 | **There is no conversation.** Each REPL line is a fresh orchestration run with no message history; a follow-up like "now do the second one" has nothing to refer to. | `repl/engine.ts:378-406`; `runtime/headless.ts:272-273`; `orchestrator/types.ts` `OrchestratorRunOptions` takes `objective` only | Thread the last N turns' objective+summary into `OrchestratorRunOptions` and append them to the fleet-memory prelude, so the run that already builds a frozen prelude also carries the transcript. |
| 2 | **`--continue` restores nothing and the REPL never writes a session.** The flag is accepted, plumbed through three files, calls `resumeLastSession()`, and throws the result away. | `repl/index.ts:101`; `grep -rn "appendMessage"` shows only the gateway and TUI write sessions; no test | Have `ClassicRepl.start()` open or resume a `SessionData`, append a user and assistant message per turn, and seed the transcript and `BudgetLedger.openingCents` from it on resume. |
| 3 | **No context management at all** — no compaction, no token counting, no prompt cap, no prompt caching. A long step grows its prompt until the provider errors, and that error surfaces as a failed step. | A.1; `grep` for compact/summariz/contextWindow/cache_control returns nothing | Count characters of the assembled `systemPrompt + dynamicPrompt + toolHistory` before each seat call and drop the oldest tool-history entries past a configured ceiling. |
| 4 | **No budget stop.** `daily_cap` and `per_run_cap` only print warnings; nothing refuses a turn at 100%. `EXIT.BUDGET` is used once, in `fleet install`. | `repl/budget.ts:33-99`; `repl/engine.ts:413-421` | Add `BudgetLedger.exceeded()` and check it in `ReplEngine.#runTurn` before calling the runner, refusing with exit/message code 6. |
| 5 | **No one-shot command.** There is no `trent run "objective"` / `trent -p`, so nothing can be scripted, piped or put in a Makefile; the only non-interactive paths are cron and the messaging gateway. | `trent --help` (24 commands, none of them a run); `commands/index.ts:44-69` | Add a `run <objective>` `CommandSpec` that builds `createHeadlessRuntime` and streams events to stdout, reusing the existing renderer. |
| 6 | **No provider retry, backoff or 429 handling.** One attempt per provider; the fallback chain only advances when zero tokens were emitted; a rate-limit is an immediate run failure. | `model-gateway/index.ts:181-235`; `grep "Retry-After"` -> 0 | Wrap the per-provider attempt in a bounded retry with exponential backoff that reads `Retry-After` on 429/5xx before moving to the next provider. |
| 7 | **`ollama`, `deepseek` and `groq` are accepted everywhere and routed nowhere.** The setup wizard and the TUI model modal offer Ollama; `applyModelEnv` returns `unsupportedProvider: true` and no caller reads it, so the run silently routes elsewhere or degrades. | `config/schema.ts:8-17`; `setup/detect.ts:19,31`; `tui/modals/ModelModal.tsx:18`; `model-env.ts:65`; `grep "unsupportedProvider"` -> definition + own test only | Make `createOrchestrator` fail with exit code 3 when `applyModelEnv` reports `unsupportedProvider`, and drop those providers from the wizard and the modal until a gateway path exists. |
| 8 | **ACP and A2A return canned strings.** `trent acp` and `trent a2a serve` are advertised surfaces whose task endpoints never reach a model, and the A2A test asserts the canned shape. | `acp/ACPServer.ts:123`; `a2a/A2AServer.ts:88,92`; `A2A.test.ts:79-81`; both suites pass (5 tests, exit 0) | Point both handlers at `createHeadlessRuntime().run(objective)` and rewrite the tests to assert a real event stream, or make both endpoints refuse honestly the way `voice/index.ts` does. |
| 9 | **The personality system is inert and the second slash-command set is dead code.** `config.personality` never reaches a prompt; `apps/cli/src/slash/index.ts` ships 18 tested commands (including `/personality`, `/voice`, `/save`) that no surface imports. | `grep "systemPromptSuffix"` confined to `personalities/`; `improve/protected-prompt.ts:3`; `grep "SLASH_COMMANDS"` -> its own test only | Append `getActivePersonality().systemPromptSuffix` to the fleet-memory prelude, then delete `apps/cli/src/slash/` or merge its live commands into `repl/commands.ts`. |
| 10 | **No user-configurable hooks, no autonomy level, and no project instructions from the cwd.** A daily user cannot say "never ask about reads", cannot run anything before or after a tool call, and cannot put standing instructions in the repo they are working in. | C.1, C.3, C.4; `config/schema.ts:204-229` has no `hooks` or `autonomy` key; `apps/web/lib/orchestrator-autonomy-gate.ts` exists but the wrapper never passes `autonomy` | Add an `autonomy: ask_always \| ask_dangerous \| never` config key read by the approval gate (floors still absolute), and load `./AGENTS.md`/`./CLAUDE.md`/`./.trent/*.md` from the workspace into the prelude. |

### Runners-up (not in the ten)

- Intra-run step parallelism is thrown away: the DAG enqueues up to 4 ready steps, the drain loop
  takes one at a time (`orchestrator/index.ts:148-151`).
- No parallel tool calls within a step (one `toolCall` per model turn,
  `apps/web/lib/seat-agent-loop.ts:282-447`).
- Cost is priced per tier for everything except three Gemini ids, so non-Anthropic spend is wrong by
  up to 10x (`pricing.ts:33-42`; `01_discovery/output/model-gateway-contract.md` trap 3).
- `session-export.ts` and `ConfigManager.listProfiles()` are written, tested and unreachable from
  the CLI.
- Two divergent skill stores; `trent skills install` writes the flat form that `skill_manage` treats
  as read-only (`tools/skills/store.ts:1-9`).
- `README.md:138` and `docs/troubleshooting.md:165` describe a `trent web --start` that refuses;
  the code serves the real UI (`commands/web-server.ts`, test `web.test.ts:243`).
