# 2026-09-26 — C2: hold untrusted memory writes on fleet runs

Council item C2 (`02_plan/output/hermes-council-verdict-2026-09-26.md`, Tier 1). Branch
`feature/trent-fleet-v2`, HEAD 62abfc0 (S3 landed in df1ce0f). No subagents (the brief says so). No
commit, stash, checkout, reset or push. Every hunk in an existing file carries `// [C2]`.

Owned: NEW `packages/trent-core/src/tools/memory/gate.ts`, `solo/memory-gate.ts` (becomes the solo
binding of the shared gate), `orchestrator/index.ts`, `apps/cli/src/repl/tools.ts`,
`apps/cli/src/runtime/headless.ts`, NEW `apps/cli/src/runtime/headless.memory-gate.test.ts`, this log.
`tools/index.ts` only if a net-zero change is needed (it is at the ceiling). Not touched: docs/*.md,
README, gateway/, webhooks/, egress/, service/, governance/auto-review*, tools/browser (other agents).

## Read first
AGENTS.md; the rulebook's Universal Coding Rules and Phase 4; C2 in the verdict (and row 2 of the
agreed table); `solo/memory-gate.ts`; the S3 log (finding 1, item 2); `governance/provenance.ts`
(the ledger keys taint by (run, step) per INSTANCE, `createProvenanceLedger`; a session-bound solo run
reads the session taint instead, which is why solo's fresh ledger works and the fleet's would not);
`tools/index.ts` (`buildTrentTools` builds the ledger at :410 and ALREADY returns it as
`TrentToolBuild.provenance` at :435; nothing in production reads that field);
`orchestrator/index.ts:193`; `apps/cli/src/repl/tools.ts` (`wireTools` drops `build.provenance`);
`apps/cli/src/runtime/headless.ts`; `apps/cli/src/repl/fleet-memory.ts:170`;
`tools/memory/holds.ts`; the app's seat loop (`apps/web/lib/seat-agent-loop.ts:424`: a
`needs_approval` record pauses the step for approval).

## Findings before code (facts, with where)
1. `orchestrator/index.ts:193` concatenates `deps.fleetMemory.adapters` after `deps.tools` bare. The
   tools were wrapped by `buildTrentTools`' chain; the hook's `memory`, `fleet_search`, `brain_read`
   were never wrapped by anything in fleet mode (solo wraps them since S3, `runner-for-mode.ts:278`).
2. The ledger is already on the build result (`TrentToolBuild.provenance`); `ToolWiring` does not
   carry it, so `headless.ts` cannot hand it on. `tools/index.ts` needs no change.
3. Solo's gate uses a fresh ledger and works only because a solo run binds its session taint
   (`bindSessionTaint`), which every ledger instance reads first. A fleet run binds none, so a fresh
   ledger there would see no taint: the fleet gate MUST share the chain's ledger instance.
4. The fleet's step key: the drain loop enters `runWithToolCallContext({runId, stepId})` per
   `orchestration_step` job, so a web read and a memory write in one seat turn loop share a key.

## Log
### Baseline (before any edit, 02:27, load average ~195)
`TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo/memory-writes.test.ts`
-> exit 0, `Tests 4 passed (4)`. `git diff --stat HEAD` over every file this item may edit: empty.

### Red (02:30)
New `apps/cli/src/runtime/headless.memory-gate.test.ts`: `createHeadlessRuntime` with the REAL
`buildTrentTools` (through the S2 `buildTools` seam, `toolsets: []`, one fake `web` adapter with a
`web_extract` tool as an extra adapter, so the chain and its ledger are the production ones), the REAL
fleet-memory hook and memory adapter over a temp profile, and the REAL orchestrator with a scripted
planner (`createCompletion`) and a scripted seat (`executeSeatModelFn`): engineer seat, turn 1
`web_extract`, turn 2 `memory {"target":"memory","action":"add",...}`. Provider keys are deleted from
the env for the file, so nothing can reach a provider. A step parked for approval is rejected so the
run ends. Test 2 is the control: `memory add` with no read.
`TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/runtime/headless.memory-gate.test.ts`
-> exit 1, `Tests 1 failed | 1 passed (2)`. The red line:
`expected 'Supplier deposits go to account 99.' not to contain 'account 99'` (the page-derived line was
written to MEMORY.md with no hold; the seat's turn 2 ran, so turn 1's `web_extract` ran and was not
blocked). The control passes today, as it must.

### Green (02:32)
- NEW `packages/trent-core/src/tools/memory/gate.ts`: S3's wrapper moved here (`gatedMemoryAdapters`,
  `MemoryGateOptions`), unchanged in behaviour except the seat default: absent, `holdMemoryWrite`'s own
  (`orchestrator`, what the chain's holds already name), because `tools/` must not import `solo/`.
- `solo/memory-gate.ts`: now solo's binding of the shared gate (re-exports the type; binds `seat` to
  `SOLO_SEAT` when the caller names none), so every solo importer is unchanged and solo rows still name
  `trent`.
- `orchestrator/index.ts`: `memoryGate?: MemoryGateOptions` on the deps; `allTools` wraps
  `fleetMemory.adapters` with the gate (+4 lines, 472).
- `apps/cli/src/repl/tools.ts`: `ToolWiring.provenance` carries `build.provenance` (absent on the legacy
  `buildAdapters` seam, which wraps nothing).
- `apps/cli/src/runtime/headless.ts`: hands `{ profileDir, ledger: tools.provenance, policy:
  config.provenance }` to the orchestrator (+3 lines, 490).
- `tools/index.ts`: untouched; the ledger was already on `TrentToolBuild.provenance`.
`TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/runtime/headless.memory-gate.test.ts`
-> exit 0, `Tests 2 passed (2)`.

### The ledger instance is load-bearing (checked by reverting one expression)
Removed only `...(tools.provenance === undefined ? {} : { ledger: tools.provenance }), ` from headless.ts
(backup in the scratchpad; md5 `80382bf3…` before and after the restore), so the fleet gate got a
ledger of its own: the same command -> exit 1, `Tests 1 failed | 1 passed (2)`,
`expected 'Supplier deposits go to account 99.' not to contain 'account 99'`. A fresh ledger sees no
taint in a fleet run; only the chain's instance does.

### Verification (02:40-03:10, load average 195-405)
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo/memory-writes.test.ts` -> exit 0, `Tests 4 passed (4)` (after the move).
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> exit 0.
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run apps/cli/src/runtime` -> exit 1, `Test Files 1 failed | 13 passed (14)`,
  `Tests 2 failed | 91 passed (93)`. Both failures are `child-run.test.ts` [P2-10] (`service install` dry run now exits 3:
  "This service would forget its runs ... pass --allow-ephemeral"): C10's in-flight, uncommitted service-durability work
  (`apps/cli/src/commands/groups/service.ts` M, `packages/trent-core/src/service/durability.ts` ??). Nothing of C2 is on
  that path. `headless.memory-gate.test.ts`, `solo-continuity.test.ts` and every `headless.*.test.ts` pass.
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/solo` -> exit 0, `Test Files 20 passed (20)`, `Tests 116 passed (116)`.
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/fleet-memory` -> exit 0, `Test Files 37 passed (37)`, `Tests 313 passed (313)`
  (includes the two real-orchestrator suites that pass `fleetMemory`).
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/tools/memory` -> exit 0, `Tests 44 passed (44)`.
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/wrapped-modules.test.ts` -> exit 0, `Tests 3 passed (3)` (ceiling).
- `TRENT_QUEUE_FALLBACK=disabled npx vitest run packages/trent-core/src/orchestrator` -> exit 0, `Test Files 30 passed (30)`, `Tests 219 passed (219)`.
- `cd packages/trent-core && npm run build` -> exit 0.
- `node scripts/ci/repo-scan.mjs` -> exit 0 (1259 files, every check `PASS - 0 violations`).
- Anchored marker grep over the touched files -> exit 1 (0 matches). Every hunk in an existing file has a `[C2]` add
  (`git diff -U0`: orchestrator 3/3, repl/tools 3/3, headless 3/3, solo/memory-gate 4/4). Sizes: headless.ts 490,
  orchestrator/index.ts 472, repl/tools.ts 326, tools/index.ts 499 (untouched).

## Finding for later (not changed here: the app's seat loop is read-only, and this is C5's hold design)
In a fleet run the held write parks the STEP (`seat-agent-loop.ts:424`, a `needs_approval` record pauses it). If the
founder approves that STEP rather than the held ROW, the loop replays the pending `memory` call with
`approvalGranted` (`seat-agent-loop.ts:233`); the gate's ledger is still tainted for that (run, step), so the replay is
held again (a second pending row) and the seat moves on without the write. Fail-closed (nothing unapproved reaches
MEMORY.md), but two rows for one write, and a step approval that does not do what it says. The test rejects the step
so exactly one row stands. A fix would decide the held row when its step is approved, or suppress the second hold.

## Files
New: `packages/trent-core/src/tools/memory/gate.ts`, `apps/cli/src/runtime/headless.memory-gate.test.ts`, this log.
`[C2]` hunks: `packages/trent-core/src/solo/memory-gate.ts`, `packages/trent-core/src/orchestrator/index.ts`,
`apps/cli/src/repl/tools.ts`, `apps/cli/src/runtime/headless.ts`. Not touched: `tools/index.ts`,
`apps/cli/src/repl/fleet-memory.ts`, every solo importer of `memory-gate` (the solo binding keeps their import).
