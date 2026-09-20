# 2026-09-20 — `trent budget status` adopts the shared spend report

Branch `feature/trent-fleet-v2`, HEAD `2bf5df2`. Implementation agent; no commits, no `git add`,
no subagents. `TRENT_QUEUE_FALLBACK=disabled` in every shell. `docs/doctor.md` was already modified
in the tree before this session and is not touched here.

## Objective

`apps/cli/src/commands/groups/usage.ts` says `trent budget status` and `trent usage` read the ledger
"through the same report (`spend-report.ts`), so the two never disagree about a number". Today
`budget.ts` reads `openSpendLedger(...).dailyTotalCents` / `dailyBySurfaceCents` directly. Make the
claim true without changing `BudgetStatusData`, the JSON contract, the render lines or `--date`.

## Findings before the change

- `SpendWindow` (`spend-report.ts`) is a struct `{requested, from, to, days}`; `buildSpendReport`
  only reads `from`/`to`, so a one-day window `{from: day, to: day}` gives `today == period` for
  that day. `resolveSpendWindow` cannot build it: its `to` is always today, and a `--date` in the
  past must still work. A small constructor, `spendDayWindow(day)`, is the minimal extension.
- The two readers agree cent for cent on ordinary rows (both `Math.trunc` cents, both skip a row
  whose `at` is unreadable, both key by the local day on the ledger's zone). The one real
  divergence: a row whose `surface` is `""` (accepted by `isSpendRow`, typeable via
  `SpendSurface`'s `(string & {})`) is keyed `""` by `dailyBySurfaceCents` and `unattributed` by the
  report. The guard test includes such a row so it is RED before the change.

## Steps

1. RED: `apps/cli/src/commands/__tests__/budget.test.ts` gains a cross-command agreement test;
   `packages/trent-core/src/governance/spend-report.test.ts` gains `spendDayWindow` tests.
2. GREEN: `spendDayWindow` in `spend-report.ts`; `budget.ts` computes its totals from
   `buildSpendReport(ledger.rows(), { now, tz, window: spendDayWindow(date), by: "surface" })`.
3. Docs: one sentence in `docs/configuration.md`; usage.ts header unchanged (now true).
4. Verify: vitest (cli commands + governance), tsc for both packages, repo-scan.

## RED evidence

`npx vitest run apps/cli/src/commands/__tests__/budget.test.ts packages/trent-core/src/governance/spend-report.test.ts`
before the change: 4 failed / 16 passed. The agreement test failed on `bySurface` for the
empty-surface row (`""` from the ledger vs `unattributed` from the report); the totals already
agreed. The three `spendDayWindow` tests failed on "is not a function".

## Change

- `packages/trent-core/src/governance/spend-report.ts`: `spendDayWindow(day)` (one-day window,
  config error on a non-day); `SpendWindow.to` doc no longer claims the window always ends today.
- `apps/cli/src/commands/groups/budget.ts`: total and `bySurface` from
  `buildSpendReport(ledger.rows(), { now, tz, window: spendDayWindow(date), by: "surface" }).today`;
  header names the report. Output shape, JSON, render lines, `--date` and its validation unchanged.
  Behaviour delta: a row with `surface: ""` is now listed as `unattributed`, as `trent usage` lists it.
- `docs/configuration.md`: one added sentence after the existing budget/usage line.
- Not touched, noted for the owner: `spend-ledger.ts`'s `SpendLedgerReader` doc still says
  `trent budget status` takes it; the ledger was out of scope for this change.

## Verification (repo root, `TRENT_QUEUE_FALLBACK=disabled`)

| Command | Exit |
|---|---|
| `npx vitest run apps/cli/src/commands/__tests__ packages/trent-core/src/governance` | 0 (51 files, 1234 tests) |
| `npx vitest run packages/trent-core/src/wrapped-modules.test.ts apps/cli/src/commands/__tests__/docs-truth.test.ts apps/cli/src/commands/__tests__/budget.test.ts apps/cli/src/commands/__tests__/usage.test.ts packages/trent-core/src/governance/spend-report.test.ts packages/trent-core/src/governance/spend-ledger.test.ts apps/cli/src/runtime/headless.spend.test.ts` | 0 (7 files, 61 tests) |
| `npx tsc -p apps/cli/tsconfig.json --noEmit` | 0 |
| `npx tsc -p packages/trent-core/tsconfig.json --noEmit` | 0 |
| `node scripts/ci/repo-scan.mjs` | 0 |

An earlier run of the first command showed 2 failures in `idempotent-dispatch.test.ts`; those were
another session's in-flight `[Y2]` RED tests (its diff also touches `stripe.test.ts` and
`registration.test.ts`), and they were green on the rerun once that work landed. Nothing in this
session touches those files. No commits, no staging.
