# 2026-09-26 — S2: solo surfaces (mode, flags, the runner port on every surface)

Wave S2 of `02_plan/output/solo-harness-design-2026-09-26.md` ("Surfaces and configuration"), with the
council's S2 items folded in as the coordinator ordered (A1, A2, A3, B4, B8; A12 is implied by B4):
`02_plan/output/solo-harness-review-2026-09-26.md`. No cloud model call: every test drives a fake
gateway. No commit, stash, checkout or push. S1.1 hardens `solo/{turn,parse,prompt,runner}.ts` in
parallel; this wave adds files beside them and edits none of them.

## Read first
Rulebook, AGENTS.md, the design ("Surfaces and configuration"), the S1 log (public API and follow-ups),
the council review (Reviewer A, B4, B8, the chair's S2 list), `solo/{types,runner,turn,meter,events,
prompt,index}.ts`, `agent-runner/index.ts`, `runtime/headless.ts`, `repl/{engine,index}.ts`,
`gateway/{GatewayManager,RunApprovalLink,ConversationQueue}.ts`, `apps/cli/src/gateway/agent-handler.ts`,
`a2a/TaskLifecycle.ts`, `commands/groups/{run,cron,service-daemon,servers,protocol-runtime}.ts`,
`commands/{index,registry}.ts`, `fleet-memory/{orchestrator-hook,brain-prompt,tiers}.ts`,
`sessions/{schema,SessionManager}.ts`, the app's `orchestrator-runtime.ts` `auditTransition` (the
fleet's audit rows go through the app store's `addAudit`).

## Decisions (before code)
- Precedence: a launch override (`--solo`, `trent solo`, `trent run --solo`) beats `agent.mode` in
  config, which beats the default `fleet`. The override lasts for that one launch; nothing is written.
- The router lives in trent-core (`solo/router.ts`, additive): one solo runner per conversation
  (A2). A conversation is a profile session id (REPL session, gateway thread's session) or an
  in-process key (an A2A context); a run with neither is a one-off. The router maps run id -> runner
  for approve/reject/answer/resume, tees every frame to the runtime's bus hooks, trace sink and the
  audit sink (A12, B4), and tells a listener when a decision lands on a run nobody is streaming (the
  late decision the gateway resumes on).
- A1: a profile-session conversation is backed by `SessionManager` and the runner is its only writer;
  the REPL's conversation sink and the agent handler's appends are off in solo.
- B8: hold policy per conversation. `park` (the REPL; the gateway when `gateway.owner` is set),
  `questions` (A2A: an `ask_human`/`clarify` question parks and the peer's next message on the task
  answers it; a side-effect hold is refused, a peer never approves), `deny` (everything else: cron,
  heartbeat, one-off runs, `trent run` without a terminal, ACP). A refused hold never reaches the real
  `dryRun`, so no bound row is filed for a call nobody can decide.
- A3: the REPL keys a gate per step until the step moves on (`step_approved`, `step_output`,
  `step_end`), so a solo run's second held call opens its own card.

## Log
### Baseline (before any edit)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/runtime apps/cli/src/commands/__tests__ apps/cli/src/repl packages/trent-core/src/solo packages/trent-core/src/gateway packages/trent-core/src/a2a packages/trent-core/src/service packages/trent-core/src/wrapped-modules.test.ts`
-> exit 1, `Test Files 2 failed | 122 passed (124)`, `Tests 1 failed | 1762 passed | 1 skipped`. Neither is S2's:
`commands/__tests__/approvals.test.ts` cannot load `@trent/core/governance/auto-review-audit.js` (another
wave's H1 work in flight), and `gateway/GatewayManager.test.ts` "ignores an unpaired sender ... after
pairing" received the second Telegram update after pairing (a timing race under the machine's load).

### Red 1: trent-core additions (skeleton modules that do nothing)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo/{router,session-store,audit,fleet-memory-port}.test.ts packages/trent-core/src/a2a/solo-continuation.test.ts`
-> exit 1, `Test Files 5 failed (5)`, `Tests 18 failed | 2 passed (20)`. Every failure is an assertion on
behaviour (`expected [ [ 'all', undefined, 'park' ] ] to deeply equal [ [ 'session:thread-a', ...`,
`expected [] to deeply equal [ 'user', 'assistant', 'tool', ...`, `expected [] to include 'company-memory'`,
`expected 'failed' to be 'input-required'`, the audit rows `expected [] to deeply equal [...]`). The two
passes are guards that already hold: a decision for an unknown run is refused, and a peer's message
does not approve a held post (today's lifecycle starts a new run; the guard keeps it that way).

### Green 1: trent-core additions
`solo/{hold-policy,router,session-store,audit,fleet-memory-port}.ts` (new) and the marked `[S2]` hunks in
`a2a/TaskLifecycle.ts` (the A2A context is the conversation; a task parked on a question is continued by
answering it and resuming the same run). `solo/holds.ts` was renamed `hold-policy.ts` on the way: S1.1
added a `holds.test.ts` of its own (the runner's B6 rule), and two meanings of one name invite a collision.
Audit test adjusted BEFORE the implementation, after reading the app: the fleet writes a decision with
actor `agent` (`orchestrator-run-worker.ts:94,113` through `auditTransition`), not `user`, so "the same
rows" means `agent`. `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo/{router,session-store,audit,fleet-memory-port}.test.ts packages/trent-core/src/a2a`
-> exit 0, `Test Files 12 passed (12)`, `Tests 79 passed (79)`.
Note: the whole `solo/` directory is red right now for S1.1's own tests in flight (`gate.test.ts` B2,
`holds.test.ts` B6, `taint.test.ts` B1; 10 failures, none in an S2 file).

### Red 2 / Green 2: `apps/cli/src/runtime/runner-for-mode.ts` and the headless hunks
Red against a skeleton (`resolveAgentMode` always fleet, no `runner`/`mode` on the runtime):
`TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/runtime/runner-for-mode.test.ts` -> exit 1,
`Tests 8 failed (8)` (`expected 'fleet' to be 'solo'`, `expected undefined to be 'fleet'`, `expected +0 to be 1`,
`expected [] to deeply equal [ { kind: 'run_start', ...`). Green after the real file and the headless hunks:
same command -> exit 0, `Tests 8 passed (8)`. `headless.ts` stays under 500 (481): the fleet run body moved
into a local `fleetRun`, and `pinnedElsewhere` moved to `runner-for-mode.ts` (headless still calls it).

### Red 3 / Green 3: the launch override (`--solo`, `trent solo`)
`solo-mode.test.ts` red: `Tests 4 failed | 2 passed (6)` (`expected 2 to be +0` for `trent solo`, `expected [...]
to include 'solo'`); the two passes are guards (bare `trent` names no mode; a solo launch writes nothing).
Found on the way and fixed because `--solo` needs it: `trent --profile work` printed the usage text and never
opened the REPL, because `hasOperand` counted the profile's NAME as an operand (probe: exit 0, no REPL,
the usage on stderr). `operands()` now skips the value of `--profile`/`-p`. Green: exit 0, `Tests 6 passed (6)`.
Files: `commands/registry.ts` (`--solo` in the global set, so every command carries it), `commands/index.ts`
(`soloSpec`, the root `--solo`, the alias routed through bare `trent`'s first-run path, `RunResult.mode`),
`commands/context.ts` (`startRepl` takes the mode).

### Red 4 / Green 4: the REPL in solo (`repl/__tests__/solo.repl.test.ts`)
Red: `Tests 3 failed (3)`: the fleet ran (`the fleet must not run in solo mode`), no banner, the session held
`[ 'user', 'user' ]`. A3 red for its own reason, with the solo wiring in place and the old per-step key
(`MOVES_ON` emptied for the check, then restored): `timed out waiting for the REPL` at the second card.
Green: `Tests 3 passed (3)`; the whole `apps/cli/src/repl` suite: exit 0, `Test Files 32 passed`, `Tests 219 passed`.
`repl/index.ts`: the mode is resolved before the conversation opens (it decides the writer), no sink in solo
(A1; the fleet's compaction therefore never touches a solo session), `holds: "park"`, the banner line, the
runner by mode, `bindApprovalAnswers(runtime.runner)`. `repl/engine.ts`: the gate key moved to
`repl/gate-keys.ts` (A3), which also brings the engine from 499 to 496 lines.

### Red 5 / Green 5: `trent run --solo` (`commands/__tests__/run-solo.test.ts`; `run.test.ts` is at 470 lines)
Red: `Tests 5 failed (5)`: the fleet ran under `--solo` (exit 2 from the fake orchestrator's throw), the result
had no `mode`, `--resume` on solo reached the orchestrator (exit 3, not 2). `run.ts` was at 499 lines, so the
stdout routing moved verbatim to `groups/run-output.ts` first (`RUN_LOG_MAX_BYTES` re-exported from `run.ts`),
then: the override reaches the runtime, `mode` on the `system` line and the result, a solo hold parks only
when a person reads the terminal (text mode on a TTY; otherwise refused, B8), `--resume` refused on solo.
Green: `run-solo`, `run`, `run-text-log`, `run-model`, `run-verdict`: exit 0, `Test Files 5 passed`, `Tests 42 passed`.

### S1.1 landed mid-wave (coordinator): wire its API
Read `docs/sessions/2026-09-26-s1-1-solo-hardening.md`. S1.1 added `solo/holds.ts` (its B6 rule); mine had
already been renamed `hold-policy.ts`, so no collision. Its two changed S1 expectations are noted: `parked()`
entries carry `approvalId`, and a new run on a conversation with a parked run appends one `["tool","blocked"]`
"not run" line (B9); no S2 test depended on either.
Red 6 (restart, `router.test.ts` "after a restart"): `Tests 2 failed | 8 passed (10)`: `expected [] to deeply
equal [ ObjectContaining{…} ]` (a new process listed no saved park) and `expected false to be true` (an approve
in the new process found no run). Green 6: `savedSoloParks` (`session-store.ts`, reads the sidecars),
the router's `saved` option (every saved park's session opened once, on the first call that needs a run this
process did not start) and `sweep()` (a parked call whose bound row left the pending set was decided by
`trent approvals`: announced once as a late decision, so a driver resumes it). `router` + `session-store`
tests: exit 0, `Tests 14 passed (14)`.
S1.1 wiring in `runner-for-mode.ts` (items 1 and 2 of the coordinator's list): a profile-session runner gets
`sessionId` and `state: sessionStoreState(sessions.getStore(), sessionId)`; every runner gets the tool build's
`bindings` (`currentBoundApprovals()`, the store `buildTrentTools` installed, which `ToolWiring` does not
expose); `agent.solo.max_tool_result_chars` -> `config.maxToolResultChars`; the window -> `config.contextWindowTokens`
from `soloWindowTokens` (on a local alias only: L0-2's `readContextWindow` probe, `models.local.context_tokens`
when the server cannot be asked; nothing on a hosted provider). `createRunnerForMode` became async for the probe.
Not red-first, recorded: these tests were written right after the code. Red was checked after the fact by
removing the three mappings (scratchpad copy, restored): `Tests 3 failed | 1 passed` (`expected ... to contain
'[truncated: ...'`, `expected [ { role: 'executor', ... } ] to deeply equal []`, `expected [] to deeply equal
[ ObjectContaining ]`); the pass is `soloWindowTokens`' own unit, which never saw red. Green: exit 0, `Tests 12 passed (12)`.

### Red 7 / Green 7: the gateway resumes after a late decision (`gateway/GatewayManager.resume.test.ts`)
Red: `Tests 3 failed (3)` (`waitFor: timed out`: no reply reached the thread; `m.resumeRun is not a function`).
`GatewayManager.ts` (`// [S2]` hunks): `RunResumer` (thread of a run, resume, late-decision subscription,
sweep), `options.resumer` / `setResumer`, `resumeRun(runId)` on the thread's lane with `enqueue` (a resume
never interrupts a running turn, whatever the double-texting policy) and the reply sent there; the sweep runs
once at start (rows decided while the gateway was down) and on each drain tick; `stopAll` unsubscribes.
One test expectation fixed after the first green run: the Telegram adapter sends `chat_id` as a number.
Green: exit 0 for the file. The whole `gateway/` directory then showed 3 failures that are not S2's:
`registry.test.ts` (modified by the H3 webhook wave, in flight) and the Discord wire test (a timing failure).

### Red 8 / Green 8: the gateway end to end on solo (`apps/cli/src/gateway/agent-handler.solo.test.ts`)
The real Telegram adapter against the local fake Bot API, a real `GatewayManager`, the real approval
bridge and link, the solo router over the profile's `SessionManager`. Red (skeleton exports so the module
loads; the handler still on its fleet path): `Session  not found`: the message was not run on the thread's
session. Green after `agent-handler.ts` (`// [S2]`: the solo path runs on the thread's session with no
appends and no history, remembers each run's thread; `createRunThreads`; `createRunResumer`, which finds a
run's thread from this process's record or, for a park from before a restart, from the session's entry in
the gateway store's thread map) and the wiring in `servers.ts` (gateway start) and `service-daemon.ts`
(`holds` park only with `gateway.owner`, else deny; the resumer; `runtime.runner` as the link's target):
`npx vitest run apps/cli/src/gateway` -> exit 0, `Tests 10 passed (10)`; gateway-start, service, servers,
heartbeat -> exit 0, `Tests 43 passed (43)`. `servers.ts` is being edited concurrently by the H3 webhook
wave (its `[H3]` hunks); the S2 hunks touch only the four lines above, each marked.

### Red 9 / Green 9: cron (`commands/__tests__/cron-solo.test.ts`; `cron.test.ts` is at 411 lines) and the child
Red: `Tests 3 failed | 13 passed (16)`: the child's argv had no `--solo` (`[... 6]` vs `[... 7]`), `--solo` reached
neither runtime (`[ [ null, null ], ...`), and a solo cron job exited 5 (the fleet ran). Green after
`child-run.ts` (`mode: "solo"` -> `--solo` on the child's argv) and `cron.ts` (`--solo` on `cron run|start`
reaches `openRunner`; `cronJobRun` hands the child the launch's mode, or the in-process runtime's when that
is solo; an in-process job's run is `holds: "deny"`): cron-solo, child-run, cron, cron-queue, service ->
exit 0, `Tests 57 passed (57)`.

### Red 10 / Green 10: the two seams H3's webhook routes need (coordinator, mid-wave)
`runner-for-mode.test.ts` "the two seams the webhook routes need (H3)". Red: `runnerFor is not a function` (both).
First green attempt left one red, for a real reason worth recording: `expected 'run_done' to be
'run_awaiting_approval'`. A solo run's ring is its conversation's (S1.1 B1), and the runner binds it only
when it starts DRIVING the run, after `run_start`/`step_start`; the engine seeds on the first frame, so the
seed landed in the dispatcher's per-run ring, which a bound run never reads. Fix, inside S2's files only:
`seedInbound` writes the seed at once (the fleet's ring) AND leaves it waiting; the solo runner's adapters
write a waiting seed on the run's first gate question, call or dry run (`seededOnFirstCall`), inside the
run's context, into the ring the call is judged against. The dispatcher is created by the runtime
(`runtimePolicy`: the shipped rules plus `policy.rules`, as `buildTrentTools` makes it) and handed to the
tool build through a 2-line `[S2]` passthrough in `repl/tools.ts` (`ToolWiringDeps.policy`).
Green: `Tests 14 passed (14)`: `runnerFor(mode)` hands out either runner whatever the launch mode (the other
built on first use; its window from the configured local figure, no probe), and a seeded webhook run's first
`social_post` parks on `Policy rule send-after-untrusted` while the same run unseeded posts.
`servers.ts` H3 hunk: `runnerFor: (mode) => runtime.runnerFor(mode)` and `seedInbound`, both `// [S2]`. H3's own
comment two lines above ("a route whose mode is not this runtime's is answered 503") is now stale; it is
H3's line, left for them.

### Red 11 / Green 11: docs-truth and the docs
Red after `solo` was registered: `docs-truth.test.ts` "states the command counts the registry actually has"
-> `expected [ 35, 151 ] to deeply equal [ 36, 152 ]`. README line 255 edited (that line only):
"36 commands, 152 with their subcommands". New `docs/solo.md` (turning it on and the precedence; the
conversation; held calls by surface; restart; spend and audit; limits), indexed in `docs/README.md`.

### Verification pass 1 (the brief's command)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/runtime apps/cli/src/commands/__tests__ apps/cli/src/repl packages/trent-core/src/solo packages/trent-core/src/gateway packages/trent-core/src/a2a packages/trent-core/src/service packages/trent-core/src/wrapped-modules.test.ts`
-> exit 1, `Test Files 3 failed | 144 passed (147)`, `Tests 3 failed | 1924 passed | 1 skipped`. Two were S2's, fixed:
- `registry.test.ts` "solo: emits parseable JSON": every command must answer `--json --dry-run` with exit 0 in a
  profile with no config; the alias took the first-run path (exit 3). `--dry-run` now reaches `soloSpec`, which
  reports `{ dryRun, command: "solo", launch: "repl", mode: "solo" }`.
- `gateway-webhooks.test.ts` (H3's): its fake runtime predates the two seams, so `runtime.runnerFor` threw and the
  route answered 500. The servers.ts wiring now falls back to the old rule (the runtime's own mode, no seed) for a
  runtime without them, as the link's `runtime.runner ?? runtime.orchestrator` already does.
  Rerun of the three files: exit 0, `Tests 770 passed`. `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.
The third is not S2's: `wrapped-modules.test.ts` 500-line ceiling -> `packages/trent-core/src/tools/index.ts` at 506
lines, a file S2 never edited (modified in the tree by another wave).

### Verification pass 2
Same command -> exit 1, `Test Files 3 failed | 146 passed (149)`, `Tests 6 failed | 1925 passed | 1 skipped`, none S2's:
`wrapped-modules.test.ts` (`tools/index.ts` at 506 lines at that moment; 499 when rechecked), `local-gateways.test.ts`
(the L1 wave's new file; passing on recheck), and 3 in `headless.test.ts` whose `deps.model` now carries
`memory.embedder`: the L1 wave's `[L1] appEmbedder` hunk landed in `headless.ts` during this run (it passed 77/77
in the runtime directory before that hunk). `cd packages/trent-core && npm run build` -> exit 2, one error, in the
untracked `orchestrator/seat-constrained.test.ts` (another wave's red test); earlier in the session the build's
errors were all in `tools/browser/**` (the browser-attach wave), since fixed by its owner. No error in any S2 file.
`npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0. `node scripts/ci/repo-scan.mjs` -> exit 0. The anchored
marker grep over the new S2 files -> exit 1 (0 matches).

## Which surfaces read what (as built)
| Surface | Runner | Conversation | Holds (solo) | `--solo` read |
|---|---|---|---|---|
| REPL (`trent`, `trent solo`, `trent --solo`) | `runtime.runner`; approvals `bindApprovalAnswers(runtime.runner)` | the REPL session, runner the only writer | park; a card per held call | yes |
| `trent run` | `runtime.run` | one-off | park on a TTY in text mode (exit 7), else deny | yes |
| gateway (`gateway start`, the service daemon) | handler -> `runtime.run({session})`; link -> `runtime.runner`; `RunResumer` | the thread's session | park with `gateway.owner`, else deny | `gateway start` yes; daemon follows `agent.mode` |
| cron | `runtime.run(..., holds: deny)`; pinned child gets `--solo` | one-off | deny | `cron run`, `cron start` |
| heartbeat, jobs, goal, mcp serve | `runtime.run` unchanged | one-off | deny | no (follow `agent.mode`) |
| A2A | `runner` with `answer`/`resume`; TaskLifecycle continues a question | the A2A context | questions | yes |
| ACP | `runner` | one-off | deny | yes |
| webhook routes (H3) | `runtime.runnerFor(route.mode)`; `runtime.seedInbound` | one-off | deny | n/a |
| TUI | its own orchestrator (unchanged) | - | - | no: fleet only |

## Not done here (by scope, or left to the owners)
- REPL: a park left by a killed REPL session is kept (S1.1's sidecar) but the REPL does not offer to resume it.
- Solo sessions record no `cost_cents` on their messages, so `trent sessions` shows 0 cents for them and a
  `-c` ticker restarts at 0 (the ledger is right: `trent usage`).
- ACP denies every hold (no continuation channel without editing ACP's files).
- The fleet's compaction is off for solo sessions (council B3); S3 replaces it.
- H3's comment at `servers.ts` above the webhook wiring still says a route of the other mode is answered 503.

### Verification pass 3 (final)
Same command -> exit 1, `Test Files 1 failed | 148 passed (149)`, `Tests 3 failed | 1928 passed | 1 skipped (1932)`.
The one file is `apps/cli/src/runtime/headless.test.ts`, the three `deps.model` equality tests broken by the L1
wave's in-flight `appEmbedder` hunk in `headless.ts` (not an S2 line). Every S2 test passes.
`node scripts/ci/repo-scan.mjs` -> exit 0.

### Red 12 / Green 12: the late-approve resume race (lead's fix-up before landing)
Symptom: `TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/gateway/agent-handler.solo.test.ts` failed 3 runs in 4
(reproduced here 2 of 2, exit 1): `waitFor: timed out` waiting for "Posted: the oak tables are in." on thread 555.
Diagnosis: an instrumented scratch copy of the test (deleted afterwards) logged the failing run. The approve DID resume the
run: the router announced `late solo_1`, the resumer called `resume solo_1`, `social.calls` held the post, `parked()` was
`[]`, and the reply was in the outbound queue with "Hello from thread 777.": `pending: ["Hello from thread 777.",
"Posted: the oak tables are in."]`. Drain log: `drain#0 start` (the card) ... `drain#1 start draining=true` -> `{sent:0}`
(777's reply) ... `late solo_1`, `resume solo_1`, `drain#5 start draining=true` -> `{sent:0}` (555's reply) ...
`drain#0 end {sent:1}`. The solo router, runner and resumer are not at fault; the reply was queued and never sent.
Root cause: `MessageQueue.drain()` (`gateway/queue/MessageQueue.ts:104` before the fix) returned at once when a pass
was in flight, and that pass only walks the rows it read when it started (`:107`). `GatewayManager.send()` ("attempts
delivery immediately") therefore dropped its attempt whenever another send was still awaiting its platform. The
interleaving: the run parks, the link's `void sendApproval` (`RunApprovalLink.ts:113`) starts pass #0, which awaits
Telegram; the fake server records a request before it answers (`testing/fakeServer.ts:57`), so the test's
`waitFor(sent().length === 1)` passes while pass #0 is still in flight; the resumed run's reply is queued and its
drain returns `{sent:0}`; pass #0 ends with the card only. The test never starts the manager, so there is no drain
tick (`drainIntervalMs: 20` was dead config) and the reply waits forever. That is also why a 60 s wait did not
separate "slow" from "lost": a run that lost the race had nothing that would ever send it. In a started gateway the tick
delivers it up to `drainIntervalMs` (default 1000 ms) later, so the product defect is latency, not loss. It hits every
reply, not only solo's: 777's ordinary reply was stuck the same way.
Red (both deterministic, no timing): `packages/trent-core/src/gateway/queue/MessageQueue.test.ts` "[S2] a drain asked for
while a pass is in flight is not dropped" (the card's send waits on a promise the test releases) -> exit 1,
`Tests 1 failed | 5 passed (6)`, `expected [ 'card' ] to deeply equal [ 'card', 'reply' ]`.
`agent-handler.solo.test.ts` "the reply to a late approve reaches the thread even when it is queued while the card is
still being delivered" (the fake Bot API holds its answer to the card until the resumed run's reply is in the queue)
-> exit 1, `Tests 1 failed | 1 passed (2)`, `waitFor: timed out` at `:162`, after the run had resumed and the reply was queued.
Green: `MessageQueue.drain()` (`// [S2]`): a drain asked for while a pass is in flight sets `drainAgain`, and the pass
goes round again before it settles, over the rows it has not tried (each row once per drain; a platform that failed
stays paused for the whole drain, so no extra retry). The caller is not made to wait. The solo test's setup became
the `soloGateway()` helper, and its dead `drainIntervalMs` was removed.
One false red on the way, mine: the new test's last line asserted an empty queue as soon as the server had the reply,
but the row is marked sent only when the answer comes back (1 of 5 runs, `expected [ {...} ] to deeply equal []` at
`:164`). It now waits for the queue to empty.
Evidence: `MessageQueue.test.ts` -> exit 0, `Tests 6 passed (6)`. `agent-handler.solo.test.ts`, five consecutive runs at
the 5 s default -> exit 0, 0, 0, 0, 0, each `Tests 2 passed (2)`. Each alone, exit 0: `GatewayManager.resume.test.ts` (3),
`solo/router.test.ts` (10), `runtime/runner-for-mode.test.ts` (14), `GatewayManager.test.ts` (16),
`platforms/telegram.wire.test.ts` (6), `RunApprovalLink.test.ts` (10). `npx tsc --noEmit -p apps/cli/tsconfig.json` ->
exit 0; `npx tsc --noEmit -p packages/trent-core/tsconfig.json` -> exit 0.
Files: `packages/trent-core/src/gateway/queue/MessageQueue.ts` (landed file, clean at HEAD before this; every hunk
`// [S2]`), `packages/trent-core/src/gateway/queue/MessageQueue.test.ts` (one test added), `apps/cli/src/gateway/agent-handler.solo.test.ts`.
No solo file (`runner.ts`, `turn.ts`, `router.ts`, ...) was changed.
