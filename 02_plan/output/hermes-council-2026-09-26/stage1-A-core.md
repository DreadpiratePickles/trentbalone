# Council stage 1, Reviewer A: the agent core and harness parity (2026-09-26)

Lens: model gateway, agent loop (fleet vs solo), tools, context, memory, skills, self-improvement,
approvals inside the loop, prompt quality. Read-only review. No test suite, no model call, no tsx
script was run; every claim below is a file read or a grep, and each can be re-checked with the path
given.

- **Trent:** `feature/trent-fleet-v2` HEAD `79fa451`. "Landed" = in HEAD. "Tree" = uncommitted work of
  waves S2, H3, H5, L1 (finished, unlanded) and S3, P3 (still being written while this was read:
  `solo/compaction.ts` appeared mid-review and `solo/types.ts` already imports it). Paths are relative
  to `packages/trent-core/src/` unless they start with `apps/`.
- **Hermes:** `/Users/bobbymeher/.hermes/hermes-agent`, `pyproject.toml` version `0.21.3`, git HEAD
  `49eb7b5dba` (2026-09-20), last tag `v2026.8.27`. The inventory cites v0.21.4 (v2026.9.21), so this
  checkout is one patch release behind it; nothing below depends on that release.

## 1. Summary verdict

1. Trent's agent core is behind Hermes as a harness and ahead of it as a governed system; the gap is the loop, not the gate.
2. Solo mode (the Hermes-shaped runner) is well-engineered around approvals, taint and parks, and has never answered a real model: every solo test drives a fake gateway, and both live smokes were skipped under load (S1.1 log, line 127).
3. `trent setup --mode local` writes `agent.mode: solo`, but solo never sends constrained output: `soloResponseFormat` (`solo/prompt.ts:137`) has no production caller and `apps/cli/src/runtime/runner-for-mode.ts:298-303` omits `responseFormat`.
4. Solo has no context management at HEAD: full history every call (`solo/runner.ts:201`), no compaction (docs/solo.md says so), and no window at all on hosted models (`runner-for-mode.ts:230-237` returns undefined off a local alias), so a long hosted session ends in a provider 400 that `retry.ts` never retries.
5. Tool calling is a text protocol everywhere: `GatewayMessage` is `{role, content: string}` (`model-gateway/types.ts:24`), no `tools`, no tool role, no images; Hermes sends native tool schemas on every provider (`agent/turn_request_assembly.py`, `agent/anthropic_adapter.py:636`).
6. Anthropic, Mistral and OpenRouter still stream through the read-only app (`model-gateway/index.ts:51`, `apps/web/lib/ai-client.ts:434-460`): no `cache_control`, no cached-token read, no thinking control, no abort; Hermes puts four cache breakpoints on every Anthropic call (`agent/prompt_caching.py`).
7. Memory in the loop is append-only for the agent (`tools/memory/store.ts:174-183`); correction happens only in a heartbeat consolidation that is off by default (`config/sections/heartbeat.ts:14`) and needs a human promote. Hermes's `memory` tool does add/replace/remove (`tools/memory_tool.py:293`).
8. Self-improvement is more rigorous than Hermes's and reaches less: the unattended sweep is off by default, promoted GEPA seat prompts are read by nothing on the live path (`readSeatPrompt` only via `improve/seat-prompt.ts` -> `sweep.ts`), and solo is outside the loop entirely; Hermes learns from every 10 turns by default (`agent/background_review.py`, `hermes_cli/config_defaults.py:777,1283`).
9. Where Trent is really ahead: bound, idempotent approvals with session taint and sequence rules; an integer-cent ledger whose caps stop runs; held-out, judge-on-another-model, human-promoted improvement; a git brain with document import and a measured recall gate; constrained local seats with a measured lift (tree only).
10. First moves: prove solo live with constrained output, land solo compaction plus overflow recovery, move Anthropic and OpenRouter to the wrapper client with native tools and caching, make memory correctable, then rewrite the solo prompt. Breadth (TTS, computer use, more providers) comes after.

## 2. Area by area

| Area | Hermes (file) | Trent (file; landed or tree) | Verdict | Gap if behind |
|---|---|---|---|---|
| Provider coverage | 41 provider plugins (`plugins/model-providers/*`), OAuth and subscription logins (`hermes_cli/auth_*.py`), credential pools with cooldowns (`agent/credential_pool.py`, `credential_pool_model_cooldowns.py`) | 5 identities plus 4 OpenAI-compatible aliases (`model-gateway/types.ts:17`, `providers.ts:22`); fallback chain and pin policy (`call-policy.ts`); API keys only; landed | behind | No Bedrock/Vertex/Azure/xAI/Nous, no login, no pool. Onboarding lens, not ranked here |
| Hosted transport quality | Native adapters for Anthropic, Gemini, Bedrock, Codex (`agent/anthropic_adapter.py`, `gemini_native_adapter.py`, `bedrock_adapter.py`) with tools, thinking and caching | google, openai and aliases on the wrapper client (`openai-compat.ts`, `openai-route.ts`, landed 75a26cb/P1-C); anthropic, mistral, openrouter on the app streamer with a 60 s client and no signal (`apps/web/lib/ai-client.ts:117,189,434`) | behind | The best agentic provider is the worst-served path |
| Native tool calling | `tools_for_api` on every request (`agent/turn_request_assembly.py:196`), Anthropic `tools`/`tool_choice` (`anthropic_adapter.py:601-643`) | Text protocol: solo `<tool_call>{"name","arguments"}` (`solo/prompt.ts:39`, `solo/parse.ts`); fleet `toolCall.action = "<tool> <json>"` JSON-in-JSON (`apps/web/lib/seat-agent-loop.ts`); `GatewayMessage` has no tool role (`model-gateway/types.ts:24-27`) | behind | Hosted models lose their trained tool channel; parse failures are Trent's to repair |
| Constrained output and repair | Structured output for auxiliary calls only (`agent/auxiliary_structured_output.py`); argument coercion (`tools/arg_coercion.py`) | `response-format.ts`, `tool-call-repair.ts`, `orchestrator/seat-constrained.ts` (tree, L1): local seats 2/5 -> 4/5 on qwen3.5:9b (L1 log); solo envelope built but unwired (`runner-for-mode.ts:298-303`) | ahead in design, not landed; solo gap | Wire it into solo |
| Retries and error classes | `agent/error_classifier.py` (1,458 lines), `turn_overflow.py` (compress and restart on context-length/413), `fallback_cooldown.py` | `model-gateway/retry.ts` (3 attempts, Retry-After, full jitter), fallback chain, `orchestrator/auto-recovery.ts`; landed. No overflow recovery | partial | A context-length 400 is a dead run |
| Local models | Managed llama-server: `hermes_cli/local_runtime/{supervisor,estimator,catalog,hardware,context_policy}.py`; Ollama/LM Studio probes `hermes_cli/models_local.py` | Detects Ollama/LM Studio/llama.cpp; window from the loaded model, prefill-sized timeouts, slot caps, `:cloud` labelling, leak trap (`model-gateway/local-runtime.ts`, `local-probe.ts`, `setup --mode local`, doctor Local Model check); landed 7c96232..5989ac8; default model still `llama3.2` (`providers.ts:58`) | partial | No managed runtime or GGUF picker; no live solo proof |
| Cost truth | `agent/usage_pricing.py`, `insights.py` (estimates) | Integer-cent ledger, per-run and daily caps that stop runs, `unpriced`/`estimated` flags, cached tokens priced (`model-gateway/pricing.ts`, `governance/spend-ledger.ts`, `solo/meter.ts`); landed | ahead | Cached tokens are 0 on the anthropic/mistral/openrouter path |
| Agent loop: solo | `agent/conversation_loop.py` + `turn_*.py`; turns unlimited by default (`config_defaults.py:52`), budget warning (`iteration_budget.py`), 8 concurrent tool workers (`tool_executor.py:124`), token streaming (`stream_delivery.py`), guardrails (`tool_guardrails.py`) | `solo/turn.ts`, `runner.ts` (landed e0e13ab, 35fd43b; surfaces in tree S2): cap 25 calls hard-coded (`solo/types.ts:28`, config key never wired, S1 log follow-up 3), sequential calls, one repair, misuse stop, `complete()` only (`solo/types.ts:54`), no delta event kind (`orchestrator/types.ts:19-39`); zero live runs | behind | Shallow, silent until done, unproven |
| Agent loop: fleet | No equivalent (profiles, Kanban) | Planner, critic, consolidator, nine seats with budgets and eval suites; seat loop 6 steps, 15 extended (`apps/web/lib/seat-agent-loop.ts:84-85`); a local "Say the word ready" run died at the 10-minute job timeout (docs/local-models.md) | ahead as governance, behind as a chat loop | Five ledger rows for a one-line tagline (README first run) |
| Tools breadth | Core list `toolsets.py:11-40`: adds `text_to_speech`, `image_generate`, `computer_use`, browser vault, `ha_*`, `send_message_tool.py`, posture presets (`_CODING_TOOLS`) | 21 toolsets (`tools/tool-names.ts`), including `business`, `social`, `media`, `a2a` that Hermes lacks; browser attach (tree, H5) | partial | TTS, computer use, video generation, send-to-channel, vault missing |
| Code execution | `execute_code` scripts call tools over RPC (`tools/code_execution_rpc.py`) | `execute_code` python/node in the sandbox, no tool access (`tools/code_execution/index.ts`); landed | behind | No programmatic tool calling |
| Delegation | `tools/delegate_tool.py`: parallel batches, `output_schema` with a correction turn (`delegation_output_schema.py`), steer/stop, 250 iterations per child (`config_defaults.py:1322`) | `tools/delegate/index.ts` (max 6, goal/context only, `:28-30` says no steer/stop, no schema); in solo `delegate_task` fails ("no orchestration run is active", S3 finding 3); `solo-route.ts` 16-line stub (tree, S3) | behind | Solo has no subagents at all |
| Context compaction | `agent/context_compressor.py` (5,299 lines): threshold 0.5 on by default (`config_defaults.py:544-556`), preflight, post-tool and idle passes (`turn_context_compaction.py`), micro-compaction (`micro_compaction.py`), server-side on OpenAI (`native_compaction.py`) | `sessions/compaction.ts` between fleet REPL turns (landed); solo: none (docs/solo.md "does not compact a solo session yet"); over-window refusal only when the window is known (`solo/turn.ts` `overBudget`); `solo/compaction.ts` being written (S3) | behind | Solo sessions grow until they fail |
| Prompt caching | `agent/prompt_caching.py` (4 breakpoints, 5m/1h TTL), `prompt_cache_boundary.py`, `prompt_cache_scope.py` | Stable-first ordering (P2-7) and a per-session frozen solo prefix (`solo/runner.ts:130-137`); 0 hits for `cache_control` in `packages/` and `apps/`; README records 0 cached tokens on the default flash-lite in 7 tries | partial | No cache on Anthropic at all |
| Session continuity | SQLite WAL + FTS5 (`hermes_state_*.py`), lineage across compression, `-c` per terminal | JSON transcripts rewritten whole on each save (`sessions/SessionStore.ts:107-123`), FTS5 search, `trent solo -c`, parks survive restart (`solo/park.ts`); `run --resume` fleet only (docs/solo.md) | partial | O(n²) writes per long solo session; resume of a killed REPL park not offered |
| Plan state (todo) | Per session, re-injected after compression (`tools/todo_tool.py` header) | Keyed by run id (`tools/todo/store.ts:90`); a solo run is one user turn, so the list resets every message; never injected into the prompt (`tools/todo/index.ts` header) | behind | "Continue the plan" loses the plan |
| Memory in the loop | `tools/memory_tool.py` add/replace/remove, hard limit, write approval optional; background nudges every 10 turns (`config_defaults.py:1283`); external providers (`plugins/memory`) | Blocks with caps (`tools/memory/blocks.ts:31-45`); seat writer append-only (`tools/memory/store.ts:174-183`); consolidation only from `trent heartbeat` (`apps/cli/src/commands/groups/heartbeat.ts:106-121`), off by default; untrusted writes held (`tools/memory/holds.ts`); landed | behind | The agent cannot fix a wrong fact; the block fills and stops |
| Brain and recall | Frozen snapshot + `session_search` (`tools/session_search_tool.py`) | Git brain (`fleet-memory/brain.ts`), ingest of pdf/docx/xlsx (`fleet-memory/ingest/`), hybrid recall (`hybrid.ts`), local embedder with calibrated floors (`embedder-local.ts`, landed 4b6f20c), recall@8 gate (`improve/retrieval-gate.ts`) | ahead | - |
| Skills in the loop | `tools/skills_tool.py`, `skill_manager_tool.py`, hub over 8 sources (`skills_hub*.py`), `/skill-name` commands (`agent/skill_commands.py`), idle-triggered curator (`agent/curator.py`) | `skills_list`/`skill_view`/`skill_manage` with scan and quarantine (`tools/skills/`), one store (`skills/skill-store.ts`), curator with ledger and undo (`curator/`), org skills index in the stable tier; landed | parity in the loop; behind on hub | No remote hub or skill slash commands |
| Self-improvement | `agent/background_review.py` (enabled, every 10 turns, writes memory and skills directly), `review_engine.py` (`/review`), `learning_graph.py`; no held-out grading | `improve/`: judge on another model (`judge-model.ts`), holdout (`suite-split.ts`), pass^k, auto-rollback (`post-promote.ts`), veto, frozen surface, human promote; sweep off by default (`config/sections/heartbeat.ts:32`); promoted `__seat_prompt__` drafts have no live reader; solo not covered | ahead on rigor, behind on reach | It rarely runs and what it promotes partly never ships |
| Approvals in the loop | `tools/approval.py` once/session/always, inline LLM classifier (`tools/approval_smart.py`), write approval (`write_approval.py`), Tirith | Autonomy levels, hardline, deny globs, floors, bound approvals, sequence rules, session taint (`governance/*.ts`, `solo/runner.ts` B1); reviewer model (landed 5bab958) runs only from `trent approvals list --review` (`apps/cli/src/commands/groups/approvals.ts:139-155`), trigger in flight (P3); no session or always allow | ahead on side effects, behind on friction | Every floored call reaches a human or a manual CLI pass |
| System prompt quality | `agent/system_prompt.py` three tiers; `agent/prompt_builder.py`: behaviour-spec identity (`:158`), tool-use enforcement per model family (`:345-359`), task completion and no-fabrication (`:380`), parallel calls (`:408`), memory/skills/session-search guidance, platform hints (`:634`), environment hints (`:1056`) | Solo: a 4-sentence persona (`solo/prompt.ts:33`), stable tier, one protocol block, every adapter's instructions (`:130`); the memory tool tells the solo model it is "shared by every seat in the company" and consolidated "nightly ... which the founder promotes" (`tools/memory/index.ts:69-71`); no platform hints in `apps/cli/src/gateway/agent-handler.ts`; prompt size never measured | behind | The model gets fleet wording and no working rules |
| Vision and media in the conversation | Native image parts (`agent/vision_message_prep.py`, `image_routing.py`), TTS replies (`tools/tts_tool*.py`) | `vision_analyze` tool only; string-only messages; voice notes in as text (`gateway/voice-notes.ts`, landed P2-3); no speech out | behind | A photo sent on Telegram never reaches the model as an image |
| MCP in the loop | `tools/mcp_tool*.py`: tools, sampling (`mcp_tool_sampling.py`), scoping, OAuth (`mcp_oauth*.py`) | Tools only over the official SDK (`tools/mcp/client.ts:149-154`), scan and scrub, OAuth 2.1 (landed 2095c7d); no resources, prompts, sampling or include/exclude | partial | Tool filters for a 40-tool server |

## 3. The ten most important gaps, ranked

**1. Solo has never run on a real model, and on local it runs without constrained output.**
Why: the base harness is the product a Hermes user compares; today nobody knows whether one turn
works. `setup --mode local` writes `agent.mode: solo` (L2 log), the doctor smoke on the 9B scored 1/5
unconstrained (L0-4) and the L1 seat A/B moved 2/5 to 4/5 only with constraint. Hermes bar:
`agent/conversation_loop.py` shipped and used daily. Trent files:
`apps/cli/src/runtime/runner-for-mode.ts` (pass `responseFormat: soloResponseFormat(adapters)` when
`constrainedOutputApplies()`), `solo/runner.ts`, a live test beside
`orchestrator/seat-constrained.live.test.ts`. Acceptance: under `TRENT_TEST_LIVE=1`, `trent run --solo`
on qwen3.5:9b and on one hosted model each completes a three-turn session with at least one real tool
call per turn and prints tokens and cents, and a unit test asserts the solo request carries
`response_format` under a local alias and not under a hosted one. Size S (wiring) plus one uncontended
hour for the live runs.

**2. Solo context management: compaction, a hosted window, overflow recovery.**
Why: every solo turn resends the whole transcript (`solo/runner.ts:201`); on a hosted model there is
no budget at all, so a long conversation ends in a provider 400 that `model-gateway/retry.ts` classes
as validation and never retries, and the next message fails the same way. Hermes bar:
`agent/context_compressor.py` (threshold 0.5 by default), `turn_context_compaction.py`,
`turn_overflow.py`. Trent files: `solo/compaction.ts` (S3, being written), `sessions/compaction.ts`,
`solo/turn.ts`, `apps/cli/src/runtime/runner-for-mode.ts` (a hosted window from the price table's
context field or `model_overrides`). Acceptance: with a fake gateway, a session past the threshold
compacts before the next model call (tool results pruned first, one summary event, frozen prefix
byte-identical), and a fake provider's context-length 400 triggers one compaction and one retry that
succeeds instead of `run_failed`. Size M.

**3. Hosted transport parity: native tools and prompt caching on Anthropic and OpenRouter.**
Why: Claude is the strongest tool user and the most expensive; Trent sends it no tool schemas, no
`cache_control`, reads no `cache_read_input_tokens`, cannot set thinking, and cannot abort
(`apps/web/lib/ai-client.ts:434-460`). The same prefix is billed in full every turn and every seat.
Hermes bar: `agent/anthropic_adapter.py`, `agent/prompt_caching.py`. Trent files: a wrapper-side
Anthropic client beside `model-gateway/openai-compat.ts`, `model-gateway/index.ts` routing,
`model-gateway/types.ts` (tool definitions, `tool` role, tool calls on the completion), `solo/parse.ts`
(accept native calls), `pricing.ts` (cache write/read rates). Acceptance: against a fake Anthropic
server, a solo turn sends `tools` and a `cache_control` breakpoint on the system block, a `tool_use`
block becomes a call, and the ledger row carries the fake's `cache_read_input_tokens` priced at the
cached rate. Size L (M for the Anthropic client and caching alone).

**4. Learning from use, and promoted improvements that actually ship.**
Why: Hermes's headline is "creates skills from experience" and it runs by default; Trent's loop is
off by default, is seat-only, and a promoted GEPA seat prompt is read by the sweep, the gate and
`fleet versions`, never by a live seat call (`readSeatPrompt` callers: `improve/seat-prompt.ts:40`
only, consumed by `sweep.ts:41`, `commands/improve-goldens.ts:336`, `groups/fleet-versions.ts:86`).
Solo gets neither promoted skill injection (`improve/skill-injection.ts` wraps seat calls only) nor a
review. Hermes bar: `agent/background_review.py`, `hermes_cli/config_defaults.py:777,1283`. Trent
files: new `improve/session-review.ts`, `apps/cli/src/repl/engine.ts` and `runner-for-mode.ts` (a
turn counter), `orchestrator/index.ts` or `improve/hook.ts` (a live seat-prompt reader),
`solo/prompt.ts` (promoted persona and skills as a surface). Acceptance: after ten solo turns on a fake
gateway, one review pass files at least one memory entry through the held-write path and any skill
into curator quarantine, and a promoted `__seat_prompt__` draft changes the system prompt a fake seat
executor receives on the next fleet run. Size M.

**5. Memory the agent can correct.**
Why: a user who says "I moved to Leeds" or "forget that" gets a refusal; the seat gate allows `add`
only (`tools/memory/store.ts:174-183`) while the store's own comment promises "remove and add in one
batch" (`:47-48`), and once the 2,200-character block is full the agent stops learning until a
heartbeat consolidation (default off) and a human promote. Hermes bar: `tools/memory_tool.py:83-129,
293`. Trent files: `tools/memory/store.ts` (a `solo`/owner writer that may replace/remove its own
block), `tools/memory/index.ts` (schema and wording), `solo/runner.ts` wiring; provenance holds stay
in force. Acceptance: in solo, `memory {"action":"replace","old_text":"Leeds","content":"York"}`
succeeds on an untainted session, is held on a tainted one, and an add past the cap returns the
entries so the next call in the same turn can replace one. Size S.

**6. The solo system prompt.**
Why: the model is told almost nothing about how to work (no tool-use enforcement, no "never fabricate
a tool result" rule beyond one sentence, no parallel-call steer, no when-to-save-memory or
when-to-check-skills rule, no messaging-platform formatting), and it is told fleet facts that are
false in solo (seats, founder, nightly consolidation). Its size on the default build has never been
measured, which matters on a 32K local window. Hermes bar: `agent/prompt_builder.py:158-634`,
`agent/system_prompt.py`. Trent files: `solo/prompt.ts`, `tools/memory/index.ts:69-71`,
`apps/cli/src/gateway/agent-handler.ts` (platform hint in the context tier). Acceptance: a snapshot
test of the default solo system prompt contains the guidance sections, has no occurrence of "seat" or
"founder", and a test asserts its estimate stays under a stated token ceiling (e.g. 6,000) for the
default toolsets. Size S.

**7. Loop depth, parallel calls, streaming.**
Why: 25 tool calls then `run_failed` with no warning (`solo/turn.ts`, cap at `solo/types.ts:28`,
`agent.max_tool_calls` never wired); fleet seats stop at 6 or 15. Independent reads run one at a time.
Nothing is shown until the whole answer exists, which on a local 9B is minutes of silence (TTFT 91-157
s, docs/local-models.md). Hermes bar: `agent/iteration_budget.py`, `agent/tool_executor.py:124`,
`agent/stream_delivery.py`. Trent files: `config/sections/agent.ts` (validated `solo.*` keys; the block
is a passthrough today), `solo/turn.ts`, `solo/events.ts`, `orchestrator/types.ts` (a delta kind),
`apps/cli/src/repl/render.ts`. Acceptance: `agent.solo.max_tool_calls: 60` is schema-checked and
honoured, the model receives one wrap-up notice at 80 percent, two read-only calls in one reply
overlap in time on a fake clock, and the REPL renders token deltas before the final `step_output`.
Size M.

**8. Delegation in solo, with a control plane.**
Why: in solo `delegate_task` answers "no orchestration run is active" (S3 finding 3); in the fleet it
takes goal and context only, with no schema, no steer or stop, no parallelism. Hermes bar:
`tools/delegate_tool.py`, `tools/delegation_output_schema.py`, `delegate_tool_child_run.py`. Trent
files: `tools/delegate/{index,types,solo-route}.ts`, `solo/runner.ts`. Acceptance: in solo, three
tasks with an `output_schema` return three child results charged to the parent's `per_run_cap`, a
child missing a required field gets exactly one correction turn, and `action: stop` returns the
partial result. Size M.

**9. Approvals inside the loop without a human for every floored call.**
Why: the reviewer model exists but only runs when someone types `trent approvals list --review`
(`apps/cli/src/commands/groups/approvals.ts:139-155`); a held solo call parks until a person acts, and
there is no "allow this command for this session". Hermes decides flagged commands inline
(`tools/approval_smart.py`) and offers once/session/always (`tools/approval.py`). Trent files:
`governance/auto-review.ts`, `solo/turn.ts` (consult the reviewer before parking), a session allow
list keyed by exact command in `governance/autonomy-dispatch.ts`. Money, sends and customer actions
stay human-only. Acceptance: with `governance.auto_review.enabled` and a policy allowing class
`write`, a held `write_file` in a solo run is decided by the fake reviewer in the same stream and
logged on `approvals-audit.ndjson`, and a session-allowed terminal command runs without a card for the
rest of that session and asks again in a new one. Size M.

**10. The plan survives the turn.**
Why: `todo` is keyed by run id (`tools/todo/store.ts:90`) and a solo run is one message, so a plan
written in turn 1 is gone in turn 2, and it is never shown to the model after a compaction. Hermes
bar: `tools/todo_tool.py` (per session, re-injected after compression). Trent files:
`tools/todo/{index,store}.ts` (key by session when bound), `solo/prompt.ts` (context tier).
Acceptance: in one solo session a list added in turn 1 is returned unchanged by `todo list` in turn 3
and appears in the context tier after a forced compaction. Size S.

Just below the cut, all real: `execute_code` with tool RPC (`tools/code_execution_rpc.py`); images
as native message parts; spoken replies; OAuth/subscription logins and credential pools; a managed
local runtime; MCP tool include/exclude; transcript storage that appends instead of rewriting.

## 4. Where Trent is genuinely ahead (evidence)

1. **Side effects are bound, idempotent and taint-aware inside the loop.** A send, charge or booking
   asks at every autonomy level and the yes is bound to that call (`governance/bound-approvals.ts`,
   `idempotent-dispatch.ts`); solo carries the conversation's taint and policy ring across turns and
   restarts (`solo/runner.ts:91-103`, `governance/provenance.ts`); "read a secret, then send" is
   denied by rule (`governance/policy-rules.ts`); a differing retry of an approved call is held and
   names what changed (`solo/holds.ts`). Hermes approvals cover commands, not the call's arguments
   (`tools/approval.py`).
2. **Money is counted, capped and labelled.** Integer cents per call at list price, caps that refuse a
   turn or stop a run, `unpriced` and `estimated` flags, local at 0, `:cloud` tags unpriced
   (`model-gateway/pricing.ts`, `governance/spend-ledger.ts`, `solo/meter.ts`). Hermes reports
   estimates (`agent/insights.py`, `usage_pricing.py`).
3. **Improvement that cannot grade itself.** Judge on a different model (`improve/judge-model.ts`),
   held-out split (`suite-split.ts`), pass^k (`pass-k.ts`), automatic rollback on regression
   (`post-promote.ts`), content-hash veto (`veto.ts`), frozen surface (`frozen-surface.ts`), human
   promote (`lifecycle.ts:122`). Hermes's review writes straight to memory and skills
   (`agent/background_review.py` header). The rigor is real; its reach is gap 4.
4. **A brain, not just a notes file.** Git-versioned Markdown with a truth rule
   (`fleet-memory/brain.ts`), pdf/docx/xlsx import with chunk-id citations (`fleet-memory/ingest/`),
   hybrid recall with a calibrated local embedder (`embedder-local.ts`, `embedder-calibration.ts`),
   and a recall@8 gate (`improve/retrieval-gate.ts`); local recall measured at 0.600 against Gemini's
   0.629 at 0 cents (L0-5 log; not re-run here).
5. **Local models told the truth.** Prompts over the loaded window are refused with sizes instead of
   silently cut (`fleet-memory/prompt-budget.ts`, `model-gateway/local-probe.ts`, `solo/turn.ts`
   `overBudget`); a pinned `mistral:7b` can no longer leak to a hosted API, proved with a trap server
   (`model-gateway/local-routing.test.ts`, 77373a0). Constrained seat decoding with measured lift sits in the tree
   (L1). I did not find an equivalent over-window refusal for unmanaged Ollama in Hermes, but did not
   prove its absence.
6. **Governed roles.** Nine seats, each with toolsets, denied toolsets, gates, a cents budget and an
   eval suite (`fleet/seat-capabilities.ts`); Hermes has no per-agent money cap or suite.
7. **Parks that survive a restart.** A held solo call is saved before its gate frames, listed after a
   restart and resumed by id, or abandoned out loud with its row marked (`solo/park.ts`,
   `solo/runner.ts:141-160`).

## 5. Claims I could not verify, or that the code contradicts

1. **"responseFormat passed through with the {"tool_calls"}/{"answer"} envelope (C1)"**
   (harness-landscape log, S1.1 report). True inside `solo/runner.ts:116`; false for the product:
   `soloResponseFormat` has zero non-test callers and `runner-for-mode.ts:298-303` passes no
   `responseFormat`. docs/solo.md:72 is honest ("depends on constrained output that has not landed").
2. **`improve.ts:6` "promote: quarantine -> live; the only way an artifact reaches an agent"** and the
   README row "nothing goes live without `trent improve promote`". True for skill drafts (injected by
   `improve/skill-injection.ts` when `SKILL_INJECTION_ENABLED=1`, which `runtime/env.ts:56` sets); for
   `__seat_prompt__` drafts I found no live reader (grep `readSeatPrompt`, `SeatPromptProvider`).
3. **`tools/memory/store.ts:47-48`**: "A seat that is over the limit can therefore consolidate in the
   SAME turn — remove and add in one batch". Contradicted by `checkMemoryWriteGate` for writer `seat`
   (`:174-183`), which refuses `replace` and `remove`.
4. **The memory tool text shown to a solo model** ("shared by every seat in the company", "nightly
   consolidation, which the founder promotes", `tools/memory/index.ts:69-71`): there are no seats in
   solo, and consolidation runs only when the heartbeat runs (`heartbeat.enabled` default false).
5. **docs/local-models.md:139, "at 9B single tool calls mostly work"**. The HEAD evidence is 1/5
   (L0-4, seat format) and 2/5 unconstrained (L1); 4/5 needs constrained seats, which are in the tree,
   and nothing has been measured for solo's own format (S1.1 log line 127).
6. **"84 solo tests" (S1.1 report).** The committed solo test files contain 68 `it(`/`test(` lines
   (grep); parametrised cases may explain the rest. Not run here.
7. **Measured numbers taken on trust:** L0-5 recall (0.600/0.629), L1 A/B (2/5 -> 4/5), L0-2 TTFT
   (91 s/157 s), P2-7 cache hits (8,164 of 10,808). Each log names its command; none was re-run here,
   all were taken under load averages of 31 to 1,000.
8. **`governance/auto-review.ts:17-18`**: "The gateway request has no response-format field". Stale
   once L1 lands (`model-gateway/types.ts` `responseFormat`, tree).
9. **Scorecard 2026-09-25 row 9** ("cached tokens never read") is now true only for anthropic, mistral
   and openrouter; **row 11** ("nothing calls transcribeVoice") is literally still true but voice notes
   are transcribed through `gateway/voice-notes.ts` (P2-3), so the row understates.
10. **The solo system prompt's size** on the default seventeen-toolset build is not measured in any
    log, doc or test I found; it is the number that decides whether solo fits a 32K local window.
11. **No `// TODO` comments, but S3 is half-written**: `solo/types.ts` imports `./compaction.js`,
    `./delegate.js`, `./skills.js` while those files are being authored (L1 log 01:56 records `tsc`
    exit 2 on them). Any "solo continuity works" claim before S3 lands is premature.

## 6. What I would do first, in order

1. Wire `soloResponseFormat` into `runner-for-mode.ts` under a local alias, validate `agent.solo.*`
   keys in `config/sections/agent.ts`, and run the two live solo sessions (qwen3.5:9b, one hosted
   model) alone on the machine. Publish the transcript, tokens and cents. Until this exists, no doc
   or README row should call solo usable.
2. Land S3's compaction with the hosted window and a context-length recovery path (gap 2), and the
   todo-per-session change (gap 10) in the same wave; both are about a session that lasts.
3. Make memory correctable in solo (gap 5) and rewrite the solo prompt with measured size (gap 6);
   both are small and change every turn's quality.
4. Build the wrapper-side Anthropic client with `cache_control`, cached-token reads and native tool
   use, then extend native tools to the OpenAI-compatible hosted routes (gap 3). Keep the text
   protocol plus constrained output for local.
5. Close the improvement reach: a live seat-prompt reader, a session review that files through the
   held paths, solo as an improvable surface, and turn the sweep on by default where a durable store
   exists (gap 4).
6. Loop depth, budget warning, parallel read-only calls, token streaming (gap 7).
7. Delegation in solo with `output_schema` and stop (gap 8); the reviewer consulted inline plus a
   session allow list for non-money calls (gap 9).
8. Only then breadth: code-execution tool RPC, native image parts, TTS, provider logins, a managed
   local runtime.
