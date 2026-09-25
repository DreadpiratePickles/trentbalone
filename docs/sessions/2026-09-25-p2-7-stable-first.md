# P2-7 stable tier first in seat prompts (2026-09-25)

Opus agent, no subagents, no commits. Branch feature/trent-fleet-v2, HEAD 4a0e171; other agents edit
the tree concurrently. Scope from the lead: `fleet-memory/orchestrator-hook.ts` (+ tests), the
three-tier assembly (`fleet-memory/tiers.ts`; there is no `src/context/` or `src/prompt/`, `grep -rl
STABLE packages/trent-core/src` finds only `fleet-memory/` and the live test), the seat-layout case of
`model-gateway/prompt-cache.live.test.ts`, the two doc sentences, this log. apps/web edits limited to
`lib/orchestrator-runtime.ts` and `lib/agent-routing-context.ts`, minimally. Source: follow-up 1 of
docs/sessions/2026-09-25-p1c-model-cost.md (0 cached tokens in the seat layout on gemini-3.6-flash).

## Finding (written before any code)

Where the seat call's two messages are composed, and what reaches them:

1. **Provider messages**: `apps/web/lib/model-gateway.ts:229-232` `executeSeatModel` sends
   `[{system: input.systemPrompt}, {user: buildSeatUserPrompt(input)}]`. The system message is
   `input.systemPrompt` VERBATIM. `buildSeatUserPrompt` (`:306-356`) renders `Company`, `Seat`,
   `Objective` (`:310-312`), Boundaries, Tool guidance, Context, Input, THEN `input.dynamicPrompt`
   (`:317`), then the tool-loop lines. Nothing ahead of `Objective` in the user message is reachable
   from outside this function.
2. **Who builds `systemPrompt`**: `apps/web/lib/orchestrator-runtime.ts:1423-1462` starts from
   `runtime.systemPrompt` (`agent-runtime.ts:147`, seat static prompt + its dynamic blocks) and
   PREPENDS the app's own skill prelude (`:1432`), playbook (`:1440`), cross-company block (`:1452`)
   and custom-skill prelude (`:1462`), several of them ranked against the step text (objective-
   dependent). It hands `systemPrompt` + `dynamicPrompt` ("Previous step outputs", `:1489`) to
   `runSeatAgent` (`:1483`); `apps/web/lib/seat-agent-loop.ts:283-287` forwards BOTH fields
   unchanged to `input.executeSeatModelFn ?? executeSeatModel`.
3. **The wrapper already sits on that seam**: `packages/trent-core/src/orchestrator/index.ts:209`
   installs `human(delegate(fleetMemory.wrapSeatModel(recovery(guard(underlying)))))` as the app's
   `executeSeatModelFn`, so `fleet-memory/orchestrator-hook.ts` `wrapSeatModel` (`:431-447`) receives
   the full `SeatModelExecutionInput`, `systemPrompt` included, and today only rewrites
   `dynamicPrompt` (`:443`, tiers appended AFTER the pipeline's text, i.e. after the objective).

**Verdict: reachable, with NO apps/web edit.** The hook can prepend the STABLE tier to
`input.systemPrompt` (the first bytes of the request: ahead of the seat prompt AND ahead of the app's
objective-ranked preludes), and leave CONTEXT + VOLATILE where they are, at the tail of
`dynamicPrompt`. Neither `orchestrator-runtime.ts` nor `agent-routing-context.ts` needs to change:
the first composes the system prompt the hook then extends, the second only renders the CEO routing
dossier (`buildAgentRoutingContext`, `:99-125`) and never touches a seat call.

Head of the system prompt rather than its tail, because the app's preludes (`:1432-1462`) are
ranked against the step, so a tier appended after them would still sit behind objective-dependent
bytes. A seat input with no `systemPrompt` field (test doubles, `app-memory-runner.ts`) has no system
message to carry the tier, so it keeps today's layout (whole injection in `dynamicPrompt`).

### Consequences recorded before coding (not fixable inside my files)
- **Inner prepender**: `packages/trent-core/src/improve/skill-injection.ts:113` (inside the fleet
  hook in the chain, when `deps.executeSeatModelFn` is the improve hook's `seatModel`) prepends its
  own objective-ranked skill prelude to `systemPrompt`, so when it fires the STABLE tier is no longer
  at byte 0. It only fires when the app did not already inject (`SKILL_PRELUDE_MARKER`, `:97`) and a
  live skill ranks for the step. improve/** is another agent's.
- **Semantic cache key**: `apps/web/lib/model-gateway.ts:283-300` `cacheKeyForSeatModel` hashes
  `dynamicPrompt` but never `systemPrompt`. With the stable tier moved out of `dynamicPrompt`, a
  change to the stable tier ALONE (a memory write between two identical analyst questions in one
  process, same recall, same transcript) no longer changes the analyst key. The key already omits
  `systemPrompt` (so the app's own preludes) and `toolLoopContext` (AGENTS.md defect 8).
- **Tests that encode the old layout**: `fleet-memory/fleet-memory.orchestrator.test.ts:145,151-158`
  (mine) and `apps/cli/src/repl/__tests__/delegate.repl.test.ts:214`,
  `apps/cli/src/repl/__tests__/fleet-memory.repl.test.ts:185-186` (apps/cli, NOT mine) assert the
  company memory inside `dynamicPrompt` of a real pipeline seat call.

## RED (test first; `TRENT_QUEUE_FALLBACK=disabled npx vitest run <file>` from the root)
New `packages/trent-core/src/fleet-memory/orchestrator-hook.stable-first.test.ts` renders the
prompt with the app's REAL `executeSeatModel` (provider replaced by a recorder on its
`createChatCompletion` seam), so the layout under test is exactly what a provider receives.
Exit 1, 3 failed / 1 passed:
- "for two different objectives on the same seat, the rendered prompt shares an identical leading
  prefix containing the stable tier, and the objective appears after it" FAILS at
  `expect(shared).toContain(stable)`: the shared prefix is `[system] <seat prompt> [user] Company:
  Northwind ... Seat: engineer Objective: ` and holds no stable tier.
- "puts the stable tier at the head of the system message ..." FAILS: the system message is the
  seat prompt alone.
- "changes ORDER only ..." FAILS on its first line (`now` equals the legacy layout byte for byte).
- "keeps the whole injection in dynamicPrompt for a seat input that has no system prompt" passes
  on RED (it is the guard for the fallback, not the requirement).

## GREEN
- `fleet-memory/tiers.ts`: new pure `placeTiers(prompts, assembled)` + `SeatPrompts`. With a string
  `systemPrompt`: STABLE blocks joined at the head of it (`<stable>\n\n<seat prompt>`), CONTEXT +
  VOLATILE joined after the pipeline's `dynamicPrompt`. Without one: today's layout, unchanged.
- `fleet-memory/orchestrator-hook.ts`: `FleetSeatInput.systemPrompt?`, `wrapSeatModel` spreads
  `placeTiers(input, assembled)` instead of building `dynamicPrompt` itself; header comment updated.
  498 lines (was 499); the `pending` memo lost three lines to make room, same behaviour (built once
  per (run, seat), stored before the first await).
- New test: exit 0, 4/4.

## Snapshot: one rendered prompt, before and after (same bytes, reordered)
Scratchpad-only dumper (`scratchpad/snap/dump.test.ts`, own vitest config, nothing in the repo):
real hook + real `executeSeatModel`, one engineer seat call with memory, workspace block, a prior
run to recall, a transcript and a personality. Before the change and after it:
- request bytes 1,744 before, 1,744 after; strings differ; the multiset of characters is equal and
  the sorted list of lines is equal (so: same bytes, reordered, nothing added or dropped);
- `## Company memory` at offset 413 of the request before (the objective at 103), offset 0 after
  (the objective at 688);
- after: system = `## Company memory ... ## Workspace context ...\n\nYou are the engineer seat. ...`
  (seat prompt bytes intact at the tail); the user message ends with recall, transcript, personality.
The same "order only" property is now a permanent test (third case above).

## Requirement change for tests that encoded the old layout (rulebook 11: documented before the edit)
The requirement "the stable tier rides in `dynamicPrompt`" is replaced by "the stable tier heads the
system prompt; CONTEXT and VOLATILE ride in `dynamicPrompt`". After GREEN, the affected suites
(fleet-memory, orchestrator, golden-capture, protected-prompt, wrapped-modules, the two apps/cli REPL
tests and both context tests) -> exit 1, 4 failed / 447 passed, exactly the four predicted:
- `fleet-memory.orchestrator.test.ts:145` (`dynamicPrompt` lacks "Company memory") and `:152`
  (`dynamicPrompt` lacks the engineer's memory fact): UPDATED (mine). Now stricter: the child's and
  the support seat's `systemPrompt` START with the run's exact `stablePreludeFor` bytes plus `\n\n`,
  `dynamicPrompt` ENDS with the rest of the run's injection, the two rejoin to `preludeFor`
  byte-for-byte, and `dynamicPrompt` no longer contains `## Company memory` (moved, not copied).
  Exit 0, 5/5, through the real orchestrator: the real pipeline carries `systemPrompt` to the hook.
- `apps/cli/src/repl/__tests__/delegate.repl.test.ts:214` and
  `apps/cli/src/repl/__tests__/fleet-memory.repl.test.ts:186`: NOT EDITED (apps/cli is another
  agent's). Both read `## Company memory` from `dynamicPrompt`. Needed change, one line each, plus
  `systemPrompt?: string` on each file's local `SeatInput` type:
  `expect(childInput?.systemPrompt).toContain("## Company memory");` and
  `const prelude = seatInputs[0]?.systemPrompt ?? "";`.
The other agents' failures in the baseline (P2-1 `model-env.pin`, `orchestrator.pin`, P2-8
`spend-truth`; 8 tests) were gone in the post-change run.

## LIVE proof (subshell `( set -a; source gem.env; set +a; TRENT_TEST_LIVE=1 npx vitest run
packages/trent-core/src/model-gateway/prompt-cache.live.test.ts -t "seat layout" )`, key never printed,
key occurrences in each log: 0)
The seat-layout case now renders both prompts with the REAL hook and the app's REAL
`executeSeatModel` (recorder on `createChatCompletion`), asserts before any spend that both system
messages are byte-identical and start with the stable tier, then sends exactly those messages.
| run | call | model | input | cached | output | cents |
|---|---|---|---|---|---|---|
| 1 | 1 | gemini-3.6-flash | 10,857 | 0 | 272 | 1 |
| 1 | 2 | gemini-3.6-flash | 10,808 | **0** | 252 | 1 |
| 2 | 1 | gemini-3.6-flash | 10,857 | 0 | 252 | 1 |
| 2 | 2 | gemini-3.6-flash | 10,808 | **8,164** | 252 | 1 |
| 3 | 1 | gemini-3.6-flash | HTTP 429 quota x3 (not billed) | | | 0 |
Run 1 exit 1 (miss on both calls), run 2 exit 0 (8,164 of 10,808 = 76 percent of the input, most of
which is the stable tier; the same 8,164 the P1-C reference layout got), run 3 exit 1
on a provider quota 429 before any call completed. Before this change the same case measured 0 in
2 of 2 runs (P1-C). Google documents implicit caching as best-effort; the first sighting of a prefix
missed here, as it did in P1-C's raw probes.
Spend: 4 cents metered (4 billed calls, each rounded up to 1 cent; true cost ~0.8 cent each).
Later: two retries of the same case (22:09 and 22:16 UTC) both got HTTP 429 "You exceeded your
current quota" on call 1, all three gateway attempts; no call completed, nothing billed. Stopped
retrying (other agents may share the key's quota). Session spend: **4 cents metered**.

## Docs
- `docs/configuration.md` "The three tiers": the "stable tier follows the objective today" sentence
  now says it heads the system message, CONTEXT/VOLATILE follow the objective, with the seat-layout
  numbers (8,164 of 10,808; 0 before) and that one of two runs missed.
- `docs/brain.md` context-tier paragraph: the same sentence, same numbers.
- `packages/trent-core/src/fleet-memory/README.md:85-88`: said the injection "rides in
  `dynamicPrompt`"; now names both fields. Outside the lead's file list; one sentence, flagged.

## Verification (repo root, TRENT_QUEUE_FALLBACK=disabled)
- `npx vitest run packages/trent-core/src/fleet-memory packages/trent-core/src/orchestrator
  packages/trent-core/src/improve/golden-capture.test.ts packages/trent-core/src/wrapped-modules.test.ts`
  -> exit 0, 59 files, 429 tests (no `src/context` dir exists; the tier assembly is in fleet-memory).
- `cd packages/trent-core && npm run build` (tsc --noEmit over `src/**/*`, tests included) -> exit 0.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0 (FleetSeatInput gained an optional field).
- `node scripts/ci/repo-scan.mjs` -> exit 0 (before and after the doc edits).
- No apps/web file touched, so no web typecheck needed (`git status --short apps/web` empty).
- `docs-truth.test.ts` + `docs-corpus.test.ts` -> exit 1, NOT from these edits: "states the command
  counts" wants 34/146 but the registry has 35/151 (the in-flight `service` command in
  `apps/cli/src/commands/index.ts`), and docs-corpus lacks `improve/fixtures/docs-corpus/embeddings.json`
  (ENOENT, P2-6 in flight). Every other docs-truth case and the byte-verified corpus case pass.
- Files under 500 lines: hook 498, tiers 194, new test 194, orchestrator test 186, live test 200.
- Nothing committed, stashed or pushed.

## For the lead (not fixed here; outside my files)
1. apps/cli: `delegate.repl.test.ts:214` and `fleet-memory.repl.test.ts:186` are RED on the new
   layout (one-line change each, above). Everything else in the affected set is green.
2. `improve/skill-injection.ts:113` prepends its prelude to `systemPrompt` INSIDE the fleet hook, so
   when it fires the stable tier is no longer byte 0. Smallest fix: insert after the stable tier, or
   install the improve wrapper outside the fleet hook (`orchestrator/index.ts:201-209`).
3. `apps/web/lib/model-gateway.ts:283-300` `cacheKeyForSeatModel` does not hash `systemPrompt`, so a
   change to the stable tier alone no longer changes the analyst semantic-cache key (it used to,
   through `dynamicPrompt`). Smallest diff (read-only file, Bobby decides): add
   `input.systemPrompt,` to the `prompt: [...]` array at `:289`.
4. Security note: the stable tier (company memory, brain `system/`, workspace context, org skills)
   now rides in the system message rather than the user message. The app already puts company
   skills, playbook and cross-company learnings there (`orchestrator-runtime.ts:1423-1462`), and
   Hermes freezes memory into its system prompt for the same cache reason, but seat-writable memory
   now carries system-role weight. The personality stays VOLATILE (asserted in the new test).

## Round 2: coordinator decisions on the four open items (18:30 local)
1. Fix the two apps/cli assertions myself (read `systemPrompt`; `systemPrompt?: string` on each
   local `SeatInput`), nothing else under apps/cli.
2. Skill injection must insert its prelude AFTER the stable tier (`improve/skill-injection.ts`,
   hunk marked `// [P2-7]`), failing test first in `orchestrator-hook.stable-first.test.ts`.
3. Mitigate the analyst semantic-cache key in the wrapper: the CONTEXT tier carries one line
   `Stable tier version: <first 12 hex of sha256 of the stable tier bytes>`, failing test first.
   The cleaner alternative, for Bobby: the one-line app fix, `input.systemPrompt,` added to the
   `prompt: [...]` array of `apps/web/lib/model-gateway.ts` `cacheKeyForSeatModel` (`:289`); it
   would make this line unnecessary.
4. Accepted: company memory rides in the system message, because its writes are provenance-tagged
   and held (`tools/memory/holds.ts`: an untrusted-context write waits on an approval row and lands
   tagged `[provenance: untrusted via <tools>]`). One sentence in docs/brain.md.
5. Live seat-layout case: up to three fresh pairs before failing, each pair's cached count logged.
   Spend cap this round: under 6 cents.

Design for (2), decided before coding: the injector cannot find the stable tier's end from the text
alone (the tier's last block is arbitrary), and adding a marker would change the cached bytes. So
`placeTiers` also returns the placed stable text under a registered symbol key
(`Symbol.for("trent.fleet-memory.stable-tier")`), which every wrapper between the hook and the
injector preserves (they pass the input through or spread it: `seat-guard.ts:116,136`,
`auto-recovery.ts:141`) and which no serializer or app cache key sees. `tiers.ts`
`insertAfterStableTier(input, text)` puts the prelude after it, or in front as before when the input
carries no stable tier.

### Round 2: RED (`orchestrator-hook.stable-first.test.ts`, exit 1, 2 failed / 4 passed)
- "with skill injection active, the stable tier is still the first bytes of the system prompt and
  the injected prelude follows it" (real `createSkillInjector` inside the hook, as in production,
  with a live `general` skill): FAILS at `:220` `system.startsWith(stable + "\n\n")` after
  `injector.appliedTo("step_1")` passed, i.e. the prelude fired and landed in front of the tier.
- "two prompts that differ only in the stable tier have different dynamicPrompt bytes, so the app's
  analyst cache never reuses an answer across a memory change" (same analyst question twice, one
  MEMORY.md append between the runs, real `executeSeatModel`): the preconditions pass (stable tier
  and systemPrompt differ) and it FAILS at `:255`: `dynamicPrompt` is byte-identical, so the app's
  key is too. The case also asserts 2 provider calls (today the second is served from the cache).

### Round 2: GREEN (exit 0, 6/6)
- `tiers.ts` (232 lines): `stableVersionBlock` (CONTEXT, last block, `Stable tier version: <12 hex>`
  of sha256 of the stable tier bytes, `CONTEXT_BLOCKS.stableVersion = "stable-version"`);
  `STABLE_TIER = Symbol.for("trent.fleet-memory.stable-tier")` returned by `placeTiers` beside the
  prompts; `insertAfterStableTier(input, text)`.
- `orchestrator-hook.ts` (499 lines): the version block appended after the seat's recalled blocks;
  the failures comment reworded in place (it is no longer the literal last CONTEXT block).
- `improve/skill-injection.ts`: two hunks marked `// [P2-7]` (the import; the prelude now goes
  through `insertAfterStableTier`, falling back to the old prepend when no stable tier rides along).
- apps/cli: the two assertions read `systemPrompt`, and each local `SeatInput` gained the field.
- Docs: `docs/brain.md` one sentence (company memory in the system message, accepted: writes are
  provenance-tagged and held, and reach a prompt only from the next run); `docs/configuration.md`
  one sentence on the version line.
- Live case: up to three fresh pairs, stopping at the first pair whose second call is served from
  cache; each pair's calls and `second_call_cached` logged; the layout preconditions run before any
  spend for every pair.

### Round 2: verification (repo root, TRENT_QUEUE_FALLBACK=disabled)
- `npx vitest run packages/trent-core/src/fleet-memory packages/trent-core/src/orchestrator
  packages/trent-core/src/improve/golden-capture.test.ts packages/trent-core/src/wrapped-modules.test.ts
  apps/cli/src/repl packages/trent-core/src/improve/trace-writer.test.ts
  packages/trent-core/src/improve/protected-prompt.test.ts apps/cli/src/tui/__tests__/context.test.ts`
  -> exit 1, 93 files, 656 passed / 2 failed. Both failures are
  `fleet-memory/brain-index.test.ts` "[P2-6] the embedder's own floor ..." (`:135`, `:146`): the P2-6
  agent's uncommitted +44-line RED over `recallFromBrain` (brain-index.ts not yet changed); they call
  `recallFromBrain` directly and touch nothing of this change. Both apps/cli REPL tests now pass.
- `cd packages/trent-core && npm run build` -> exit 0.
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 2: `apps/cli/src/repl/index.ts(267,13)` TS7022
  and `(295,22)` TS7023, both from the other agent's uncommitted line
  `session: { end: () => (engine.busy ? ...) }`, which references `engine` inside its own initializer.
  Exit 0 at the end of round 1, before that edit landed.
- `node scripts/ci/repo-scan.mjs` -> exit 0.
- Live seat-layout case, once, 22:28 UTC -> exit 1: all four pre-spend layout checks passed, then
  pair 1 call 1 got HTTP 429 "You exceeded your current quota" (3 attempts). 0 calls completed,
  **0 cents**. The same quota 429 as 22:09 and 22:16. Not retried (the coordinator said once).
  Session total stays **4 cents metered**. Key occurrences in the log: 0.
- Nothing committed, stashed or pushed.
