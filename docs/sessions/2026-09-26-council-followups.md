# 2026-09-26 — CF: council follow-ups (C15.1, C14.1, C11 leftovers)

Task (from the orchestrating session): close the gaps named in the C15 log ("Open items" 1-3), the C14 log
("Residuals, stated" 1-2) and the C11 log ("Open" 1 and 3). No subagents, no commit, stash, checkout,
reset or push. No live model calls (fakes only). Every hunk in an existing file carries `// [CF]`; every
file under 500 lines; one test file at a time.

Not touched (other lanes): C13 owns `solo/{turn,events,types}.ts`, `orchestrator/types.ts`,
`apps/cli/src/repl/render.ts`, `apps/cli/src/tui/Chat.tsx`, `apps/cli/src/gateway/agent-handler.ts`
(and has `solo/runner.test.ts` modified in the tree, so it is left alone too). C11.2 owns `setup/**`,
`commands/registry.ts`, `commands/index.ts`, README.md. C16 owns `bench/**`, `commands/groups/bench.ts`.
Where a gap needs a line in a C13 file, the exact line is recorded below instead of made.

## Log
- 04:17 EDT start. `uptime` load 5.52 66.18 159.25. HEAD 8f3c70b on feature/trent-fleet-v2. Read AGENTS.md,
  the rulebook's Universal Coding Rules and Phase 4, the three logs' gap sections.
- 04:23 baseline, one directory at a time, `TRENT_QUEUE_FALLBACK=disabled npx vitest run <dir>`:
  `packages/trent-core/src/solo` exit 0, 23 files / 142 tests; `tools/memory` exit 0, 4 / 50;
  `fleet-memory` exit 0, 37 / 313; `orchestrator` exit 0, 30 / 219; `model-gateway/pricing.test.ts`
  exit 0, 1 / 34; `apps/cli/src/runtime` exit 0, 15 / 98.

## Findings before code (facts, with where)
1. `SoloRunnerDeps` and `SoloConfig` live in `solo/types.ts` (C13's). A new runner option is declared in
   `solo/runner.ts` as an intersection (`SoloRunnerOptions = SoloRunnerDeps & {...}`), so no C13 file is
   edited; the type can move into `types.ts` later with no caller change.
2. The platform already rides the run at runtime: `headless.ts:455` `runner.run({ objective, ...options })`
   spreads the handler's options, so `platform` reaches `ModeRunInput` untyped and is dropped by
   `soloRunner().run` (`runner-for-mode.ts:341-349`, named fields only). `adoptSaved` in `router.ts` opens
   a restarted session with no platform (a park rebuilt after a restart keeps no hint; stated below).
3. `SOLO_MISUSE_REPEATS` is declared in `solo/types.ts:31` and used only in `solo/turn.ts:208-216`
   (`misuseOf`), which counts `failed`, `blocked` and `needs_approval` only. Both files are C13's: the
   success-repeat rule is built as its own module and the one line that calls it is recorded.
4. The runner does not hold the toolsets' `*_TOOL_SCHEMAS`: it holds adapters. The one existing inverse from
   an adapter to its schemas is the MCP catalog's (`mcp-server/catalog.ts` `schemaFor`: `parseToolBlocks`
   + `parseInstructionBlock`, `PROSE_TOOL_SCHEMAS` for `file_ops`/`terminal`). Solo must read the adapter's
   SOLO text (`memory` offers replace/remove in solo, `solo/prompt.ts` `soloTextOf`), not `instructions`.
5. `anthropic` is not an alias (`providers.ts` `PROVIDER_ALIASES` = ollama, lmstudio, deepseek, groq, all
   `openai`); the route's provider is `resolveProviderAlias(config.provider)?.provider ?? config.provider`.
6. Native tools without the parser line are a regression, not a no-op: Claude answers a request that offers
   tools with `tool_use` blocks and little or no text, and `turn.ts:334` parses `completion.text` only, so the
   reply reads as empty (malformed), twice, and the run fails. E must land with C13's parser line or after it.
7. `RunModelCall` lives in `orchestrator/run-hooks.ts` (not C13's). `spend-meter.ts` `modelCall` takes
   `SeatCallUsage | GatewayCompletion`; `SeatCallUsage` (`seat-gateway-port.ts:60`) has no write count, so
   the seat half needs the optional field too.
8. The solo stable tier comes from the hook through `solo/fleet-memory-port.ts`, which already re-renders
   one block for solo (the brain, without `solo.md`). The hook is one per runtime serving both modes (C15
   finding 1), builds the stable tier before any seat is known, and is 499 lines: the solo wording is
   rendered in the port, and the hook's fleet string is not touched (byte-identical by construction).
9. `solo/prompt.test.ts:159` pins the old `oneOf` envelope (S1.1, written after the code, never seen red).

## Log, per item (red first)
(Entries are in the order they happened, between the 04:23 baseline and the 04:48 gates; the minutes were not read
from the clock, so none is given. C13 landed as b1fcef5 at 04:38 by its commit date.)
### D1: one envelope (C11 open item 1)
- RED: new `solo/envelope-source.test.ts`; `TRENT_QUEUE_FALLBACK=disabled npx vitest run
  packages/trent-core/src/solo/envelope-source.test.ts` -> exit 1, 2 failed: `expected [ Array(2) ] to be
  undefined` (the top-level `oneOf`), and `expected { type: 'json_schema', …(1) } to deeply equal {...}` (the two
  names emitted different schemas).
- GREEN: `prompt.ts` `soloResponseFormat` emits the `anyOf` of two complete objects (`[CF]`); `turn-settings.ts`
  `soloEnvelopeFormat` returns `soloResponseFormat(adapters)` (`[CF]`; no cycle: prompt.ts does not import
  turn-settings.ts). Same command -> exit 0, 2 passed. `solo/turn-settings.test.ts` -> exit 0, 7 passed.
- Requirement change, recorded BEFORE the test is touched: `solo/prompt.test.ts:159` (S1.1, "Written after
  `soloResponseFormat` ... it was never seen red") asserts `toMatchObject({ oneOf: [{ required: ["tool_calls"] },
  { required: ["answer"] }] })`, i.e. the envelope form C11's live run 1 proved Ollama does not enforce. The
  test's intent (the envelope names every tool as an enum, and a reply in its shape parses back to the same call)
  is kept; only the envelope-form assertion is re-pointed at the enforced form (`anyOf`, each branch requiring
  its one property). `prompt.test.ts` -> exit 1 before the change: `expected { anyOf: [ { …(4) }, { …(4) } ] } to
  match object { oneOf: [ …(2) ] }`.
- `solo/prompt.test.ts` (the `[CF]` re-pointed assertion) -> exit 0, 9 passed. Dependents of the envelope,
  each exit 0: `doctor/checks/local-smoke-solo.test.ts` (6), `apps/cli/src/runtime/runner-for-mode.constrained.test.ts`
  (5). `soloEnvelopeFormat`'s output is the same object, key order included, as before (the branch builder is
  the one `turn-settings.ts` had), so the doctor's solo smoke sends the same bytes.

### D2: a repeated SUCCESS stops the run (C11 open item 3)
- `SOLO_MISUSE_REPEATS` lives in `types.ts` and its only reader is `turn.ts` `misuseOf` (C13's): the rule is built
  as `solo/repeat-stop.ts` (`repeatedSuccessOf(run, call, result)`, `SOLO_SUCCESS_REPEATS = 5`, counted per run in
  a WeakMap on the run's state, so wiring it needs no `TurnState` field) and the wiring is recorded for C13.
- N = 5, not 3: `process_manage wait` on a background job that prints nothing returns identical text
  (`tools/terminal/adapter.ts:136-141`, "<id> running\n(no output yet)"), a legitimate repeat. A changed result
  restarts the count; calls need not be consecutive.
- RED against an exports-only skeleton (a missing module is not a valid red): `TRENT_QUEUE_FALLBACK=disabled
  npx vitest run packages/trent-core/src/solo/repeat-stop.test.ts` -> exit 1, 5 failed / 2 passed: `expected '' to
  match /loop/`, `.toMatch() expects to receive a string, but got undefined` (x3), `expected [] to have a length of
  1 but got +0`. The two guards (5 < cap 25 and > 3; non-success statuses never count) passed before and after.
- GREEN: `repeatedSuccessOf` implemented. Same command -> exit 0, 7 passed.
- LEFT FOR C13 (`solo/turn.ts`, exact lines):
  - import, beside `:50`: `import { repeatedSuccessOf } from "./repeat-stop.js"; // [CF] a repeated success stops the run`
  - `:304`, replace `const misuse = misuseOf(state, call, result);` with
    `const misuse = misuseOf(state, call, result) ?? repeatedSuccessOf(state, call, result); // [CF] C11 open item 3`
  - the runner-level test to add with it (`solo/stops.test.ts` style): a script of six identical `read_file` calls,
    the fake returning the same summary each time, `maxToolCalls` default: the run ends `run_failed` after exactly
    5 calls, its verdict matches `/loop/` and names `read_file`, and no sixth call reached the adapter.

### A: the platform hint reaches the prompt (C15 open item 1)
- RED: new `apps/cli/src/runtime/runner-for-mode.cf.test.ts` (the runtime as `createHeadlessRuntime` builds
  it, a scripted gateway; the run options exactly as `agent-handler.ts` passes them for a solo thread:
  `{ trigger, session, platform: "telegram" }`). `TRENT_QUEUE_FALLBACK=disabled npx vitest run
  apps/cli/src/runtime/runner-for-mode.cf.test.ts` -> exit 1, 2 failed / 1 passed; the C15.1 case:
  `expected 'You are Trent, an assistant working f…' to contain 'You are talking over Telegram; keep r…'`.
  (The other failure is item E's red, below; the passing case is E's guard.)
- GREEN, one optional `platform` per hop, each `[CF]`: `runner-for-mode.ts` `ModeRunInput.platform`,
  `ModeRunOptions.platform` (so `HeadlessRunOptions` carries it typed), `soloRunner().run` forwards it, the
  router's `create` passes `conversation.platform` to `createSoloRunner`; `solo/router.ts`
  `SoloRouteInput.platform` -> `SoloConversation.platform` in `open()`; `solo/runner.ts` `SoloRunnerOptions =
  SoloRunnerDeps & { platform? }` -> `buildSystemPrompt({ ..., platform })`. `-t "C15.1"` -> exit 0, 1 passed:
  the Telegram prompt is exactly the no-platform prompt + `\n\n## Where you are talking\n` + the hint.
- Stated, not built: a conversation reopened after a restart by `adoptSaved` (`router.ts`, a saved park) is
  created with no platform, so a park continued after a restart has no hint in its prefix. Persisting the
  platform beside the park is its own item (the park record is `types.ts`, C13's).
- For C13 (`apps/cli/src/gateway/agent-handler.ts:49`): `SoloThreadRunOptions` (`... & { readonly platform:
  string }`) is now redundant, because `HeadlessRunOptions` carries `platform?`; the intersection can go and the
  `[C15]` comment at `:262-264` ("The runner port does not carry it to the prompt yet") is no longer true.

### E: native tools on the request, anthropic only (C14 residual 1)
- RED (same new file as A): `runner-for-mode.cf.test.ts` C14.1 case -> `expected undefined to deeply equal {
  name: 'weather_lookup', …(2) }` (no `tools` on an anthropic request). The guard (a hosted google and a local
  ollama request carry no `tools`) passed before and after.
- GREEN: new `solo/native-tools.ts` (`offersNativeTools(provider)`: `resolveProviderAlias(p)?.provider ?? p` is
  `anthropic`; `soloNativeTools(adapters)`: per adapter, its solo text split by `parseToolBlocks` and read by
  `parseInstructionBlock`, `PROSE_TOOL_SCHEMAS` for `file_ops`/`terminal`, the MCP catalog's own inverse);
  `prompt.ts` exports `soloTextOf` and a `soloWording` helper (`[CF]`, `soloInstructions` now calls it: same
  output); `runner.ts` `SoloRunnerOptions.provider`, `tools` on the request when non-empty (`[CF]`);
  `runner-for-mode.ts` passes `provider: config.provider` (`[CF]`).
  First green run -> exit 1 on `read_file`: the TEST's `file_ops` fake published a rendered block, which the
  catalog rule reads before the prose table; the fixture now carries the real `FILE_OPS_INSTRUCTIONS` (prose), as
  production does. Then `runner-for-mode.cf.test.ts` -> exit 0, 3 passed.
- Measured over the REAL default build (scratch `tsx` script: `TrentConfigSchema.parse({}).toolsets` through
  `buildTrentTools` plus the hook's three adapters): 16 adapters, 25 names, 16 tools offered natively (every tool
  name; the 9 not offered are adapter names such as `web`, `human`, `tools`, whose tools are deferred or named
  otherwise), 10,139 chars of JSON. First measurement: "founder" 2 in argument descriptions (`ask_human`
  `question`).
- RED: new `solo/native-tools.test.ts` -> exit 1, 1 failed / 3 passed: `expected '{"type":"object","properties":
  {"quest…' not to match /founder/i`. GREEN: `inSoloWords` applies `soloWording` to each argument's description.
  -> exit 0, 4 passed. Re-measured: founder 0, seat 0.
- LEFT FOR C13 (`solo/turn.ts:334`, exact line), and E must not ship without it (finding 6):
  `const reply = parseReply(completion.text, deps.adapters, { envelope: deps.request.responseFormat !== undefined, ...(completion.toolCalls === undefined ? {} : { toolCalls: completion.toolCalls }) }); // [CF] C14.1 native calls`
  and its runner-level test: an anthropic-provider runner whose fake gateway answers the first request with
  `{ text: "", toolCalls: [{ id: "toolu_01", name: "read_file", arguments: { path: "README.md" } }] }` and the
  second with text: `read_file` ran once with `read_file {"path":"README.md"}` and the run ends `run_done`.
- Not built: a delegated child (`delegate.ts` `SoloChildBase` is a `Pick` of `SoloRunnerDeps`) keeps the text
  protocol, which parses on Claude too; the provider is `config.provider`, so a `--model claude-...` pin on
  another provider is not offered native tools (and a gemini pin on anthropic is offered them, which a text route
  ignores).

### F: the run ledger prices cache writes (C14 residual 2)
- RED: new `orchestrator/spend-meter.cache-write.test.ts`; `TRENT_QUEUE_FALLBACK=disabled npx vitest run
  packages/trent-core/src/orchestrator/spend-meter.cache-write.test.ts` -> exit 1, 3 failed, each `expected 300
  to be 375`: `recordRunModelCall` with 1M written tokens on claude-sonnet-4-6; the meter's gateway call
  (`consolidatorGateway`); a seat call through the wrapper's port (`createSeatChatPort`).
- GREEN, each `[CF]`: `run-hooks.ts` `RunModelCall.cacheWriteInputTokens?`, clamped to what the reads leave and
  passed to `priceCallMicroCents`; `spend-meter.ts` `modelCall` passes `usage.cacheWriteInputTokens ?? 0`;
  `seat-gateway-port.ts` `SeatCallUsage.cacheWriteInputTokens?` set by `usageOf` (the seat half of `modelCall`'s
  union). Same command -> exit 0, 3 passed. `model-gateway/pricing.test.ts` -> exit 0, 34 passed.
- The solo meter (`solo/meter.ts:50`) hands its call to `recordRunModelCall` unchanged, so solo is priced right as
  soon as `turn.ts` puts the count on the call. LEFT FOR C13 (`solo/turn.ts` `charge()`, after `:227`):
  `    ...(completion.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: completion.cacheWriteInputTokens }), // [CF] C14.1 priced at the write rate`
  (`SoloModelCall` is `RunModelCall`, `types.ts:115`, so it type-checks with no `types.ts` change.)
- Not built at first: the ledger ROW recorded `cachedInputTokens` only. Built in the follow-up below (the row now
  carries `cacheWriteInputTokens`); `trent usage` totals (`spend-report.ts`) still sum reads only.

### B: approving a held solo replace applies it (C15 open item 2)
- RED: new `tools/memory/holds-owner.test.ts`; `TRENT_QUEUE_FALLBACK=disabled npx vitest run
  packages/trent-core/src/tools/memory/holds-owner.test.ts` -> exit 1, 2 failed / 2 passed: the solo replace
  `expected { ok: true, record: { …(5) }, …(2) } to match object { ok: true, record: { …(2) } }` (status
  `blocked`: the seat rule), and `expected undefined to be defined` (no conversation bound during the replay).
  The two fleet guards (a held fleet add is written outside any conversation; a held fleet replace is still
  refused by C4's seat rule, block unchanged) passed before and after.
- GREEN: `holds.ts` `replayAsSoloOwner` (`[CF]`): when `decided.agentId === SOLO_SEAT` (`trent`, the seat
  `solo/memory-gate.ts` names on every solo hold; no fleet seat has that name, `seat-wiring.ts:19`), the replay
  runs under `runWithToolCallContext({ runId: "approval_<row id>", stepId: "<runId>-trent" })` with a fresh
  taint bound to that id, unbound in `finally`. Same command -> exit 0, 4 passed: MEMORY.md is
  `["Prefers short replies.", "Lives in York. [provenance: untrusted via web_extract]"]`; the row's live run's
  binding is the same object after the approval, and `approval_<id>` is not left bound.
  `packages/trent-core/src/tools/memory` -> exit 0, 5 files / 54 tests.

### C: the memory section in solo's words (C15 open item 3)
- The fleet's section, printed from the hook BEFORE any edit (scratch `tsx` script, a temp profile with
  "Lives in Leeds." in MEMORY.md, `brain: false`, seat `ceo`), is the literal `FLEET_SECTION` in the new test.
  The solo port returned the same text: "seat" 3, "founder" 2 (C15's measurement).
- RED: new `solo/memory-section.test.ts`; `TRENT_QUEUE_FALLBACK=disabled npx vitest run
  packages/trent-core/src/solo/memory-section.test.ts` -> exit 1, 1 failed / 2 passed: `expected { seat: 3,
  founder: 2 } to deeply equal { seat: +0, founder: +0 }`. Guards passing before and after: the fleet seat's
  section equals the literal; a block the profile described itself keeps its own words.
- GREEN, each `[CF]`: `tools/memory/blocks.ts` `soloBlockDescription` (solo words for a shipped block whose
  description is still the shipped one); `tools/memory/index.ts` `renderBlock(..., mode)` ("; read-only" in
  solo) and `MemoryAdapter.snapshotFor(mode)` (frozen and thawed with `frozenSnapshot`; `fleet` renders the same
  bytes); `solo/fleet-memory-port.ts` re-renders the hook's memory block as `SOLO_MEMORY_HEADING` + the solo
  snapshot (a third deliberate difference beside the brain block's). `fleet-memory/orchestrator-hook.ts` is NOT
  edited (finding 8), so the fleet's string is byte-identical by construction and by the test. Same command ->
  exit 0, 3 passed. Rendered solo section: "## Your memory (as it stood when this conversation opened; what you
  save shows from the next conversation on)", "user: who you work for and how they want to be worked with",
  "company: facts about the person's company; edited by hand; ...; read-only".
- `solo/fleet-memory-port.test.ts` exit 0 (2); `tools/memory` exit 0 (5 / 54); `fleet-memory` exit 0 (37 / 313).
- Note: `fleet-memory/orchestrator-hook.ts` is classified `data` by `file(1)` (non-ASCII in its comments), so a
  plain `grep` prints nothing for it; `grep -a` reads it.

### Added mid-session by the coordinator (C13 landed as b1fcef5 at 04:38; its files are read-only here)
### G: the runtime's solo gateway streams
- `runner-for-mode.ts` `lazyGateway()` returned `{ complete }` only, so `turn.ts` `callModel` (C13) never took its
  streaming branch on any surface. First a test seam, so no red run can reach a provider: `SoloSeams.modelGateway`
  (the factory `lazyGateway` builds on first use; default `createModelGateway()`), `[CF]`.
- RED: `runner-for-mode.cf.test.ts` G case (a fake MODEL gateway under the runtime's own `lazyGateway`;
  `stream()` yields five tokens, usage, finish; `complete()` folds the same frames and is counted apart):
  `-t "G:"` -> exit 1, `expected [ +0, 1 ] to deeply equal [ 1, +0 ]` (the turn called `complete`, never
  `stream`); the first version of the fake had `complete` drain `stream`, which read `expected 0 to be greater
  than 0` (no `step_delta`), same cause.
- GREEN: `lazyGateway` gains `async *stream(request) { yield* (await gateway).stream(request) }` (`[CF]`). Whole
  file -> exit 0, 4 passed: one `stream` call, no `complete`, `step_delta` frames before `step_end` whose text is
  exactly the answer, `run_done` last. `ModelGateway.complete` is itself `collectWithNativeFields(stream(req),
  collectCompletion)` (`model-gateway/index.ts:478-479`), the fold C13's `callModel` applies, so retries, the
  fallback chain, cost and native fields are the same on both paths.

### H: the gateway types while a solo turn runs
- C13 exported `typingFromAdapters` and the handler's `typing` option; neither `gateway start`
  (`commands/groups/servers.ts`) nor the service daemon (`commands/groups/service-daemon.ts`) passed it.
- RED, extending the existing suites (the runtime faked as `mode: "solo"`, the real Telegram adapter's
  `sendTyping` spied, no network):
  `TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/commands/__tests__/gateway-start.test.ts -t typing`
  -> exit 1, `expected "sendTyping" to be called with arguments: [ '555' ]` (the reply arrived; no typing);
  `... service.test.ts -t typing` -> exit 1, `expected "sendTyping" to be called with arguments: [ '777' ]`
  (the handler asserted to exist first, so the red is the missing action, not a missing handler).
- GREEN, `[CF]` at both sites: `typingFromAdapters((platform) => manager?.getAdapter(platform))` into
  `createAgentHandler(..., { configManager, threads, typing })`; the lookup reads the manager at send time, so the
  handler can be built before the manager it types through. `gateway-start.test.ts` -> exit 0, 8 passed;
  `service.test.ts` -> exit 0, 17 passed (483 lines).
- Recorded, not implemented (the coordinator's instruction):
  - the REPL shows streamed text per COMPLETED line: `repl/engine.ts` (499 lines) writes through
    `deps.write(line)` (`:54`, `#emit` `:174-176`), a whole-line sink with no partial write, so a line is shown
    when its last token arrives, not token by token (C13's `stream-render.ts` works within that contract);
  - the TUI never runs solo: `tui/App.tsx:155` drives `orchestrator.run({ companyId, objective, trigger })`, the
    fleet, so C13's `streaming` prop on `Chat.tsx` has no solo stream to show there yet.

## Final evidence (04:48-04:55, load 13.97 at the start; one directory or file at a time)
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.
- `cd packages/trent-core && npm run build` -> exit 0.
- `node scripts/ci/repo-scan.mjs` -> exit 0, 1325 files, 3 checks PASS, 0 violations.
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run <dir>`, each exit 0: `packages/trent-core/src/solo` 27 files /
  158 tests (baseline 23 / 142); `tools/memory` 5 / 54 (4 / 50); `fleet-memory` 37 / 313 (unchanged);
  `orchestrator` 31 / 222 (30 / 219); `model-gateway/pricing.test.ts` 1 / 34 (unchanged); `apps/cli/src/runtime`
  16 / 103 (15 / 98).
- Dependents, each exit 0: `apps/cli/src/gateway` 3 / 16; `repl/__tests__/held-writes` 4, `approvals` 6,
  `approvals.restart` 3, `solo.repl` 3, `solo-continuity.repl` 4, `delegate.repl` 1, `fleet-memory.repl` 2,
  `fleet-memory.wiring` 9; `commands/__tests__/approvals` 11, `gateway-start` 8, `service` 17;
  `doctor/checks/local-smoke-solo` 6; `packages/trent-core/src/mcp-server` 7 / 26.
- Every `-U0` hunk of every existing file edited here carries `[CF]` (scratch splitter, the one
  `scripts/dev/hunks.py` uses): 17 files, 53 hunks, 0 unmarked. No `[CF]` code line is in b1fcef5 (C13) or
  cf1ef78 (C11.2); both commits mention this wave only in their logs.
- Largest file touched: `commands/__tests__/service.test.ts` 484 lines; every file under 500.
- No live model call: every model in every test is a script or a fake gateway; the G test's fake is injected
  as the MODEL gateway through a seam added before its red run, so the real `createModelGateway()` never ran.

## Files
Changed (`[CF]` hunks): `apps/cli/src/runtime/runner-for-mode.ts`, `packages/trent-core/src/solo/{router,runner,
prompt,prompt.test,turn-settings,fleet-memory-port}.ts`, `packages/trent-core/src/tools/memory/{holds,index,blocks}.ts`,
`packages/trent-core/src/orchestrator/{run-hooks,spend-meter,seat-gateway-port}.ts`,
`apps/cli/src/commands/groups/{servers,service-daemon}.ts`, `apps/cli/src/commands/__tests__/{gateway-start,service}.test.ts`.
New: `packages/trent-core/src/solo/{native-tools,repeat-stop}.ts`, `solo/{envelope-source,repeat-stop,native-tools,
memory-section}.test.ts`, `tools/memory/holds-owner.test.ts`, `orchestrator/spend-meter.cache-write.test.ts`,
`apps/cli/src/runtime/runner-for-mode.cf.test.ts`, this log. Nothing committed, staged or stashed.

## Left for C13's files: APPLIED in this lane after C13 and C11.2 landed (next section)
The four hand-offs recorded above (turn.ts `:334`, `charge()`, `:304` + import, the agent-handler tidy) were applied
here once the coordinator freed those files (HEAD cf1ef78). The optional move of `platform?` / `provider?` into
`SoloRunnerDeps` (`types.ts`) was not asked for and is not done.

## docs/solo.md (not edited here; for the lead)
- Limits bullets that can go: "The memory section of the prompt still uses the fleet's wording ..." (C);
  "Approving a held replace or remove does not apply it yet ..." (B); "A gateway thread's platform is passed with
  each run, but the platform hint ... is not yet in the prompt." (A; a narrower one may replace it: a park
  continued after a restart is rebuilt without the hint).
- Streaming section, the sentence "Not wired yet: the runtime hands the runner a gateway with `complete` only
  ... so both stay off until those two call sites do." is no longer true (G, H).
- "The system prompt" gains the platform hint as its last section; "Memory and skills": approving a held
  replace or remove now writes it too, tagged.

## Follow-up: the C13 lines, applied (HEAD cf1ef78; C13 b1fcef5 and C11.2 cf1ef78 landed, their files freed)
- 04:57 RED, new `solo/turn.cf.test.ts` (the real runner, a gateway returning whole completions, a temp spend
  ledger for the second case): `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo/turn.cf.test.ts`
  -> exit 1, 3 failed:
  - native tool_use: `expected [] to deeply equal [ 'read_file {"path":"README.md"}' ]` (an anthropic reply that is
    only a `tool_use` read as empty: repaired, and the tool never ran);
  - ledger row: the row read `"cents": 300` with no `cacheWriteInputTokens` (wanted 375 and the count);
  - repeat stop: `expected [ ... ] to have a length of 5 but got 6` (the sixth identical read ran; the run answered).
- (1) GREEN: `turn.ts:337` (was `:334`) hands `completion.toolCalls` to `parseReply` (`[CF]`). `-t "native tool_use"` -> exit 0:
  the request offered `read_file` natively, `read_file {"path":"README.md"}` ran once, no "could not be parsed" or
  "empty" note, `run_done` with the answer.
- (2) GREEN in two steps: `turn.ts` `charge()` passes `cacheWriteInputTokens` (`:230`, `[CF]`) -> `-t "ledger row"` still
  exit 1 but `"cents": 375` (the price was right; the row lacked the count); then the row: `governance/spend-ledger.ts`
  `SpendRow.cacheWriteInputTokens?` (validated like the other counts, written only when > 0) and `run-hooks.ts`
  `MeteredGroup.cacheWriteInputTokens` summed per row and written by `writeMeteredRows` (`[CF]`) -> exit 0: one row,
  seat `trent`, `claude-sonnet-4-6`, 375 cents, `inputTokens` 1,000,000, `cacheWriteInputTokens` 1,000,000.
- (3) GREEN: `turn.ts` imports `repeatedSuccessOf` (`:52`) and `:307` reads `misuseOf(...) ?? repeatedSuccessOf(...)`, and
  the header's list of bounds names the fifth (`[CF]`). Whole file -> exit 0, 3 passed: 5 calls, `run_failed`, the
  verdict matches `/loop/`, names `read_file`, and is not the cap's.
- (4) the tidy, a refactor with no behaviour change, so its guard is the existing C15 test:
  `apps/cli/src/gateway/agent-handler.test.ts` -> exit 0, 10 passed before; `SoloThreadRunOptions` and the "does not
  carry it to the prompt yet" comment removed (`[CF]`), the options inferred and typed by `HeadlessRunOptions`
  (which carries `platform?` since item A); same file -> exit 0, 10 passed after; `npx tsc --noEmit -p
  apps/cli/tsconfig.json` -> exit 0.
- Gates 05:00-05:03 (load 22.36), one at a time, `TRENT_QUEUE_FALLBACK=disabled npx vitest run <dir>`, each exit 0:
  `packages/trent-core/src/solo` 28 files / 161 tests; `apps/cli/src/runtime` 16 / 103; `apps/cli/src/gateway` 3 / 16;
  `orchestrator` 31 / 222; `governance` 17 / 216; `tools/memory` 5 / 54; `model-gateway/pricing.test.ts` 1 / 34;
  `commands/__tests__/usage` 8, `commands/__tests__/budget` 7, `repl/__tests__/budget` 12.
  `npx tsc --noEmit -p apps/cli/tsconfig.json` exit 0; `cd packages/trent-core && npm run build` exit 0;
  `node scripts/ci/repo-scan.mjs` exit 0 (1326 files, 3 PASS).
- Every `-U0` hunk of the 20 existing files edited in this lane carries `[CF]`: 68 hunks, 0 unmarked. Largest file
  touched: `commands/__tests__/service.test.ts`, 484 lines.
- Final file list. Changed (`[CF]` hunks): `apps/cli/src/runtime/runner-for-mode.ts`,
  `apps/cli/src/gateway/agent-handler.ts`, `apps/cli/src/commands/groups/{servers,service-daemon}.ts`,
  `apps/cli/src/commands/__tests__/{gateway-start,service}.test.ts`, `packages/trent-core/src/solo/{turn,router,runner,
  prompt,prompt.test,turn-settings,fleet-memory-port}.ts`, `packages/trent-core/src/tools/memory/{holds,index,blocks}.ts`,
  `packages/trent-core/src/orchestrator/{run-hooks,spend-meter,seat-gateway-port}.ts`,
  `packages/trent-core/src/governance/spend-ledger.ts`. New: `packages/trent-core/src/solo/{native-tools,repeat-stop}.ts`,
  `solo/{envelope-source,repeat-stop,native-tools,memory-section,turn.cf}.test.ts`,
  `tools/memory/holds-owner.test.ts`, `orchestrator/spend-meter.cache-write.test.ts`,
  `apps/cli/src/runtime/runner-for-mode.cf.test.ts`, this log. Nothing committed, staged or stashed.
