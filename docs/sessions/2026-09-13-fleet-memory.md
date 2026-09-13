# 2026-09-13 — fleet memory: every seat shares one company memory

Branch `feature/trent-fleet-v2`. Requirement: "make sure all the agents share memory so their work is better."
Owned: `packages/trent-core/src/fleet-memory/**` (new), `packages/trent-core/src/tools/memory/**`, a delimited
hook in `packages/trent-core/src/orchestrator/index.ts`. `src/improve/`, `src/store/`, `apps/web/` untouched.
No git commands run.

## Read first
- `01_discovery/references/hermes-self-improvement.md`: Hermes has no fleet memory scope; subagents cannot write memory.
- `01_discovery/references/cs329a-applied.md`: L9 memory-store branch with a ceiling; L8 contractor 5-18x finding.
- `tools/memory/` (per-profile files, frozen snapshot, write-time caps), `improve/` keys (company, agentId, taskType;
  `__org__` tier), `orchestrator/index.ts` seat wiring, `apps/web/lib/semantic-router.ts` lexical embedder (not exported).

## RED first
- `tools/memory/memory.test.ts`: 4 new tests failed (no `callerContext`, no `commitOperations`, no `thaw`).
- `fleet-memory/fleet-memory.test.ts`: whole suite failed (module absent). Then one wrong expectation of mine fixed
  (a recall block only renders when related work exists; the test now seeds a related run).
- `fleet-memory/fleet-memory.orchestrator.test.ts`: 1 failure was the test's own 200-char clip; fixed to 400.

## Built
- `tools/memory/store.ts`: `commitOperations` = mkdir lock -> re-read -> apply batch on fresh entries -> cap on merged
  result -> atomic write 0600 -> unlock. Merge is by entry; two seats never lose each other's write.
- `tools/memory/index.ts`: `callerContext()` (delegated child -> write `blocked`, read allowed), `thaw()`,
  `bindCallerContext()`; wording now says the files are company memory shared by every seat.
- `fleet-memory/`: `config.ts` (3000-char recall budget, env override), `lexical.ts` (router's TF-IDF reproduced),
  `source.ts` (port + in-memory), `app-source.ts` (runs via `listOrchestrationRunSnapshots`, playbook log, improve
  store), `recall.ts`, `search.ts` (`fleet_search`, `fleet_skill_view`), `shared-skills.ts` (org tier + own),
  `orchestrator-hook.ts` (frozen prelude per run into `dynamicPrompt`; run boundaries), `README.md`.
- `orchestrator/index.ts`: `deps.fleetMemory`; adapters join seat wiring; seat executor wrapped; `runStarted` after
  launch, `runFinished` in the finally.

## Evidence
- `npx vitest run packages/trent-core/src/fleet-memory packages/trent-core/src/tools/memory packages/trent-core/src/orchestrator`
  -> 10 files, 75 tests passed, exit 0. (One intermediate run showed transient failures with the memory suite at its
  pre-change test count; a rerun seconds later passed. Consistent with another agent's concurrent working-tree
  activity, not with the code.)
- `npx tsc --noEmit -p packages/trent-core/tsconfig.json` -> exit 0 at the end of the session. Earlier in the session
  it reported 4 errors, all in `src/improve/` (`org-tier.test.ts` GateVerdict shape x3, `sweep.ts:187` ActualsRunner),
  the other agent's; none in owned files at any point.
- Live, `TRENT_TEST_LIVE=1 npx vitest run packages/trent-core/src/fleet-memory/fleet-memory.live.test.ts` on
  gemini-3.5-flash-lite -> 3 passed, exit 0, 20 s. Run 1 (planner chose the ceo seat) wrote MEMORY.md through the tool;
  run 2 (support) prelude carried the fact from shared memory AND from recall of run 1's step output (prelude 544 chars,
  recall block 312 chars, under the 3000 cap); run 2 answered "47 requests per minute per key". The pipeline's critic
  logged `gpt-5.2 returned non-JSON` (pre-existing critic path, outside this scope).

## Not done / follow-ups
- REPL wiring (`apps/cli/src/repl/tools.ts`) does not build the hook; not in the owned set.
- `deps.fleetMemory` is optional; no surface passes it yet.
- Credentials: the Gemini key lives in `<repo>/gem.env` / `GEMINI_API_KEY`; never logged.
