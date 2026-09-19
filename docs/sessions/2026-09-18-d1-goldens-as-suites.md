# 2026-09-18 — D1: every seat can promote (goldens as suites, judge model, `--live`)

Task D1 of the Hermes-parity plan, wave 2. Brief: suite lookup by seat id, suites assembled from
promoted goldens (decision 4), reflection switchable under the sweep cap, a judge on a different
model from the executor (decision 6), and the roster the sweep actually walks.

## What landed

1. **Suite lookup by seat id.** `apps/cli/src/commands/improve.ts` resolved suites through
   `getCatalogAgent(agentId)?.skills`, which returns undefined for every seat id, so every seat was
   `no_suite` forever (audit 4.3, shortfall 2). `improve/seat-suite.ts` resolves a seat from its
   promoted goldens plus its skills in the app's `SLOT_ENVIRONMENTS`; a catalog specialist keeps
   the old path. The `no_suite` refusal now names the seat and both golden counts, carried by a new
   `noSuiteReason` dep on `runImprovementSweep`.
2. **Goldens as suites.** `improve/golden-store.ts` (read and review `<profile>/goldens`, the app's
   file format, no app import) and `improve/golden-suite.ts` (a capture becomes a fixture: the
   sanitised objective, a `state_check` that the captured trajectory failure tags do not come back,
   any mechanical assertion the capture carries, one rubric per reviewer assertion and one for the
   captured reason). `goldenActuals` wraps the runner so the tag grader has state to read; a runner
   that observed no trajectory reports no reproduced tag, and that limit is documented rather than
   hidden. `trent improve goldens list | show | promote | reject` is the human gate
   (`apps/cli/src/commands/improve-goldens.ts`). `<profile>/goldens` was already frozen by D0's
   surface (class `golden`); a test now asserts it.
3. **Reflection under the cap.** `skipLLM: !opts.live`. `--live` refuses, before any provider call,
   unless an agent in scope has `improve.min_goldens` (default 5) promoted goldens, and it keeps
   the D0 sweep cap. The sweep report carries `reflected` and the judge model.
4. **Judge model.** `improve/judge-model.ts` resolves `improve.judge_model` -> `models.planner`
   (when it differs) -> the strongest priced Gemini model that differs. Equal judge and executor is
   a configuration error naming both. The CLI builds a second gateway pinned to the judge's model.
   Same family on one key is the recorded limit (decision 6).
5. **Third roster.** `improve/trace-writer.ts` `CORE_SEATS` is derived from the fleet's
   `CORE_ROLE_IDS`, so the sweep stops evolving a phantom `browser` seat and starts sweeping
   `sales`. `improve/roster.test.ts` joins the three lists.

## Verification (exit codes)

- `npx vitest run packages/trent-core/src/improve packages/trent-core/src/evals apps/cli/src/commands/__tests__/improve*.test.ts packages/trent-core/src/config` -> 0 (32 files, 209 tests)
- `npx vitest run packages/trent-core/src/fleet orchestrator/seats-unshelved.test.ts cli fleet+heartbeat` -> 0 (25 files, 210 tests)
- `npx tsc --noEmit -p apps/cli/tsconfig.json` -> 0
- `node scripts/ci/repo-scan.mjs` -> 0
- `npm --prefix packages/trent-core run build` -> 2, with 8 errors, all in files owned by other
  wave-2 agents mid-flight (`src/checkpoints/ledger.test.ts`, `src/fleet-memory/brain-migrate.test.ts`,
  `src/tools/memory/brain-read.test.ts`). None in `improve/`, `evals/` or `config/`.

## Deviations

- The `// [D1] judge` config block is contiguous and marked but sits at the END of the `improve`
  object in `config/schema.ts` and `defaults.ts`, not before the `personality:` line: the keys are
  `improve.judge_model` and `improve.min_goldens`, and an object literal cannot declare a nested
  key from another position.
- The CLI goldens commands and the post-promotion holdout re-run live in a new
  `apps/cli/src/commands/improve-goldens.ts`; `improve.ts` would otherwise pass 500 lines.

## Follow-up: the registry dry-run contract

`registry.test.ts` probes every command with `--dry-run` and a placeholder argument and expects
exit 0 with parseable JSON. The three id-taking goldens commands resolved the id first and so
exited 2 on the probe. They now share one dry-run branch (`dryRunAnswer`) returning
`{dryRun, command, dir, goldenId, exists, review}` at exit 0 without touching the file; the real
`EXIT.USAGE` refusal for an unknown id stands outside a dry run. Covered by a new case in
`apps/cli/src/commands/__tests__/improve-goldens.test.ts`.

`npx vitest run apps/cli/src/commands/__tests__/registry.test.ts apps/cli/src/commands/__tests__/improve-goldens.test.ts`
-> 1: the three `improve goldens *` probes pass; the one remaining failure is `brain show`
(`apps/cli/src/commands/groups/brain.ts`, untracked, another agent's file), which refuses the same
way D1's did. `npx tsc --noEmit -p apps/cli/tsconfig.json` -> 0.
