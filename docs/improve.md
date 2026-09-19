# The self-improvement loop: gates

The loop can draft a skill, execute it against a frozen suite, and hand a human a decision. This
page is about what stops it from grading itself. Everything here is task D0 of the Hermes-parity
plan, built **before** reflection is switched on, because a loop that can rewrite its own exam is
not a loop that improves.

**Reflection is switchable, and off by default.** `trent improve sweep` passes `skipLLM: true`
unless it is given `--live`, so no model proposes a prompt or a skill on an ordinary sweep; the
Foundry and GEPA use their deterministic fallbacks. What `--live` costs, what it refuses to do,
and who grades it are task D1, below the seven gates.

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
  judge_model: ""         # [D1] empty: resolved at run time, and never the executor's model
  min_goldens: 5          # [D1] promoted goldens a seat needs before `--live` reflects for it
```

## What a human sees

- `trent improve status` — quarantine with each draft's gate reason, the two judge rates and
  whether the judge is advisory, and the counters for holdout regressions, frozen refusals and
  content vetoes.
- `trent improve sweep` — per agent what was distilled, gated and rejected, then the cap, the spend,
  whether the cap stopped the sweep, the pass^k in force, whether the judge was advisory, and
  [D1] whether reflection ran and which model graded it.
- `trent improve goldens list` — every captured failure, its review state and the seats it gates.
- `trent improve promote <id> --live` — the promotion, then the holdout re-run and, if it regressed,
  the rollback that already happened.
- `trent improve history` — every refusal as a ledger row: `gate:frozen_surface`,
  `gate:content_vetoed`, `gate:repetitive_loop`, `gate:holdout_regression`.

## [D1] Goldens are the suites

A seat had no suite at all, so every seat's draft came back `no_suite` and no seat could ever
promote an improvement: the CLI resolved suites through `getCatalogAgent(agentId)?.skills`, and the
catalog holds 164 specialist ids and not one seat id. A seat now resolves its suite **by seat id**,
from two sources (`improve/seat-suite.ts`):

- its **promoted goldens** — the only growth path plan decision 4 allows;
- its **own skills**, which live in the application's `SLOT_ENVIRONMENTS`, for the few that ship an
  `evals/evals.json` and for the wrapper's mechanical overlays.

A catalog specialist keeps the path it always had. A seat with neither is still refused, but the
refusal now names the seat and both golden counts rather than saying `no_suite` nine times.

### What a golden becomes

A capture under `<profile>/goldens` is a failing run, sanitised by the app's own redaction
(`improve/golden-capture.ts` over `apps/web/lib/orchestration-golden-capture.ts`). As a fixture
(`improve/golden-suite.ts`) it carries:

| part | from |
|---|---|
| the prompt | the sanitised objective, re-run under the candidate |
| a `state_check` grader | the captured `trajectory_*` failure tags must not come back |
| `contains` / `tool_call` | any mechanical assertion the capture already carries |
| one `llm_rubric` per assertion | assertions a reviewer added to the file |
| one `llm_rubric` for the failure | the captured reason, carried to the judge |

The failure-tag grader is only as strong as the runner's observation, and that is deliberate:
`goldenActuals` intersects the tags the runner **reports** (`state.failureTags`) with the tags the
capture holds. An orchestrator-backed runner fills those; the one-completion runner `--live` uses
cannot, so it reports no reproduced tag and the rubric carries the fixture. What is never inferred
is a pass from an absent check: without the wrapper there is no state to read and the fixture fails
deterministically.

Goldens are attributed to the seats whose traces show they ran the captured run (`runId`), unless
the file names its own `seats`. The suite honours the [D0] holdout split and pass^k like any other:
a golden suite splits by the same fixture-id hash, and each fixture is run `improve.pass_k` times.

### The human gate

```
trent improve goldens list            what was captured, its review state, the seats it gates
trent improve goldens show <id>       the golden, and the fixture it becomes
trent improve goldens promote <id>    quarantined -> promoted; now part of the seat's suite
trent improve goldens reject <id>     it never enters a suite
```

Every golden starts quarantined. Only a promoted golden enters a suite, and promotion is a human
command — as is every other promotion in this loop. The loop itself may not write the directory:
`<profile>/goldens` is frozen, class `golden` (gate 1), so the thing being graded cannot edit the
exam.

## [D1] The judge model

`improve.judge_model` is the model the eval judge runs on. **Empty is not "no judge"**: it means
resolve one at run time (`improve/judge-model.ts`), in this order:

1. `improve.judge_model`, when an operator set one;
2. the configured planner-tier model (`models.planner`), when it differs from the executor;
3. otherwise the strongest model in the wrapper's own price table (`model-gateway/pricing.ts`)
   whose id differs from the executor's.

The judge and the executor may never be the same id: equal models are a configuration error that
names both, because a judge that is the executor shares its blind spots and its idea of a good
answer, and the rate that would expose that (TNR, gate 6) is exactly the one a self-grading judge
inflates. The sweep builds a second gateway pinned to the judge's model and prints which model
graded.

**The limit, recorded.** On one provider key the judge is a different model of the **same family**
as the executor (plan decision 6). A same-family judge is weaker than an independent one and is
accepted only until a second provider key exists; `trent improve status` keeps reporting TPR and
TNR so the weakness is measured rather than assumed.

## [D1] `--live`: reflection, metered

`trent improve sweep --live` turns reflection on — the Foundry and GEPA propose through the model
instead of their deterministic fallbacks — and it is held to three things:

- **model access.** Without a configured key the sweep fails with the provider named; nothing is
  half-run.
- **the sweep cap.** The same `improve.sweep_cap_cents` as an offline sweep (gate 7). A draft the
  meter could not afford stays in quarantine as `budget_exhausted`.
- **`improve.min_goldens` (default 5).** No agent in scope with that many **promoted** goldens and
  the sweep refuses, before a single model call, printing the promoted/quarantined count per agent.
  A reflection measured on one or two fixtures is noise with a bill attached.

Without `--live`, `skipLLM: true` stands and GEPA's evolved prompt is the literal marker it has
always been offline.

```yaml
improve:
  judge_model: ""    # empty: resolved at run time, and never the executor's model
  min_goldens: 5     # promoted goldens a seat needs before --live will reflect for it
```

## What is deliberately not here

- **Automatic promotion.** Promotion is a human command and stays one (`improve/lifecycle.ts`),
  for a draft (`trent improve promote`) and for a golden (`trent improve goldens promote`).
- **Authored suites.** No agent and no founder writes a fixture: a suite grows only from a failure
  a real run produced (plan decision 4).
- **An independent judge.** The judge is a different model on the same key and the same family
  until a second provider key exists (decision 6, above).
