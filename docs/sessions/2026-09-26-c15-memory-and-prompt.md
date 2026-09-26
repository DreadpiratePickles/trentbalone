# 2026-09-26 — C15: memory the agent can correct, and a prompt written for solo

Council item C15 (`02_plan/output/hermes-council-verdict-2026-09-26.md`, Tier 4). No commit, stash,
checkout, reset or push. No subagents (the brief says so). Every hunk in an existing file carries
`// [C15]`.

Owned (the brief's list, nothing else): `packages/trent-core/src/tools/memory/{store,index}.ts` and
their tests, `packages/trent-core/src/solo/prompt.ts` and its tests, `apps/cli/src/gateway/agent-handler.ts`
(the platform hint only) and its test, this log. Not touched: `docs/*.md` (the lines for `docs/solo.md`
are handed back), README, `governance/**`, `fleet-memory/**`, any file with `[C11]` marks. C11 is in
flight on `apps/cli/src/runtime/runner-for-mode.ts`, `config/sections/agent.ts` and the doctor's local
smoke, and calls `soloResponseFormat` (its name and signature stay).

## Read first
AGENTS.md; the rulebook's Universal Coding Rules and Phase 4; C15 and C2 in the council verdict;
`docs/solo.md`; `tools/memory/{store,index,holds,gate,blocks}.ts`; `solo/{prompt,runner,turn,types,
memory-gate,fleet-memory-port,router,hold-policy,delegate}.ts`; the S3 log; `apps/cli/src/gateway/agent-handler.ts`;
`apps/cli/src/runtime/{runner-for-mode,solo-continuity,headless}.ts` (read only); `governance/{provenance,
tool-call-context}.ts`; Hermes `tools/memory_tool.py` and `agent/prompt_builder.py`.

## Findings before code (facts, with where)
1. The memory adapter solo uses IS the fleet's: `apps/cli/src/repl/fleet-memory.ts:171` builds one
   `createMemoryAdapter` for the fleet-memory hook, and solo takes `hook.adapters` behind the provenance
   gate (`runtime/solo-continuity.ts:64-67`). One runtime can serve both modes (`runnerFor`, H3), so the
   mode cannot be a constructor argument even if the construction site were in reach (it is not). The
   writer has to be decided per call.
2. A solo run's tool calls, and only a solo run's, run bound to the conversation's taint:
   `solo/runner.ts:186` `bindSessionTaint(runId, ...)` (and the compaction flush, `solo/compaction.ts:197`);
   `governance/provenance.ts:180` `currentSessionTaint()` reads it back through the tool-call context. No
   fleet path binds one. A delegated solo child also binds, but its shared writes are refused before the
   adapter (`solo/delegate.ts:120-125`, `childAdapters`).
3. The provenance gate sits OUTSIDE the adapter (`governance/provenance.ts:262-275`): a tainted
   `replace` is held as a row before the adapter's layer gate is ever asked. So the hold is unchanged by
   anything done in `store.ts`/`index.ts`.
4. Approving a held write replays it through the UNWRAPPED adapter with no run context
   (`tools/memory/holds.ts:162-168`, `input.memory.execute(action, {})`). A replayed owner rewrite
   therefore reaches the adapter with no conversation bound.
5. The solo prompt names no platform, and there is no channel from the gateway handler to the prompt:
   `runtime.run(content, {trigger, signal, session})` -> `runner-for-mode.ts:337-345` copies named fields
   only -> `router.ts` `SoloConversation` has no platform -> `SoloRunnerDeps` has none -> `runner.ts:155`
   `buildSystemPrompt({ persona, stable, adapters })`. Every hop but the first and the last is outside
   this item's files.
6. Parallel calls: the solo turn runs a reply's calls ONE BY ONE, in order (`solo/turn.ts:4-9`,
   `:249-271`). Several calls per reply are supported; concurrency is not. The prompt must not promise it.

## Log
### Baseline (before any edit)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/memory packages/trent-core/src/solo apps/cli/src/gateway`
-> exit 0, `Test Files 25 passed (25)`, `Tests 171 passed (171)`. Load average 127 at the start.

Measured before any edit (scratch script over the REAL default build: `TrentConfigSchema.parse({}).toolsets`
through `buildTrentTools`, plus the hook's `memory`, `fleet_search`, `brain_read`; default persona; empty
stable tier): the default solo system prompt is 8,966 chars, about 2,242 tokens (chars/4), with "seat" 4
times and "founder" 8 times: `memory` 4 + 3 (its description), `human` 3, `clarify` 1, `session_search` 1.
Every implemented toolset: 9,842 chars, the same counts (deferred tools stay behind `tool_search`).
The stable tier of a fresh profile (real hook, `brain: false`) adds 437 chars with "seat" 3 and "founder" 2:
`fleet-memory/orchestrator-hook.ts:319` "(shared by every seat; writes land next run)" and the block
descriptions of `tools/memory/blocks.ts` — both outside this item's files (see Open items).

### Decisions (before code)
- The writer is decided per call: `owner` when the call runs bound to a conversation
  (`currentSessionTaint() !== undefined`, finding 2), else `seat`. No constructor option (finding 1).
- `owner` = every action inside a writable block; a `read_only` block is refused to it whatever
  `memory.consolidation_may_edit` lists (that list names the consolidation only). "Its own block" is read
  as every block the agent can write: in solo there is no other writer of `memory`/`user`, and a fact the
  model filed under `user` ("Lives in Leeds") must be correctable too.
- The fleet stays add-only (the plan: "an `owner` writer for solo"), so its tool text and its tests stand.
- The per-mode description: `memoryToolSchemas(blocks, mode)` and `MemoryAdapter.instructionsFor(mode)`;
  `adapter.instructions` stays the fleet's. The solo prompt asks an adapter for its solo text when it
  offers one (`solo/prompt.ts`), because one adapter instance serves both modes.
- The prompt: the persona stays replaceable (`brain/system/solo.md`); the new rules are fixed sections
  after it, so a custom persona keeps them. "founder" in OTHER adapters' text (`human`, `clarify`,
  `session_search`, block descriptions) is rewritten to "person" in the solo disclosure, the same way
  S1.1 C1 already rewrites their seat-contract wording; argument values in quotes are never touched.
- Parallel calls: the rule says several independent calls go in ONE reply and that they run one after
  another (finding 6). Nothing promises concurrency.
- The platform hint is the LAST section of the prefix, so the bulk of the prefix stays identical across
  platforms. The handler passes `platform`; the hops between (finding 5) are named, not built.
- No vitest `__snapshots__` file: the repo has none, and a byte snapshot of the whole default prompt
  would fail on any other wave's adapter wording. The "snapshot" test renders the real default prompt
  and asserts the counts and the size, printing the size.

### Red
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/memory/owner.test.ts` -> exit 1,
`Tests 4 failed | 2 passed (6)`:
- the literal replace: `expected { adapter: 'memory', …(4) } to match object { adapter: 'memory', …(1) }`,
  status `blocked`; the summary, printed by a scratch call inside a bound conversation:
  `memory(memory) refused: a seat may only add entries to MEMORY.md; "replace" changes an entry the block
  already carries. Entries are replaced, merged and removed by the scheduled memory consolidation, which the
  founder promotes.` (the C4 seat gate, `store.ts:174-183`).
- remove and the make-room batch: `expected [ 'blocked', 'blocked' ] to deeply equal [ 'completed', 'completed' ]`.
- the full block: `expected 'memory(memory) refused: the result wo…' to match /replace or remove/`.
- the per-mode schema: `expected [ 'add' ] to deeply equal [ 'add', 'replace', 'remove' ]`.
Green before the fix, kept as guards: the tainted replace is held (the provenance gate is outside the
adapter, finding 3) and the fleet seat's replace is refused.
- The prompt, against skeletons (`SOLO_RULES = ""`, `soloPlatformHint` returning ""; a first run without
  them failed on missing exports, which is not a valid red, so the skeletons went in first):
  `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo/prompt-default.test.ts` -> exit 1,
  `Tests 5 failed | 1 passed (6)`: `expected { seat: 4, founder: 8 } to deeply equal { seat: +0, founder: +0 }`;
  `expected '' to contain '## Using tools'`; `expected '### memory\nmemory: Add a durable not…' to contain '"replace"'`;
  `expected '' to contain 'You are talking over Telegram; keep r…'`; `expected '' to match /^You are talking over zulip; /`.
  The order test passed against the empty skeleton (an empty string is found at 0); it bites once the rules exist.
- The handler: `TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/gateway/agent-handler.test.ts` -> exit 1,
  `Tests 1 failed | 9 passed (10)`: `expected { trigger: 'manual', …(2) } to match object { trigger: 'manual', …(1) }`
  (no `platform` in the solo run's options).

### Green (one change at a time)
1. `store.ts`: `MemoryWriter` gains `owner`; `OWNER_WRITE_GATE`; `applyOperations` takes the writer (default
   `seat`) only for the over-cap advice: an owner is told to replace or remove in the same batch, a seat is
   told what it was told before. `checkMemoryWriteGate` needed no change: its read-only branch lists the
   consolidation only, and its rewrite refusal is the seat's.
   `index.ts`: `writerOfCall()` = `owner` when `currentSessionTaint()` is bound, else `seat`; the gate, the
   read-only refusal and the success line are the writer's own; `memoryToolSchemas(blocks, "solo")` and
   `instructionsFor(mode)`; `instructions` is the fleet's text, unchanged.
   `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/memory/owner.test.ts` -> exit 0, 6 passed.
   `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/memory` -> exit 0, 4 files, 50 passed
   (the fleet's C4 tests unchanged and green).
2. `prompt.ts`: the persona (identity and voice only), `SOLO_RULES`, `soloPlatformHint`, the `platform` slot
   last, the adapters' solo text and "person" for "founder" outside quotes.
   `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo/prompt-default.test.ts` -> exit 0,
   6 passed; printed: `[C15] default solo system prompt: 11370 chars, ~2843 tokens (chars/4), 16 adapters`.
   The same scratch measurement as before: 11,370 chars, seat 0, founder 0 (was 8,966, 4, 8).
3. `agent-handler.ts`: the solo branch passes `platform: message.platform` with the run.
   `TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/gateway/agent-handler.test.ts` -> exit 0, 10 passed.
4. Wording, after reading the rendered prompt whole: the held-write sentence says "held for the person's
   approval, or refused where nobody can approve it" (a cron or one-off surface refuses the hold,
   `solo/hold-policy.ts`), not that it always waits. Re-measured: 11,415 chars, ~2,854 tokens.

### Verified
- An approved held owner rewrite, checked by a scratch script (the real gate, `holdMemoryWrite`,
  `approveHeldMemoryWrite` with the unwrapped adapter): `held: needs_approval`, then `approve: true blocked |
  memory(memory) refused: a seat may only add entries to MEMORY.md; ...`, entries unchanged. The row is decided
  first (by design, `holds.ts:161`), so it stays approved and nothing is written. Open item 2.
- Dependents, one file at a time, all exit 0: `apps/cli/src/runtime/runner-for-mode.test.ts` (14),
  `headless.memory-gate.test.ts` (2), `solo-continuity.test.ts` (5), `doctor/checks/local-smoke-solo.test.ts` (6),
  `fleet-memory/memory-draft.test.ts` (6), `fleet-memory/consolidate.test.ts` (3),
  `fleet-memory/fleet-memory.orchestrator.test.ts` (5), `tools/tool-names.test.ts` (5), `tools/tools-index.test.ts` (9),
  `repl/__tests__/{solo,solo-continuity,delegate,fleet-memory,fleet-memory.wiring,approvals}` (3, 4, 1, 2, 9, 6).

### Final evidence
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/memory` -> exit 0, 4 files, 50 tests.
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo` -> exit 0, 22 files, 129 tests, twice in a row.
  One run between them exited 1 (1 file, 2 tests) while C11 was writing `solo/turn-settings.ts` in the same
  directory (mtime 03:39); the output was overwritten before it could be read, and the next two runs were green.
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/gateway` -> exit 0, 2 files, 12 tests.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.
- `cd packages/trent-core && npm run build` -> exit 0 (the first run failed on a cast in `owner.test.ts`,
  TS2352; fixed in the test).
- `node scripts/ci/repo-scan.mjs` -> exit 0, 1271 files, every check PASS.
- Every hunk in an existing file carries `// [C15]` (a scratch awk over `git diff -U3`, no hunk reported);
  no `[C11]` mark in any file edited here; every file under 500 lines (largest: `store.ts`, 417).

## Files
Changed: `packages/trent-core/src/tools/memory/store.ts`, `packages/trent-core/src/tools/memory/index.ts`,
`packages/trent-core/src/solo/prompt.ts`, `apps/cli/src/gateway/agent-handler.ts`,
`apps/cli/src/gateway/agent-handler.test.ts`.
New: `packages/trent-core/src/tools/memory/owner.test.ts`, `packages/trent-core/src/solo/prompt-default.test.ts`,
this log.

## Open items (outside this item's files; named, not built)
1. The platform hint does not reach the model yet. The handler passes `platform`, and `buildSystemPrompt`
   renders it; between them: `ModeRunInput`/`ModeRunOptions` gain `platform?: string` and `soloRunner().run`
   forwards it (`runtime/runner-for-mode.ts`, C11's file); `SoloRouteInput.platform` -> `SoloConversation.platform`
   in `open()` (`solo/router.ts`); `createSoloRunner({ ..., platform: conversation.platform })`;
   `SoloRunnerDeps.platform` (`solo/types.ts`); `buildSystemPrompt({ ..., platform: deps.platform })` at
   `solo/runner.ts:155`. A conversation's runner is built once, on its first message, so the platform of a
   thread's first message is the one its prefix keeps, which is right: a thread never changes platform.
2. Approving a held owner rewrite does not apply it (Verified, above). The fix is in `tools/memory/holds.ts`
   `approveHeldMemoryWrite`: when `decided.agentId === SOLO_SEAT`, replay inside a conversation of its own,
   with existing APIs only: bind a fresh taint to a run id of its own (`approval_<row id>`) with
   `bindSessionTaint(runId, createSessionTaint())`, run the replay inside
   `runWithToolCallContext({ runId, stepId: "<runId>-trent" }, replay)`, and `unbindSessionTaint(runId)` in a
   `finally`. Never the row's own `runId`: that would replace a live run's taint binding.
3. The stable tier still carries fleet words into a solo prompt: `fleet-memory/orchestrator-hook.ts:319`
   "## Company memory (shared by every seat; writes land next run)", the block descriptions in
   `tools/memory/blocks.ts` ("who the founder is ...", "shared facts every seat reads; edited by the founder or
   the heartbeat") and `renderBlock`'s "; read-only for seats" in `tools/memory/index.ts` (left alone: it is the
   fleet's prelude too). A fresh profile's stable tier: 437 chars, "seat" 3, "founder" 2.
4. Two refusals keep the fleet's words and are not reachable by a solo owner through the tool: the store's
   read-only refusal ("the founder edits it by hand", `store.ts:175`, reached only by a direct store call) and
   the adapter's delegated line ("This seat is delegated", `index.ts`; a solo child is refused earlier, by
   `childAdapters` in `solo/delegate.ts`).
