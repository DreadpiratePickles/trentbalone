# 2026-09-18 — D0: improvement gates (wave 2, opened early)

Task D0 of `02_plan/output/implementation-plan-hermes-parity.md`: the self-improvement loop cannot
grade or rewrite itself. Gates only; **reflection stays off** (the CLI sweep still passes
`skipLLM: true`). Branch `feature/trent-fleet-v2`, no commits made by this agent.

## What landed

| gate | code | proof |
|---|---|---|
| 1 frozen surface | `improve/frozen-surface.ts`, `improve/draft-gates.ts`, `promoteDraft(..., { frozen })` | `frozen-surface.test.ts` (one refusal per class), `gates.test.ts` (sweep + promotion door) |
| 2 optimise/holdout | `improve/suite-split.ts` (the old public/private split, unified, not duplicated), `gate.ts` | `suite-split.test.ts` |
| 3 pass^k | `improve/pass-k.ts`, `gate.ts`, `sweep.ts` | `pass-k.test.ts` |
| 4 post-promotion re-run | `improve/post-promote.ts`, CLI `promote --live` | `post-promote.test.ts` |
| 5 content-hash veto | `improve/veto.ts`, `improve/draft-gates.ts` | `gates.test.ts` |
| 6 judge calibration as TPR/TNR | `improve/calibration.ts`, `status.ts`, `gate-score.ts` (advisory judge) | `gates.test.ts`, `improve-gates.test.ts` |
| 7 sweep cap | `config` block + CLI `sweep` | `improve-gates.test.ts`, existing `sweep.test.ts` I.2 |

Config: one `// [D0] improvement gates` block in `config/schema.ts` and `config/defaults.ts`,
immediately before the config object closes. `improve.sweep_cap_cents` defaults to
`budget.per_run_cap` (decision 8), asserted in `config/improve-schema.test.ts`.

Docs: `docs/improve.md` (new) — the seven gates, the keys, and what stays off.

## Decisions worth remembering

- The block reason `private_regression` became `holdout_regression`, and a holdout regression now
  leaves the draft in **quarantine** instead of rejecting it: it was not proved bad, only not
  proved good. `repetitive_loop` still rejects.
- `GateVerdict.score` stays the whole-suite measure; the **sweep** records the optimise partition
  on the iteration row, and promotion is decided on the holdout.
- pass^k defaults to 3 at the sweep (`SweepDeps.passK`), and to 1 in `executeGate`, which is the
  primitive. The three cost-arithmetic tests in `sweep.test.ts` now pass `passK: 1` explicitly and
  say why; pass^k's own cost is proved in `pass-k.test.ts`.
- `BASELINE_CACHE_SCHEMA` moved to v3 and the key carries k: a one-trial baseline must never be
  compared with a pass^k candidate.
- `judge_advisory` is excluded from the new-failure-cluster check, so the reason a human reads is
  `unverified`, not a symptom.

## Not done here

- The CLI's post-promotion re-run needs model access, so it runs under `--live` only.
- No seat has a suite yet (plan task D1), so the gates are exercised by tests and by any agent whose
  skills carry `evals/evals.json`; every other agent is still `no_suite`.
