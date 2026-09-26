# 2026-09-26 — S1.1: solo hardening (the runner-level blockers of the council review)

Wave S1.1 against `02_plan/output/solo-harness-review-2026-09-26.md` (35 findings; this wave owns the
runner-level blockers B1, B2, B6, C1, C2 and the restart path of B9 / chair ruling 6). No cloud model
call; every test drives a fake gateway script. No commit, stash, checkout or push. No subagents.

Owned: `packages/trent-core/src/solo/{turn,parse,prompt,runner,types,events}.ts` and their tests;
`governance/{policy-dispatch,provenance}.ts` (`// [S1.1]` hunks only, additive: session-scoped taint);
`tools/human/index.ts` (marked: gate frames name the held call); `sessions/SessionStore.ts` (marked,
additive: a place to persist a parked run); this log. `docs/solo.md` does not exist, so docs are S4's.
Concurrent owners left alone: S2 (apps/cli, gateway, a2a, a `// [S2]` resume-by-id in runner.ts),
L0-2 (model-gateway), L0-5 (fleet-memory/embedder*), H1 (governance/auto-review), H2 (tools/mcp, connect).

## Read first (end to end)
- the review (all 35 findings and the chair's reconciliation); `docs/sessions/2026-09-26-s1-solo-loop.md`;
- `solo/**` at e0e13ab (runner, turn, parse, prompt, events, types, meter, the five tests and the fakes);
- `governance/{policy-dispatch,provenance,policy-rules,hardline,bound-approvals,autonomy-dispatch,
  idempotent-dispatch,tool-call-context}.ts`, `tools/index.ts` (the chain and `TrentToolBuild`);
- `tools/human/index.ts` (`questionFromEvent`), `apps/web/lib/seat-agent-loop.ts` (read-only: the app's
  `pendingToolCall` is `{ name: record.adapter, action }`, and it does NOT re-park a hold returned after
  a grant: `record.status === "needs_approval" && !approvalGranted`);
- `sessions/{SessionStore,schema,SessionManager}.ts` (`migrateSessionRecord` drops unknown top-level
  keys, so a parked run cannot ride the session JSON itself: it needs a sidecar);
- `01_discovery/output/local-models-2026-09-26.md` sections 5 (F1-F12, mitigations) and 8 (G2, G4, G7,
  P1, P2, R1-R3); `doctor/checks/local-smoke.ts` (the five cases); `fleet-memory/prompt-budget.ts`
  (L0-2's, present in the tree: `evaluatePromptBudget`, 4 chars/token via `tiers.ts` `estimateTokens`);
- `model-gateway/types.ts`: `GatewayStreamRequest` has NO `responseFormat` field (L0-2/L1 has not
  landed constrained output), so C1's constrained JSON is a pass-through seam.

## Baseline (before any edit)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo packages/trent-core/src/governance packages/trent-core/src/tools/human packages/trent-core/src/sessions packages/trent-core/src/wrapped-modules.test.ts`
-> `Test Files 2 failed | 26 passed (28)`, `Tests 246 passed (246)`. Both failures are H1's in-flight
files, not this wave's: `governance/auto-review-policy.test.ts` (cannot load `./auto-review-config.js`)
and `governance/auto-review.test.ts` (cannot load `./auto-review-audit.js`).
`uptime`: load averages 520 / 405 / 447, so the optional live 9B smoke is skipped (the rule is load < 20).

## Log

### Red (tests first; every failure an assertion on the behaviour, or a module not yet written)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo` -> exit 1, 30 failed tests +
`park.test.ts` failing to load `./park.js` (the module did not exist yet). The red line per item:
- B1 (`taint.test.ts`): "a secret read in turn 1 holds a network call in turn 2" -> `expected 'run_done' to be
  'run_awaiting_approval'`; restart variant -> `expected undefined to deeply equal [ [ 'read_file', ... ] ]`
  (nothing saved); provenance -> `expected { adapter: 'memory', ... } to match { status: 'blocked' ... }`
  (the write went through in turn 2). The cross-session control case passed (it must).
- B2 (`gate.test.ts`): gate frames -> `expected undefined to deeply equal { pendingToolCall: ... }`;
  `answer()` on a held post -> `expected true to be false`. The ask_human-card control case passed.
- B6 (`holds.test.ts`, the REAL chain via `gateChain`): same call re-issued -> `expected [ Array(5) ] to deeply
  equal [ Array(6) ]` (it parked again); differing call -> hold detail lacked `differs from the call approved
  as appr_...`; execute hold after a yes -> parked again (`[ Array(4) ]` vs 5 kinds); misuse -> parked
  on the first execute hold instead of counting it.
- C1 (`parse.test.ts`, `prompt.test.ts`, `runner.test.ts`): the Hermes body -> `malformed: a <tool_call> block
  must start with the tool's name`; think -> `malformed` instead of the answer; envelope -> read as answer
  text; protocol -> system prompt lacked the Hermes body; inline examples not rewritten; repair showed
  `<tool> {"key": "value"}`; runner: adapter never called (`expected [] ...`), `responseFormat` not sent.
- C2 (`budget.test.ts`): `DEFAULT_SOLO_MAX_TOOL_RESULT_CHARS` undefined; no truncation note; over-window
  request sent (`expected [ ... ] to have a length of +0 but got 1`).
- restart (`park.test.ts`): could not load `./park.js`; plus two S1 expectations changed on purpose (below).

S1 expectations changed deliberately (recorded, not hidden), both in `gate.test.ts`:
- `parked()` entries now carry `approvalId` (additive field), so the S1 `toEqual` gained `approvalId: "appr_test"`.
- "a new run on the session abandons the parked one": the abandoned hold is no longer left as the call's
  last word (review B9: the transcript said it was still waiting); one `tool` line `not run: a new message
  started another run...` is appended, so the expected session gained `["tool", "blocked"]`.

Concurrent: while this wave ran, S2 added `solo/{router,session-store,hold-policy,audit,fleet-memory-port}.ts`
and tests. Not touched here; they pass unchanged against this wave's runner (84/84 below).

### Green
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo` -> exit 0, `Test Files 14 passed
(14)`, `Tests 84 passed (84)`.

### What changed, per item
- **B1** `governance/provenance.ts` (`// [S1.1]`): `SessionTaint` (the policy ring + untrusted sources of one
  conversation), `createSessionTaint` / `snapshotSessionTaint`, and a bounded run-id -> taint binding
  (`bindSessionTaint`, `currentSessionTaint`); the ledger's `note`/`sources`/`isUntrusted` use the bound
  taint when there is one. `governance/policy-dispatch.ts` (`// [S1.1]`): `history()` and the ring append
  use it too. No change to `tool-call-context.ts` (not owned). The runner binds every run to its
  conversation's taint while it drives it, saves the snapshot after every tool result, restores it on
  first use. Also found and fixed while making B1 red-to-green: S1 asked `requiresApproval` OUTSIDE the
  run's tool-call context, so even within ONE run the policy wrapper read the process ring; it is now
  asked inside the context (`turn.ts` `gateOrRun`).
- **B2** `runner.ts` `answer()` returns false unless the held adapter is in `CARD_ADAPTER_NAMES`; `events.ts`
  gate frames carry `seatLoopState.pendingToolCall = { name: <adapter>, action }` (the app's shape);
  `tools/human/index.ts` (`// [S1.1]`) `questionFromEvent`: a gate that names its held call is read from
  THAT call's record only. The cumulative list still keeps the answered question's record (not replaced).
- **B6** `turn.ts` + `holds.ts` (new, split out to keep turn.ts under 400): only a `dryRun` hold parks; a
  `needs_approval` from `execute` is the call's result with "decided with trent approvals" and counts for
  the misuse stop ("was held N times"); the same call approved earlier in the run runs under that
  approval (the chain grants the approved row, idempotency returns the first result: 1 post, 1 row); a
  differing call of the same tool is held once, its hold naming the approved row and each changed key.
- **C1** `parse.ts`: the Hermes/Qwen body normalised to `name {json}`; the legacy line still verbatim;
  `stripThinking` before parsing and before persisting; raw control characters in JSON strings escaped;
  the `{"tool_calls"}`/`{"answer"}` envelope when a `responseFormat` was sent; errors teach one shape.
  `prompt.ts`: the protocol shows the body; `soloInstructions` drops `action = "..."` lines and
  `toolCall.*` wording and rewrites inline `<tool> {json}` examples into the body (checked on the real
  file_ops, terminal and web instructions with a scratchpad `tsx` render, exit 0); `soloResponseFormat`
  builds the envelope schema with the tool names as an enum. `types.ts`: `SoloConfig.responseFormat`,
  passed through on every request (the gateway has no such field yet: L0-2/L1's; a seam, no TODO).
- **C2** `prompt.ts` `capToolResult` (default 8,000, `agent.solo.max_tool_result_chars` via
  `SoloConfig.maxToolResultChars`), applied in the run and on history replay; the record on the frame and
  in the session stays whole. `turn.ts` `overBudget` reuses L0-2's `fleet-memory/prompt-budget.ts`
  `evaluatePromptBudget` + `tiers.ts` `estimateTokens` (4 chars/token) against
  `SoloConfig.contextWindowTokens` minus `maxTokens` (else 4,096): refused before the call, verdict names
  prompt/reservation/window and system/conversation/largest-message sizes.
- **restart** `park.ts` (new): per-entry-validated state (`version`, `taint`, `parked`), `parkRecordOf`
  (run id, session id, held approval id, pending calls, the run's own messages, results, tool calls,
  usage, approved calls, a decision taken while parked), `sessionStoreState`. `sessions/SessionStore.ts`
  (`// [S1.1]`): owner-only sidecar `<sessions>/solo/<id>.json` (`readSoloState`, `writeSoloState`,
  `clearSoloState`, removed by `delete`), outside `list()`. `runner.ts`: the park is saved BEFORE the gate
  frames; `parked()` lists saved parks; `approve`/`reject`/`answer` land on a saved park; `resume` rebuilds
  (history before the run from the session + the saved run messages), reads a decision made on the bound
  row itself, or, when it cannot rebuild (tool not in the build, opening message gone), abandons: row
  decided `denied` by `abandoned: <why>` through `tools.bindings` (or the `approvals` port), one `tool`
  line `not run: ...` in the conversation, `step_end` + `run_failed` naming why. A new run on the
  conversation abandons every park it supersedes the same way.

### Verification (final)
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo packages/trent-core/src/governance packages/trent-core/src/tools/human packages/trent-core/src/sessions packages/trent-core/src/wrapped-modules.test.ts`
  -> exit 0, `Test Files 37 passed (37)`, `Tests 349 passed (349)` (H1's auto-review modules landed meanwhile).
- `cd packages/trent-core && npm run build` -> exit 0 once (before the refactor into `holds.ts`); after it,
  exit 2 with 12 errors, ALL in the untracked `src/webhooks/{engine.test,fakes.test-helpers}.ts` (another
  wave's red tests: `./engine.js`, `./store.js`, `./taint.js` and `WebhookRoute` not written yet). No
  error in solo/, governance/, tools/human/ or sessions/.
- `node scripts/ci/repo-scan.mjs` -> exit 0 (1162 files; canned 0, hex 0, emoji 0).
- The anchored marker grep over the touched files -> exit 1 (0 matches).
- Live 9B smoke of the new format: NOT run. `uptime` was 520 at the start and 74.74 at the last check (23:44),
  both over the rule's 20. No model was called in this wave.

### For S2 / S3 / L1 (not done here, by scope)
1. S2 wiring: pass `sessionId`, `state: sessionStoreState(sessionManager.getStore(), sessionId)` (`park.ts`)
   and `tools` as the whole `TrentToolBuild` (it carries `bindings`) to `createSoloRunner`; map
   `agent.solo.max_tool_result_chars` -> `config.maxToolResultChars` and the local probe's window ->
   `config.contextWindowTokens` (the `agent` section is a passthrough, so the key is accepted but not yet
   validated in `config/sections/agent.ts`, which is not this wave's file). The router builds a runner
   only when a conversation first runs, so after a restart `parked()` / `resume(runId)` need the router to
   open the session's runner first (the `// [S2]` resume-by-id entry point).
2. `fleet-memory/prompt-budget.ts` is L0-2's and still untracked: `solo/turn.ts` imports it, so it must be
   committed with or before this wave.
3. L1: a gateway `responseFormat` field; then S2 sets `config.responseFormat = soloResponseFormat(adapters)`
   on local providers. A corrupted (unparseable) sidecar is quarantined and its taint is lost: an
   entry-level salvage exists, a byte-level one does not.
4. Still open from the review, not this wave's: A3 (REPL gate dedupe per held call), B7 (tag escaping,
   fenced blocks), B10 (decidedBy on in-runner decisions), B11 (redaction before persisting), C2's
   prune-to-stub (S3), the grace answer at the cap (A6).
