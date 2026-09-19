# The self-improvement loop: gates

The loop can draft a skill, execute it against a frozen suite, and hand a human a decision. This
page is about what stops it from grading itself. Everything here is task D0 of the Hermes-parity
plan, built **before** reflection is switched on, because a loop that can rewrite its own exam is
not a loop that improves.

**Reflection is off.** `trent improve sweep` passes `skipLLM: true`, so no model proposes a prompt
or a skill today; the Foundry and GEPA use their deterministic fallbacks. Turning reflection on is
task D1, and it is gated on these seven checks being real.

## The seven gates

### 1. Frozen surface — the loop may not write what grades it

A do-not-modify list, enforced by path, not by intent (`improve/frozen-surface.ts`). Seven classes:

| class | what it covers |
|---|---|
| `suite` | the bundled eval suites (`apps/web/.agents/skills/<skill>/evals/`) and the mechanical overlays |
| `golden` | `<profile>/goldens/` and `<profile>/exemplars/` |
| `judge_prompt` | `improve/judge.ts` and any prompt file beside it |
| `gate_code` | `improve/`, `evals/` and `gepa/` — what executes, scores and selects |
| `read_only_memory` | every configured block with `read_only: true` |
| `judge_input_memory` | every other configured block: the judge's inputs are outputs of prompts those blocks are rendered into, so a memory delta moves the grader |
| `configured` | anything in `improve.frozen_paths` |

A draft whose write would land on one is **rejected before it is scored**, the path is named in the
iteration's `verdicts`, and a ledger row records the refusal under the actor `gate:frozen_surface`.
It costs no model call: the check is a path comparison.

### 2. Optimise / holdout split — promotion is decided on what reflection cannot see

Every suite has exactly one partition (`improve/suite-split.ts`); the public/private split that
shipped earlier **is** this one, renamed. About `improve.holdout_ratio` of fixtures (default 0.3)
land in the holdout, chosen by the first byte of `sha256(fixture id)` so the partition is identical
on every machine and every sweep. A fixture's own `holdout` flag, or the mechanical overlay's
`holdout: [ids]`, overrides the hash.

- **optimise**: the only failures a reflection is shown, and the score a sweep reports for an agent.
- **holdout**: never shown to a reflection, and the only side promotion is decided on.

A candidate that lifts the optimise side and drops the holdout is blocked `holdout_regression` and
stays in **quarantine** — not rejected: it was not proved bad, it was not proved good. A suite too
small to hold anything out measures the holdout on the whole suite rather than skipping the check.

### 3. pass^k — a fixture passes only if it passes k times in a row

`improve.pass_k`, default 3 (`improve/pass-k.ts`). Each trial runs the whole suite again with its
own trial number and **no gate cache**, so a judge verdict memoised on trial 1 can never be handed
to trial 3 and a runner that keeps state can reset between them. The merge is pessimistic: a
fixture's score is its worst trial, its failure tags are the union, and the cost is the sum. Three
trials cost three times one draw; that is the price of not promoting a coin flip.

### 4. Post-promotion regression trigger

Rollback existed and nothing called it. After `trent improve promote <draftId> --live`, the holdout
is re-run against what is now live, metered under the sweep cap, and compared with the holdout score
the gate measured before the promotion. A lower score rolls the promotion back through the existing
path — the previous artifact is live again byte-for-byte — and the ledger row names
`gate:holdout_regression` as the actor (`improve/post-promote.ts`).

Nothing is rolled back when the holdout could not be measured under the cap, when there is no
pre-promotion holdout score, or when the suite holds nothing out. An unmeasured re-run is not
evidence of a regression.

### 5. Content-hash veto

A draft that ended `rejected` — by a human, by a gate refusal, or as the candidate a rollback
reverted — puts its content hash in the veto set, as do the bytes each rollback took out of service
(`improve/veto.ts`). The same bytes proposed again are refused before scoring with
`blockedBy: "content_vetoed"`. The set is derived from the store on every sweep; it is not a second
source of truth.

### 6. Judge calibration as rates

`trent improve status` and `--json` report the judge as two rates with their counts, never raw
agreement on its own (`improve/calibration.ts`):

- **TPR** = human promotions the gate agreed with / every gated human promotion
- **TNR** = human rejections the gate agreed with / every gated human rejection

A judge that says yes to everything scores 0.9 raw agreement on a company that promotes nine drafts
in ten, and TNR 0. Below `improve.judge_min_tpr` or `improve.judge_min_tnr` (default 0.8 each) the
judge is **advisory**: its verdicts are still taken, stored and shown, and a pass may not make a
rubric fixture pass — the rubric stays pending and the candidate is blocked `unverified`. A side
with no decisions yet has a null rate and is not a breach; the counts say which case it is.

### 7. Sweep cap

`improve.sweep_cap_cents` is the sweep's hard spend cap in integer cents and defaults to
`budget.per_run_cap` (plan decision 8): a sweep may not outspend one run by accident. The CLI passes
it as the sweep's `budgetCents` and prints it, what was spent, and whether the sweep stopped there.
A draft the meter could not afford to measure stays in quarantine as `budget_exhausted`; it is never
rejected for being unaffordable.

## Configuration

```yaml
improve:
  holdout_ratio: 0.3      # share of every suite held back for the promotion decision
  pass_k: 3               # consecutive trials a fixture must pass
  judge_min_tpr: 0.8      # below this the judge is advisory
  judge_min_tnr: 0.8
  sweep_cap_cents: 100    # integer cents; defaults to budget.per_run_cap
  frozen_paths: []        # extra paths the loop may never write
```

## What a human sees

- `trent improve status` — quarantine with each draft's gate reason, the two judge rates and
  whether the judge is advisory, and the counters for holdout regressions, frozen refusals and
  content vetoes.
- `trent improve sweep` — per agent what was distilled, gated and rejected, then the cap, the spend,
  whether the cap stopped the sweep, the pass^k in force, and whether the judge was advisory.
- `trent improve promote <id> --live` — the promotion, then the holdout re-run and, if it regressed,
  the rollback that already happened.
- `trent improve history` — every refusal as a ledger row: `gate:frozen_surface`,
  `gate:content_vetoed`, `gate:repetitive_loop`, `gate:holdout_regression`.

## What is deliberately not here

- **Reflection.** No model proposes anything yet (task D1).
- **A suite per seat.** Suites come from goldens captured on real runs (plan decision 4); until a
  seat has one, its drafts are `no_suite` and cannot be promoted at all.
- **Automatic promotion.** Promotion is a human command and stays one (`improve/lifecycle.ts`).
