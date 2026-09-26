# 2026-09-26 — C12: solo sessions that last

Council item C12 (`02_plan/output/hermes-council-verdict-2026-09-26.md`, "Tier 4: harness depth"). Compaction
itself is S3's (`solo/compaction.ts`, landed); C12 is the rest: a context-length 400 is not a dead run, a hosted
model has a window, the todo list outlives a message, and the tool-call cap warns before it stops.

Branch `feature/trent-fleet-v2`, HEAD `f26e90f`. No subagents (the brief says so). No commit, stash, checkout,
reset or push. Fakes only: no model call. Every hunk in an existing file carries `// [C12]`. Another agent owns
`packages/trent-core/src/runtime/env.test.ts` (modified in the tree before this session): not touched.

## Read first
AGENTS.md; the rulebook's Universal Coding Rules and Phase 4; C12 in the council verdict; `model-gateway/retry.ts`,
`attempts.ts`, the gateway's failure path (`index.ts` ~455-470); `solo/{turn,runner,compaction,types,prompt,
turn-settings,repeat-stop,events}.ts` and the fakes; `sessions/compaction.ts` (`planCompaction`, `keepFrom`);
`governance/provenance.ts` (session taint binding); `tools/memory/index.ts` `writerOfCall` (the owner check);
`tools/todo/{index,store}.ts` and its test; `model-gateway/pricing.ts` (`contextWindowFor`, the table's
`contextWindow`); `config/sections/models.ts` (`ModelOverrideSchema.context_window`); `apps/cli/src/runtime/
runner-for-mode.ts`; the S3 log; `docs/solo.md`. Hermes: `agent/turn_overflow.py`, `agent/error_classifier.py`
(`_CONTEXT_OVERFLOW_PATTERNS`), `tools/todo_tool.py` header, `agent/iteration_budget.py`,
`agent/turn_iteration_prep.py` (`_maybe_inject_iteration_budget_warning`).

## Findings before code (facts, with where)
1. `retry.ts:188-195`: every 4xx other than 401/403/408/429 is `validation`, `retryable: false`. The gateway then
   falls back to the next provider when no token was emitted (`index.ts` `willFallBack`), else throws the provider
   error; solo's `turn.ts` `loop` catches it and ends the run `run_failed` (`modelFailureVerdict`).
2. The config already has a per-model window: `model_overrides.<model id>.context_window`
   (`config/sections/models.ts` `ModelOverrideSchema`), and the gateway already reads it:
   `pricing.ts` `contextWindowFor(model, alias, overrides)` (override first, then the price table's `contextWindow`:
   Gemini 1M, Claude 200K, OpenAI 1,047,576 / 200K / 400K, DeepSeek, Groq, Mistral 128K). There is no
   `models.<alias>.context_window` key; the "small table" the brief asks for already exists in `pricing.ts`, so C12
   reads it rather than writing a second one (rule: do not duplicate an authoritative source).
   `runner-for-mode.ts` `soloWindowTokens` returns undefined for every hosted alias, so hosted solo compacts at the
   fixed 64,000 characters (`compaction.ts` `DEFAULT_SOLO_COMPACT_AFTER_CHARS`).
3. The todo list is keyed by `currentToolCallContext()?.runId` (`tools/todo/index.ts:80`); a solo run is one message,
   so every message starts an empty list. The binding the memory owner check reads is `currentSessionTaint()`
   (`tools/memory/index.ts` `writerOfCall`): the run -> conversation taint map in `governance/provenance.ts`. The
   taint object carries no conversation id.
4. The cap: `turn.ts` `runPending` stops at `deps.maxToolCalls` with no warning before it.
5. A compaction during a run is refused today (`createSoloCompactor` `busy()` is true while any run streams), and it
   only replaces the STORED transcript: the in-flight request is `state.messages`, so a mid-run compaction must
   rebuild them (system prefix untouched, history re-read, the run's own messages kept: the same shape `runner.ts`
   `rebuild` uses for a park).

## Log
### Baseline (before any edit, load 5)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo packages/trent-core/src/model-gateway packages/trent-core/src/tools/todo`
-> `Test Files 48 passed (48)`, `Tests 413 passed (413)` (the pipe hid the exit code; re-run at the end).
`TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/runtime apps/cli/src/repl` -> exit 0, `Test Files 51 passed (51)`,
`Tests 335 passed (335)`.

### Step 1: `context_overflow` (`model-gateway/retry.ts`)
Wording sources, copied from fixtures that exist (none written from memory): OpenAI, Hermes
`tests/agent/test_error_classifier.py:998`; OpenRouter "This endpoint's maximum context length", Hermes
`tests/agent/test_output_cap_parsing.py:12`; vLLM "Requested token count exceeds the model's maximum context length",
Hermes `tests/agent/test_output_cap_parsing.py:222`; Anthropic "prompt is too long:
233153 tokens > 200000 maximum", Hermes `tests/agent/test_413_compression.py:1504`; Google "Unable to submit request because
the input token count is 32825 but model only supports up to 32768", Hermes `tests/agent/test_model_metadata.py:1699`
("Google Gemini/Gemma overflow phrasing (#57275)"); Ollama "the input length exceeds the context length", this repo
`fleet-memory/embedder-local.ts:9-11` (probed 2026-09-26) and `embedder-local.test.ts:162`; llama.cpp "request (70000
tokens) exceeds the available context size (65536 tokens)", Hermes `tests/agent/test_413_compression.py:1030`. The
negative: a local server's memory ceiling ending "Reduce context size." (Hermes `test_error_classifier.py:810-816`), so
the pattern never matches a bare "context size". No fixture in either tree carries LM Studio's own wording; not guessed.
- RED: new `model-gateway/retry.overflow.test.ts`.
  `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/model-gateway/retry.overflow.test.ts` -> exit 1,
  `Tests 8 failed | 1 passed (9)`: `expected { errorClass: 'validation', …(2) } to deeply equal { Object (errorClass,
  retryable, ...) }` for all seven providers and the SDK shape. The pass is the negative guard (today's behaviour).
- GREEN: `ErrorClass` gains `context_overflow`; `isContextOverflow` (one regex plus OpenAI's `code`) is asked after the
  auth check and before the `validation` fallback; `retryable: false`. Same command -> exit 0, `Tests 9 passed (9)`.
  Neighbours, one file each: `retry.test.ts` exit 0 (17), `ModelGateway.retry.test.ts` exit 0 (19),
  `orchestrator/auto-recovery.test.ts` exit 0 (15).

### Step 2: one compaction, one retry (`solo/overflow.ts`, new; `[C12]` hunks in `solo/{turn,runner,compaction}.ts`)
Decisions before code: the recovery is per RUN (a WeakSet on the run's state, as `repeat-stop.ts` counts), so a run
gets one compaction whatever call overflows; the compaction is S3's `compactConversation`, forced, through a new
`SoloCompactor.compactForRun(runId)` that keeps the run's own opening verbatim (the parked-run rule, `keepFrom`) and is
not refused as "busy" by the very run asking; the request is rebuilt as `runner.ts` `rebuild` rebuilds a park (the
system message object kept, history re-read, the run's own messages as sent). A compaction that shrank nothing ends the
run at once: re-sending the same request is not a retry. Every verdict names the window (`windowName`), or says where
to name it when this process does not know it.
- RED: new `solo/overflow.test.ts` (three cases, the runner's public API only).
  `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo/overflow.test.ts` -> exit 1,
  `Tests 3 failed (3)`: `expected 'run_failed' to be 'run_done'` (the council's red: the fake provider's
  context-length 400 ends the solo run `run_failed` today), `expected [] to have a length of 1 but got +0` (no
  compaction), `expected '1 of 1 steps failed: anthropic HTTP 4…' to contain 'context window (200,000 tokens)'`.
- GREEN: same command -> exit 0, `Tests 3 passed (3)`: calls `[turn, turn, turn, turn(400), summary, turn]`, exactly one
  summary, the system prompt of the refused request and of the retry byte-identical to the first turn's, the retry
  carries the summary and the run's opening and not the dropped `QUESTION-1`, no frame says `HTTP 400`; a second
  refusal ends the run with `context window (200,000 tokens)` and the provider's words after one summary; with nothing
  to compact, one call and a verdict naming the window.
  Neighbours, one file each, all exit 0: `solo/compaction.test.ts` (7), `runner.test.ts` (9), `budget.test.ts` (5),
  `stops.test.ts` (8), `delegate.test.ts` (9). Sizes: `turn.ts` 383, `runner.ts` 409, `compaction.ts` 349, `overflow.ts` 81.

### Step 3: a hosted window (`apps/cli/src/runtime/runner-for-mode.ts`)
Decision: no second table. The per-model window already lives in `model_overrides.<model id>.context_window`
(`config/sections/models.ts`; there is no `models.<alias>.context_window` key) and in the gateway's price table rows
(`pricing.ts`), and `pricing.ts` `contextWindowFor(model, alias, overrides)` already reads both, override first. A local
alias keeps the probe (the loaded window beats any configured figure). `soloWindowTokens` gains an optional `overrides`
argument; the on-demand solo runner's `soloWindowFallback` answers the same way without the probe.
- RED: new `apps/cli/src/runtime/runner-for-mode.window.test.ts` (its own small runtime harness, modelled on the C11
  file; routed fake gateway; no `windowTokens` seam, so the runtime works the window out).
  `TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/runtime/runner-for-mode.window.test.ts` -> exit 1,
  `Tests 2 failed | 1 passed (3)`: `expected undefined to be 1000000` (gemini-3.5-flash-lite has no window on a hosted
  route), `expected [] to have a length of 1 but got +0` (a 24,000-token override: no compaction before the eighth
  turn, because the threshold stayed at the fixed 64,000). The pass is the fallback guard (an unknown model keeps 64,000).
- GREEN: same command -> exit 0, `Tests 3 passed (3)`: the table (1,000,000; 200,000 for claude-sonnet-4-6; 128,000 for
  deepseek-chat under its alias), the override over the table (500,000) and for an unlisted id (32,000), an unknown model
  undefined, the local probe unchanged (16,384, override ignored); the 24,000-token window compacts before turn 8
  (`[..., summary, turn]`); an unknown model's eight turns compact nothing.
  Neighbours, one file each, all exit 0: `runner-for-mode.test.ts` (14), `runner-for-mode.cf.test.ts` (4),
  `runner-for-mode.constrained.test.ts` (5), `solo-continuity.test.ts` (5). The S2 test titled "absent on a hosted one"
  still passes unchanged (its model, `gemini-test`, is in no table); its title now describes the unknown-model case only.
  `runner-for-mode.ts` 426 lines. Hunk check (scratchpad `hunks.py`: every `git diff -U0` hunk of an edited file has a
  `[C12]` on an added line) -> exit 0 over `retry.ts`, `turn.ts`, `runner.ts`, `compaction.ts`, `runner-for-mode.ts`.

### Step 4: the todo list is the conversation's (`tools/todo/{index,store}.ts`; `[C12]` hunks in `governance/provenance.ts`, `solo/runner.ts`)
Decision: the key rides the binding the owner check already reads. `SessionTaint` gains an optional `key` (not in the
snapshot: the runner that owns the conversation knows it); `createSessionTaint(seed, key)`; the solo runner passes its
session id, or an id minted once per in-memory conversation (`defaultId`, not the `newId` seam, so no sequential test id
moves: the S3 log's lesson). The todo adapter files under `conversation:<key>` when `currentSessionTaint()?.key` is set,
else under the run id as before; the model-facing wording says "conversation" or "run" accordingly (the fleet's text is
byte-identical). `store.ts`: a header line only (the key is a string either way; bounds and pruning unchanged).
- RED: new `tools/todo/todo.session.test.ts` (unit, over the real binding) and `solo/todo-session.test.ts` (the real
  runner and the real adapter).
  `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/todo/todo.session.test.ts` -> exit 1,
  `Tests 1 failed | 2 passed (3)`: `expected 'the task list for this run is empty; …' to be 'tasks: 1 todo, 1 doing\nt1
  [doing] dr…'`. The passes are guards: another conversation's list is empty (trivially so today), and the fleet's
  per-run list is unchanged.
  `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo/todo-session.test.ts` -> exit 1,
  `Tests 1 failed (1)`: turn 3 `expected 'the task list for this run is empty; …' to be 'tasks: 2 todo\nt1 [todo] draft
  the ca…'`.
- GREEN: both commands -> exit 0 (`3 passed`, `1 passed`): turn 3 and turn 4 (after `compact({force: true})` ->
  `compacted`) list byte-for-byte what turn 1 wrote; a new process on the same session id reads the same list.
  Neighbours, one file each, all exit 0: `tools/todo/todo.test.ts` (3), `governance/provenance.test.ts` (11),
  `tools/memory/owner.test.ts` (6), `tools/memory/holds-owner.test.ts` (4), `solo/taint.test.ts` (5), `solo/park.test.ts`
  (7), `solo/holds.test.ts` (4), `solo/memory-writes.test.ts` (4). Hunk check -> exit 0 over the four edited files.

### Step 5: the wrap-up notice (`solo/wrap-up.ts`, new; one `[C12]` call in `solo/turn.ts`)
Decision: the note rides the tail of the request's last user message (the tool results), never a system message.
Evidence: `model-gateway/anthropic-client.ts:159-161` `systemBlocks` joins EVERY system message into the one cached
system block, so a system message added mid-run would move the frozen prefix; Hermes appends to the newest tool result
for the same reason (`agent/turn_iteration_prep.py`: "Only the current tool-result tail is mutable"). It says
"[system note] N tool calls left; wrap up. ...". Threshold: `min(ceil(0.8 x cap), cap - 1)`, none for a cap of 1
(25 -> 20, 10 -> 8, 2 -> 1). Once per run (WeakSet); it stays in the run's messages as history and is not stored in the
session.
- RED: new `solo/wrap-up.test.ts`.
  `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo/wrap-up.test.ts` -> exit 1,
  `Tests 2 failed (2)`: `expected [] to deeply equal [ '2 tool calls left; wrap up' ]` and `expected [] to deeply equal
  [ '5 tool calls left; wrap up' ]` (no note today).
- GREEN: same command -> exit 0, `Tests 2 passed (2)`: cap 10, requests 1-8 carry nothing, request 9 (after 8 calls)
  ends with the note, request 10 carries the same one note as history, every request has exactly one system message;
  the default cap warns after 20 calls (`5 tool calls left`); 7 of 10 calls: never told.
  Neighbours, one file each, all exit 0: `stops.test.ts` (8; the cap-of-2 stop, now told after 1 call, same verdict),
  `delegate.test.ts` (9), `runner.test.ts` (9), `budget.test.ts` (5). `turn.ts` 385 lines; hunk check exit 0.

### Acceptance: the scripted 60-turn session (`solo/long-session.test.ts`, new; `solo/fakes-c12.test-helpers.ts`, new)
Real runner, real `todo` adapter, a fake gateway that refuses the first call of turns 20, 40 and 60 with Anthropic's
400; window 200,000 tokens (the hosted figure a runtime now passes), `max_tool_calls` 10; turn 1 writes a three-item
plan, turns 3, 21 and 41 list it, turn 10 makes nine calls.
- RED (found by this test, not by step 2's): `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo/long-session.test.ts`
  -> exit 1, `Tests 1 failed (1)`: `expected [ 'run_done', …(58) ] to deeply equal [ 'run_done', …(58) ]`, runs 20 and 41
  `run_failed`. Diagnosed by logging the verdicts in a throwaway edit (the file restored from a scratchpad copy, md5
  `1c6d57bd…` before and after): turn 20, `one compaction could not shrink it (Not compacted during this run: nothing
  can be dropped without splitting a tool exchange.)`. With a 200,000-token window, S3's kept tail is a quarter of the
  window, 200,000 characters, which holds the whole transcript, so the forced compaction dropped nothing; turn 41 is the
  cascade (turn 20's unconsumed retry reply shifted the script). Step 2's own test passed only because it set a 1,200-char
  tail. This is the real case Hermes calls an unexplained rejection: the provider refuses what the local estimate
  says fits (a wrong table window, or 4 characters a token undercounting).
  First run also showed a harness slip: `overflow400` was imported from `overflow.test.ts`, which pulled that file's
  three tests into the run; it now lives in `fakes-c12.test-helpers.ts`.
- GREEN: `compaction.ts` `compactForRun` keeps at most HALF of what the stored conversation holds
  (`historyChars = min(the window's, transcript chars / 2)`): the provider's word beats this process's estimate, so a
  refusal always shrinks what came before the run. Same command -> exit 0, `Tests 1 passed (1)`: 60 of 60 `run_done`;
  no frame contains `HTTP 400` or `prompt is too long`; exactly 3 summary calls, each between the refused call and its
  retry; one system prompt across every turn request, the requests either side of each compaction included; turns 3,
  21 and 41 list byte-for-byte what turn 1 wrote; the wrap-up note introduced once (`2 tool calls left; wrap up`), only
  in turn 10's requests. `overflow.test.ts` exit 0 (3), `compaction.test.ts` exit 0 (7).

### Docs
`docs/solo.md`: the threshold row now points at the window rules; a new section "Long sessions" (one paragraph: the
refusal and its one compaction, the hosted window, the conversation's todo list, the wrap-up note, the 60-turn proof);
Limits: two bullets (one compaction per run and the unsplit summary call, the table's accuracy; the pre-send window
check is not compacted and now applies to hosted models, the todo description still says "this run"). A first draft
claimed "a local server cuts an over-long prompt silently"; false for llama.cpp, which refuses (step 1's fixture),
so the bullet was rewritten to the limit that is true. `docs-truth.test.ts` exit 0 (11), `docs-truth-pages.test.ts`
exit 0 (11).

## Verification (final, load 4-35)
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo` -> exit 0, `Test Files 32 passed (32)`, `Tests 168 passed (168)`.
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/model-gateway` -> exit 0, `20 passed (20)`, `258 passed (258)`.
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/todo` -> exit 0, `2 passed (2)`, `6 passed (6)`.
  (Baseline for these three: 48 files, 413 tests; now 54 and 432: exactly the 6 new files and 19 new tests.)
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/runtime` -> exit 0, `17 passed (17)`, `106 passed (106)`.
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/repl` -> exit 0, `35 passed (35)`, `232 passed (232)`.
  (Baseline for the two: 51 files, 335 tests; now 52 and 338: the new window file, 3 tests.)
- Wider pass over what `provenance.ts` and the new class touch: `npx vitest run packages/trent-core/src/governance
  packages/trent-core/src/tools/memory packages/trent-core/src/tools/delegate packages/trent-core/src/sessions
  packages/trent-core/src/orchestrator/auto-recovery.test.ts packages/trent-core/src/fleet-memory/embedder-local.test.ts`
  -> exit 0, `Test Files 30 passed (30)`, `Tests 351 passed (351)`.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0. `cd packages/trent-core && npm run build` -> exit 0 (both
  projects include their test files, so the new tests are type-checked too).
- `node scripts/ci/repo-scan.mjs` -> exit 0 (1336 files; every check `PASS - 0 violations`).
- Anchored marker grep (AGENTS.md) -> exit 1, 0 matches.
- Hunk check over the nine edited files -> exit 0, 47 hunks, each with `[C12]` on an added line. Sizes: largest
  `runner-for-mode.ts` 426, `runner.ts` 409, `turn.ts` 385, `compaction.ts` 358; all under 500.
- No model call, no network; `runtime/env.test.ts` and `docs/sessions/2026-09-26-resume-landing.md` (modified before
  this session) untouched. No commit, stash, checkout, reset or push.

## Files
New: `model-gateway/retry.overflow.test.ts`; `solo/{overflow,wrap-up}.ts`; `solo/{overflow,wrap-up,todo-session,
long-session}.test.ts`; `solo/fakes-c12.test-helpers.ts`; `tools/todo/todo.session.test.ts`;
`apps/cli/src/runtime/runner-for-mode.window.test.ts`; this log.
`[C12]` hunks: `model-gateway/retry.ts`, `solo/{turn,runner,compaction}.ts`, `governance/provenance.ts`,
`tools/todo/{index,store}.ts`, `apps/cli/src/runtime/runner-for-mode.ts`, `docs/solo.md`.

## Follow-ups (not done here, by scope)
1. The pre-send window check (`turn.ts` `overBudget`) still ends a run it predicts is over; it could take the same one
   compaction. With hosted windows set it now applies to hosted models too (rare: the automatic path compacts at half).
2. The summary call is not chunked: dropped turns longer than the window leave only the pruning (S3's summariser).
3. The council's "the plan in the context tier" (`solo/prompt.ts`) is not built: the list survives and `todo list`
   reads it, but it is not re-injected each turn as Hermes does after a compaction. The `todo` description says "this
   run" in solo; an `instructionsFor("solo")` text would fix it (and move `prompt-default.test.ts`'s measure).
4. `tools/todo/store.ts` prunes lists by first-write order (50 kept): a long conversation's list can be pruned after
   50 newer lists (delegated children, fleet runs). A touch on write for conversation keys would keep it.
5. `pricing.ts` windows: the Claude rows carry the 200,000 floor, `gemini-3.6-flash` and the bare `gemini-3.5` prefix
   carry none (those fall back to 64,000 characters).
6. LM Studio's own context-error wording is in no fixture here or in Hermes; it is matched only if it uses one of
   the covered phrases.
7. `runner-for-mode.test.ts` "the window ... is absent on a hosted one" still passes (its model is in no table), but
   its title now describes only the unknown-model case; not rewritten (a test is not edited to follow a change).
8. A park rebuilt after a restart past 80 percent may be told to wrap up a second time (the WeakSet is per state).
