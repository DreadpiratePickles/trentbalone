# 2026-09-26 — S3: solo continuity (compaction, memory, skills on demand, delegation, checkpoints)

Wave S3 of `02_plan/output/solo-harness-design-2026-09-26.md` ("Waves": S3 session continuity,
compaction, memory, skills on demand, delegation, checkpoints in solo), with the council's S3 list
(`02_plan/output/solo-harness-review-2026-09-26.md`, chair "S3 (continuity)", B3, B5, A7, A8, A10, A11,
C5, top change 5). No cloud model call: every test drives a fake gateway. No commit, stash, checkout
or push. No subagents (the brief says so). S1 (e0e13ab) and S1.1 (35fd43b) are landed; S2 is finished
in the working tree, uncommitted; this wave builds on S2's files as they are, with `// [S3]` hunks.

Owned: `packages/trent-core/src/solo/**` (additive files, `// [S3]` hunks in existing ones),
`sessions/compaction.ts` (marked, additive), `tools/delegate/**` (marked: the solo child path),
`docs/solo.md` (extend), this log. The REPL and runtime hunks this wave needs for `/compact`,
`/resume`, the rollback note and the solo wiring are marked `// [S3]` in `apps/cli/src/repl/**` and
`apps/cli/src/runtime/runner-for-mode.ts` (S2's file). Other agents in flight: L1 (model-gateway/**,
orchestrator/**, `headless.ts` [L1] hunks), H5 (tools/browser/**), P3 (servers.ts, service-daemon.ts,
gateway setup, H1 trigger). Not touched.

## Read first
Rulebook, AGENTS.md, CONTEXT.md, the design, the review (all of it; B3, B5, A7, A8, A10, A11, C5, the
chair's S3 list), the S1, S1.1 and S2 logs, `docs/solo.md`; `solo/{types,runner,turn,prompt,parse,
events,holds,park,meter,router,session-store,fleet-memory-port,hold-policy,audit}.ts` and the fakes;
`sessions/{compaction,schema,SessionStore,SessionManager}.ts`; `tools/memory/{index,holds}.ts`;
`governance/{provenance,policy-dispatch,tool-call-context}.ts`; `checkpoints/{session,types,index}.ts`;
`tools/delegate/{index,types}.ts`, `orchestrator/delegate-port.ts`; `tools/skills/index.ts`;
`tools/todo/{index,store}.ts`; `fleet-memory/{tiers,orchestrator-hook}.ts` (the hook's `adapters` are
NOT wrapped by the gate chain: `orchestrator/index.ts:193` appends them after `buildTrentTools`);
`apps/cli/src/repl/{index,engine,commands,compact,checkpoint-commands,session-view,types}.ts`,
`repl/__tests__/solo.repl.test.ts`; `apps/cli/src/runtime/{headless,runner-for-mode}.ts`.

## Findings before code (facts, with where)
1. In the real wiring the solo `memory` adapter is NOT behind the provenance gate:
   `runner-for-mode.ts` hands `[...parts.tools.adapters, ...parts.fleetMemory.adapters]`, and the
   hook's `memory` is built bare (`fleet-memory/orchestrator-hook.ts`, `adapters: [memory, search, ...]`).
   S1.1's taint test wraps a fake with `provenanceAdapters` itself, so it never saw this. So today a
   web page read in turn 1 and a `memory` write in turn 2 is NOT held in a real solo session (B5's
   "S2 or S3 could append them after the chain" came true). Item (2) closes it.
2. There is no `/compact` REPL command today; the fleet compacts after each answer
   (`repl/index.ts` `afterAssistant`), and S2 switched that off for solo (no sink).
3. In solo, `delegate_task` reaches the orchestrator's port (`headless.ts` builds one port for the tool
   build), which answers `failed: no orchestration run is active` because only the fleet declares
   runs to it. Either way nothing is delegated.
4. `SoloCheckpoints.beginTurn()` drops the seat, so solo rows are ledgered as seat `agent` (A10).
5. The solo runner's `resume()` returns right after re-raising the gate, so a decision taken while the
   reader holds that gate (the REPL's card) is not acted on in the same stream; `drive()` does check.
6. Solo answers carry no `cost_cents`, so `total_cost_cents` of a solo session stays 0.

## Log
### Baseline (before any edit)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo packages/trent-core/src/sessions packages/trent-core/src/tools/memory packages/trent-core/src/tools/delegate packages/trent-core/src/tools/skills packages/trent-core/src/checkpoints apps/cli/src/repl apps/cli/src/runtime packages/trent-core/src/wrapped-modules.test.ts`
-> exit 1, `Test Files 1 failed | 72 passed (73)`, `Tests 1 failed | 519 passed (520)`. The one failure is not this
wave's: `repl/__tests__/boot.test.ts` "any other key skips the animation" (`no prompt appeared` after its own 15 s
deadline). `uptime` at the start: load averages 420 / 342 / 348 (the concurrent waves), so a live model smoke is
out of the question and wall-clock deadlines are fragile.

### Decisions (before code)
- Red first against SKELETONS (S2's practice), not against missing modules: every new export exists and does
  nothing, so each red is an assertion on behaviour.
- Compaction (item 1) is the runner's: `SoloRunner.compact({force})` for `/compact`, and the same call before a
  run's first model call when the stored transcript passes the threshold (C5: before the next turn, never beside
  it, under the solo meter, its model calls on the one ledger as seat `trent`). The order is prune, then
  `sessions/compaction.ts` `compactSession` (flush, summary, one event), with two additive options there:
  `keepFrom` (a parked run's opening is never dropped: `resume` after a restart needs it) and `force`.
  Prune: tool results before the kept tail become one-line stubs (content AND the stored record, because the
  replay renders from the record); if that alone brings the transcript under the threshold, no model is called.
  The flush writes ONLY through the conversation's own `memory` adapter (the one the model's calls go through,
  gated) inside a tool-call context bound to the conversation's taint (B3), so an untrusted page anywhere in the
  conversation holds the write. The summary uses fixed headings (A8) and is marked untrusted when the
  conversation's taint names untrusted sources.
- The frozen prefix: kept byte-identical across a compaction (the brief), NOT re-read from memory (A8 proposed a
  refresh; the brief wins): the flush's writes reach the next session's prefix, as Hermes and P2-7 do. What a
  compaction drops but the model still needs rides the CONTEXT tier, rebuilt every turn from durable state, never
  from the history: the invoked skills (the sidecar). The "approved plan" has no solo counterpart today, checked,
  not assumed: the todo list is keyed by run id (`tools/todo/store.ts`, `list(runId)`), a solo run is one turn,
  and compaction runs between turns, so no list is ever live across a compaction; nothing is re-injected for it.
- Limits: `agent.solo.compact_after_chars` when set, else half the effective window in characters (4 per token)
  when the window is known (C5), else 64,000; the kept tail is half of that. (Changed while implementing: the plan
  put the window first; an explicit setting now wins, because the person who set it meant it.) `agent.solo.auto_compact: false`
  turns the automatic path off; `/compact` still works.
- Memory writes (item 2): the fleet-memory hook's adapters are wrapped in solo with the provenance gate and the
  durable hold (`solo/memory-gate.ts`), the same wrapper and hold `buildTrentTools` gives its own adapters.
- Skills (item 3): the stable tier gets an index (name + one line per advertised profile skill); a completed
  `skill_view` of a skill (not of a bundled file) adds the name to the conversation's invoked set, saved in the
  sidecar; every later turn's context tier carries those bodies, read from the store at that turn.
- Delegation (item 4): `delegate_task`'s adapter asks the calling run's route first (`tools/delegate/solo-route.ts`,
  keyed by the tool-call context's run id) and the orchestrator's port only when the run has none. A solo run binds
  a route while it drives. `agent.solo.delegate`: `solo` (default) runs a child solo runner on a new session of the
  same store (a one-off conversation in memory stays in memory), `fleet` a child fleet run, `off` refuses. Depth:
  `agent.solo.max_delegation_depth` (default 2). The child's slice: the parent's tool calls left and cents left
  under `budget.per_run_cap`; its model calls are charged to the parent's run scope (one ledger, the parent's cap
  sees them) and its calls and cents are added to the parent's step. Children run one at a time (C10), holds deny
  (chair S3.4), no `human`/`clarify`, shared writes (memory, brain, skills) refused. The child starts from the
  parent's taint and what it reads is merged back, so delegation cannot launder a secret or a page. A fleet child
  cannot be seeded with the taint, so `fleet` is refused while the conversation is tainted.
- Checkpoints (item 5): `beginTurn(SOLO_SEAT)`; after `/rollback` in solo the runner appends one note to the
  conversation naming the turns and the paths undone (A10).
- REPL (item 6): a park in the continued session is offered at launch; `/resume` renders the resumed run as a
  turn (a 3-line engine hook); the runner's `resume` now acts on a decision taken while its reader held the
  re-raised gate. The answer message carries `cost_cents` (and tokens, model), so the session total is right.

### Red 1: trent-core, against skeletons
Skeletons first (final signatures, bodies that do nothing): `solo/{compaction,skills,delegate,delegate-route,
memory-gate}.ts`, `tools/delegate/solo-route.ts`, and the `[S3]` fields in `solo/types.ts`. `npx tsc` over the
package showed no error in `solo/`, `tools/delegate/` or `sessions/`.
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo/{compaction,memory-writes,skills,delegate,checkpoints,repl-affordances}.test.ts`
-> exit 1, `Tests 27 failed | 2 passed (29)`. The red line per item:
- (1) compaction: `expected undefined to match object { status: 'pruned', pruned: 1 }` (no `compact`), the same for
  `compacted` (summary, B3 held, B3 clean, parked run), `expected '' to contain 'October'` (the prefix test's flush
  never happened), `expected [ 'turn' ] to deeply equal [ 'flush', 'summary', 'turn' ]` (no automatic path).
  The first run of this file showed two reds for a WRONG reason, fixed in the test helper before any code: the
  helper routed a call to the flush script when its system prompt said "durable facts", and the memory tool's own
  block description says exactly that, so turns were answered from the flush script. It now matches the flush
  prompt's opening line.
- (2) memory: `expected { adapter: 'memory', …(3) } to match object { adapter: 'memory', …(2) }` (the write
  completed: MEMORY.md took a line derived from a web page), `expected { ok: false, reason: 'unknown' }` (no
  held row). Two passes, by design: the per-turn recall through S2's port is already right (a guard), and the
  clean write is the control.
- (3) skills: the prefix lacked `release-notes: Draft release notes from merged PRs`; the openings after a view
  lacked `BODY-MARKER-RN`; `state.saved.invokedSkills` undefined; `invokedSkillOf` undefined.
- (4) delegation: `delegate_task not_available: no delegation port is bound to this seat` in every case (today's
  behaviour, as the brief says), the child's system prompt still offered `### human`, the parent's network call
  after a child's `.env` read ran (`expected 'run_done' to be 'run_awaiting_approval'`).
- (5) checkpoints: `expected [ [ 1, 'agent', 'notes.md' ], … ] to deeply equal [ [ 1, 'trent', 'notes.md' ], … ]`
  (A10; the rollback itself already worked, the ledger is shared); no note (`role: 'assistant'` last).
- (6) `expected [ 'step_awaiting_approval', …(1) ] to deeply equal [ …(6) ]` (resume dropped the yes);
  `expected [ undefined, undefined ] to deeply equal [ 3, 3 ]` (no `cost_cents`).

### Green 1: trent-core
`solo/{compaction,skills,memory-gate,delegate,delegate-route}.ts` (real), `tools/delegate/solo-route.ts` (real) and
the marked hunks: `tools/delegate/index.ts` (the adapter asks `currentDelegateRoute()` before its port; the route
module re-exported), `sessions/compaction.ts` (`keepFrom`, `force`, `MemoryFlushReport.held`), `solo/types.ts`,
`solo/runner.ts` (394 lines), `solo/turn.ts` (the answer's cost), `solo/session-store.ts` (`transcript`/`replace`,
the cost metadata; the in-memory conversation now keeps stored messages), `solo/meter.ts` (`remaining`),
`solo/park.ts` (`invokedSkills`, only when present, so every S1.1 state reads back byte-identical).
One regression on the way, caught by S1's own tests: the compactor minted its run id (`newId("solo_compact")`)
before knowing it had anything to compact, which shifted every sequential run id in 21 S1/S1.1/S2 tests
(`expected [ 'solo_2' ] to deeply equal [ 'solo_1' ]`). The id is now minted only when a model call is due.
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo` -> exit 0, `Test Files 20 passed (20)`,
`Tests 116 passed (116)` (S1, S1.1, S2 and S3 together).

### Coordination change (coordinator, mid-wave)
Another session is landing S2+H3 and fixing a race in S2's files: do NOT edit `solo/router.ts`,
`gateway/GatewayManager.ts`, `apps/cli/src/gateway/agent-handler.ts` or its solo test. None of them had been
touched by this wave (`git status` shows them exactly as S2 left them). The router change this wave had planned
is NOT made; it is recorded here instead, and the same effect comes from a hook in this wave's own wiring file:
- Would have added to `SoloRouter` (router.ts): `compactConversation(input: { session?: string; conversation?: string },
  options?: { force?: boolean }): Promise<SoloCompactionOutcome>` = `entryFor(open(input)).runner.compact?.(options)`,
  refusing a one-off; and `noteConversation(input, text)` = `entryFor(open(input)).runner.note?.(text)`. Both open the
  conversation's runner if this process has not yet, with the router's own default hold policy.
- Instead: the runtime wiring keeps its own map of the runners it built per conversation key, and hands the router a
  `create` that returns the one already built. `/compact` and the rollback note reach the same runner the router
  drives, and a runner opened by `/compact` first is the one the router adopts on the conversation's first run.

### Runtime wiring (`apps/cli/src/runtime/solo-continuity.ts`, new; `[S3]` hunks in `runner-for-mode.ts`, 397 lines)
`soloAgentSettings` (validates `agent.solo.{delegate,max_delegation_depth,compact_after_chars,auto_compact}`, refuses a
wrong value with a CONFIG error), `soloMemoryAdapters` (the hook's adapters gated, holds filed in the profile),
`soloSkillsOf`, `soloDelegationFor` (a stored parent's child gets a new session of the same `SessionManager`, titled
`delegated: <task>`; a one-off's child stays in memory; the fleet child goes through the runtime's `fleetRun`), and
`conversationRunners` (the router's `create`, kept per conversation key: the stand-in for the router change above).
`runner-for-mode.ts`: the conversation's adapters are now `[tools, ...gated hook adapters]`; `beginTurn(seat)`
passes the seat; `skills`, `delegation`, `compaction` reach `createSoloRunner`; `ModeRunner.compact(session, {force})`
and `ModeRunner.note(session, text)`; `RunnerParts.checkpoints.beginTurn(seat?)`. S2's inline `config` block is
left exactly where it was (a copy for the children is built beside it), so S2's lines stay separable.
NOT red first, recorded: this wiring was written before `solo-continuity.test.ts`. Its first run failed for a harness
reason, not the code: the legacy `buildAdapters` seam wraps nothing, so a fake `web` read was never tagged untrusted;
the test now builds through S2's `buildTools` seam with the chain's two session-aware wrappers (the runtime's policy
dispatcher, then provenance), as `buildTrentTools` gives the real web adapter. Red was then checked after the fact
by reverting three hunks in place (backup in the scratchpad, restored, md5 `46f7b933…` before and after):
`Tests 4 failed | 1 passed (5)`: `expected 'Supplier deposits go to account 99.' not to contain 'account 99'` (the
ungated hook adapter), `expected [ … ] to have a length of 2 but got 1` and `… to contain 'agent.solo.delegate: off'`
(no delegation), `expected undefined to match object { status: 'compacted' }` (no `compact`). The one pass is the
wrong-value refusal, whose code was not reverted; it never showed red.
`TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/runtime/solo-continuity.test.ts` -> exit 0, `Tests 5 passed (5)`.
`npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.

### Red 2: the REPL (`apps/cli/src/repl/__tests__/solo-continuity.repl.test.ts`)
Same command with the REPL file -> `Tests 4 failed | 5 passed (9)` across both files before the REPL code:
`/compact` -> `timed out waiting for the REPL` (the command does not exist: "Unknown command"); the park offer ->
`expected '   ·     ·  …' to match /A run is waiting …\/resume to continue\./`; `/rollback` -> the next request did not
contain `/rollback undid turn 1 and after: notes.md restored` (the file WAS restored byte-exact: the ledger is shared).
The cost test passed (trent-core's `cost_cents` hunk was already in; its red was seen at the solo level).

### Green 2: the REPL
`repl/solo-commands.ts` (new): `/compact` (solo: the runner's `compact(session, {force: true})`; fleet: the session
compactor the REPL already runs after answers), `/resume` (the command only answers when the engine cannot run it),
`sessionParks` (this session's parks only: a gateway thread's park is resumed where it belongs), `parkOffers`,
`rollbackNote`, `replContinuity`. Hunks: `engine.ts` (499 lines: `resume?` dep, a `/resume` that finds a park runs
as a turn through `#runTurn(objective, source)`), `commands.ts` (merges `SOLO_COMMANDS`), `checkpoint-commands.ts`
(`ctx.onRollback` after a successful rollback), `types.ts` + `session-view.ts` (three ports), `index.ts` (offers
printed at launch before the first prompt, the ports and the engine's `resume`).
`TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/repl/__tests__/solo-continuity.repl.test.ts` -> exit 0,
`Tests 4 passed (4)`. `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.

### Found on the way (fixed in this wave's own files)
- The REPL's command invariant (`repl/__tests__/commands.test.ts` "every command, without exception ... changes its
  output when the state it reports on changes") failed once `/compact` and `/resume` existed:
  `expected [ 'compact', 'resume' ] to deeply equal []`. Not weakened: its context now carries the two ports as
  mutable state (`compactSession`, `parkedRuns`), mutated with the rest; both commands then change. `Tests 14 passed`.
- `/resume <id>` typed with an argument fell through to the command, which would have said a run was in flight;
  the engine's hook now matches `/resume` with or without arguments (it resumes this session's first park).
- `docs/solo.md` extended: compaction (and its two keys), memory and skills, delegation (the three modes, the slice,
  the depth key, what a child may not do), checkpoints, the answer's cost, the park offer and `/resume`; two limits
  replaced (delegation, the REPL park) and two stated (a fleet child is its own run on the ledger; no A9 markers).
  `npx vitest run apps/cli/src/commands/__tests__/docs-truth.test.ts` -> exit 0, `Tests 12 passed (12)`.

## Per item (red first, then what changed)
1. Compaction. Red: `expected undefined to match object { status: 'pruned', pruned: 1 }` and six more. Now the
   runner compacts (prune, flush, summary, event) before a run over its threshold and on `/compact`; the flush writes
   only through the gated memory adapter under the conversation's taint (a page read anywhere holds it; test: MEMORY.md
   unchanged, one hold with sources `web_extract`); the summary has the six headings and an untrusted marker when due;
   a parked run's opening is kept (a restarted process still resumes it); the prefix is byte-identical before and after
   although the flush wrote to the memory the stable tier shows (test); the calls are metered as their own run (seat
   `trent`). `/compact` in the REPL takes the same path (REPL test).
2. Memory. Red: the write after a page read COMPLETED (`expected { adapter: 'memory', …(3) } to match … needs_approval`),
   and in the real wiring (checked by reverting): `expected 'Supplier deposits go to account 99.' not to contain 'account
   99'`. Now the hook's adapters are behind the provenance gate and the durable hold in solo; approving the row writes the
   entry tagged `[provenance: untrusted via web_extract]`. Recall per turn through S2's port was already right (a guard).
3. Skills. Red: no index in the prefix, no body after `skill_view`, `invokedSkills` undefined. Now the prefix lists name +
   one line per skill; a viewed body rides every later turn's context tier, survives a compaction that dropped the view
   and a restart; a bundled-file view, a failed view or another tool is not an invocation.
4. Delegation. Red: `delegate_task not_available: no delegation port is bound to this seat` (today's behaviour). Now a
   child solo run on its own conversation returns its answer as the tool result; depth 2 (`agent.solo.max_delegation_depth`,
   the grandchild told `depth 3 exceeds the cap of 2`); the slice (calls left: `cap of 1 tool calls`; cents left:
   `2-cent slice`, the parent then stopped by its own cap with the child's spend on its step, 3 cents); `off` refuses,
   `fleet` runs a fleet child, refused while tainted; a child is not offered `human`/`clarify`, its held call and its
   memory write are refused; a secret a child read holds the parent's next network call (`network-after-secret`).
5. Checkpoints. Red: rows ledgered as seat `agent`. Now seat `trent`; a solo write rolls back byte-exact (solo test with
   the real `file_ops`; REPL test through `/rollback`); the conversation gets one system note naming the turn and paths.
6. REPL. Red: resume dropped the in-stream yes (`expected [ 'step_awaiting_approval', …(1) ] to deeply equal [ …(6) ]`),
   no offer at launch, no `cost_cents`. Now the continued session's park is offered (`A run is waiting on approval
   appr_test; /resume to continue.`), `/resume` runs it as a turn to the answer, and each answer carries its run's cost
   (`total_cost_cents` 1 after one scripted turn).

### Coordination update (coordinator)
S2+H3 landed as `d25b673`; the hold on `router.ts` and the gateway files is lifted. The landed commit carries none of
this wave's hunks (every `[S3]` mark is in the working tree only: `git show HEAD:<file> | grep -c '\[S3\]'` is 0 for all
ten edited S2/S1 files), so `git diff HEAD` now isolates S3 exactly. The router is left as landed: the hook in
`runtime/solo-continuity.ts` does the job, is tested, and a second route to the same runner would only add risk. Not
read or relied on: `gateway/queue/MessageQueue.ts` (d25b673) and the store regeneration fix (723ef22).

## Files (all S3 hunks marked `// [S3]`)
New, trent-core: `solo/{compaction,skills,memory-gate,delegate,delegate-route}.ts`, `tools/delegate/solo-route.ts`,
`solo/fakes-s3.test-helpers.ts`, `solo/{compaction,memory-writes,skills,delegate,checkpoints,repl-affordances}.test.ts`.
Hunks, trent-core: `solo/{types,runner,turn,session-store,park,meter,index}.ts`, `sessions/compaction.ts`,
`tools/delegate/index.ts`. New, CLI: `runtime/solo-continuity.ts` + test, `repl/solo-commands.ts`,
`repl/__tests__/solo-continuity.repl.test.ts`. Hunks, CLI: `runtime/runner-for-mode.ts`, `repl/{engine,index,commands,
types,session-view,checkpoint-commands}.ts`, `repl/__tests__/commands.test.ts`. Docs: `docs/solo.md`, this log.
Not touched: `solo/router.ts`, `gateway/**`, `apps/cli/src/gateway/**`, `fleet-memory/orchestrator-hook.ts` (no tier
builder needed exporting: the S2 port already reaches the hook's tiers), `headless.ts` (its diff is L1's `[L1]` hunk).
Sizes: largest touched `repl/engine.ts` 499, `runtime/runner-for-mode.ts` 397, `solo/runner.ts` 394; all under 500.

## Verification (final, 01:25-01:35, load average 424)
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo packages/trent-core/src/sessions packages/trent-core/src/tools/memory packages/trent-core/src/tools/delegate packages/trent-core/src/tools/skills packages/trent-core/src/checkpoints apps/cli/src/repl apps/cli/src/runtime packages/trent-core/src/wrapped-modules.test.ts`
  -> exit 0, `Test Files 81 passed (81)`, `Tests 558 passed (558)` (baseline: 73 files, 520 tests, the boot timing
  failure; that test passed this time).
- `cd packages/trent-core && npm run build` -> exit 0 at 01:12; exit 2 at 01:30 with 4 errors, ALL in
  `src/egress/CredentialBroker.ts` (`Duplicate identifier 'target'`, `Property 'endsWith' does not exist on type
  'CredentialTarget'`): another wave's uncommitted `src/egress/**` work (9 modified, 4 new files), not S3's. No error in
  `solo/`, `sessions/`, `tools/delegate/`.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.
- `node scripts/ci/repo-scan.mjs` -> exit 0 (1249 files; every check `PASS - 0 violations`).
- Wider regression pass over S2's surfaces: `npx vitest run packages/trent-core/src/a2a packages/trent-core/src/gateway
  apps/cli/src/gateway apps/cli/src/commands/__tests__ packages/trent-core/src/governance` -> exit 1, `Tests 1 failed |
  1727 passed | 1 skipped`: the one is `gateway/platforms/discord.wire.test.ts` (`hb.d` null: the heartbeat raced the
  first dispatch), the timing failure S2's log already records; no gateway code was touched here.
- `npx vitest run apps/cli/src/commands/__tests__/docs-truth.test.ts` -> exit 0, `Tests 12 passed (12)`.
- Anchored marker grep over the S3 files -> exit 1 (0 matches). No live model call was made in this wave.

## Follow-ups (not done here, by scope or by ownership)
1. `docs/configuration.md` does not list `agent.solo.{delegate,max_delegation_depth,compact_after_chars,auto_compact}`
   (not this wave's file); `config/sections/agent.ts` keeps `agent` a passthrough, so they are validated where read.
   Moving them into the schema would refuse a wrong value at config load rather than at runner build.
2. Council A9: interrupted and failed turns get no marker, so their cost reaches the ledger but not the session total.
3. Council A7's `/skill <name>` REPL command is not built; `skill_view` is the only way to load a skill.
4. A fleet child is its own run on the ledger and not under the parent's per-run cap (its cents are added to the
   parent's step as it reports them).
5. The frozen prefix is per process: a restarted process rebuilds it from current memory (its first turn misses the
   prefix cache, and sees what earlier flushes wrote).
6. `/context`'s compaction count does not count solo compactions.
7. With the router hold lifted, the router change recorded above could replace the hook; nothing requires it.
8. A park is offered in the REPL for the continued session only (`trent solo -c`); a plain `trent solo` launch
   starts a new session and does not list an older session's park (`trent approvals list` does).
