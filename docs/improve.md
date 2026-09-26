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
| `ranking` | [W3] `fleet-memory/recall.ts`, `hybrid.ts`, `brain-index.ts` and `fleet-memory/ingest/`: what the recall gate measures |
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
- `trent improve goldens list` — every captured failure, its review state and the seats it gates,
  and [W3] every retrieval golden with its source.
- `trent improve retrieval` — [W3] recall@8 over the promoted retrieval goldens, per query, against
  `retrieval.min_recall`; exit 1 under the floor.
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

## [D3] Provenance: which skills the loop is allowed to touch

The curator's autonomy is bounded by one declared field. A skill in the profile's store carries
`created_by: human | agent | import`, and only `agent` skills are eligible for autonomous
curation — the aging pass that moves a skill `active` to `stale` to `archived`, and the
composed-skill scan gate that can hold one `quarantined`. A skill a person installed with
`trent skills install`, or one that arrived through an import, is **reported** with its idle days
and left alone however old it gets. (This loop's own skill drafts are a different store, and their
gate is the one above: `promoteDraft` is a human command and nothing else opens it.)
Provenance is declared and never inferred: nothing reads usage counts, authorship of the last
edit, or any other signal and concludes a skill is the agent's. The one way it changes is
`trent curator adopt <skill>`, a human command, and that change is itself a ledger row. The point
is that the loop's autonomy has a boundary a person drew on purpose, rather than one that drifts
as telemetry accumulates — the same reason promotion is a human command. Every mutation the
curator makes is appended to `<profile>/skills/.ledger.ndjson` with content-addressed before and
after blobs, so any single one can be reversed with `trent curator undo <id>`. See
[skills.md](skills.md), "Curator".

## [D5] Tools improve too

The best-evidenced improvement in production is not the agent rewriting itself. Anthropic's
multi-agent research system measured a **40% reduction in task completion time** from an agent
that rewrote failing tool descriptions, and their own SWE-bench work reports more engineering
time spent on tools than on prompts (`01_discovery/output/agent-harness-sota-2026-09.md`, item D4
and consensus principle 12). So the loop drafts tool descriptions as well as skills and prompts —
under exactly the same gates, and with a human at the end.

### The signal

Every sweep measures, per tool, from the traces it already reads (`improve/tool-health.ts`):

| rate | what it counts |
|---|---|
| `failureRate` | calls that ended `failed` or `blocked` |
| `invalidArgumentRate` | calls refused because the ARGUMENTS were wrong, not the world |
| `retryRate` | immediate re-calls of the same tool with corrected arguments |
| `meanArgsBytes` | the size of the argument bag, in bytes of canonical JSON |

A tool is proposed for when its **invalid-argument rate or its retry rate** exceeds
`tool_health_threshold` (0.2) over at least `tool_health_min_calls` (20) calls. The failure rate
is reported and never triggers on its own: a tool that fails because the world said no is not a
tool whose description is wrong. A tool whose model keeps re-calling it with different arguments
straight after a refusal is exactly that.

Nothing is inferred from an entry that does not carry it. A trace entry is one of three shapes —
a bare adapter name (`apps/web/lib/trace-store.ts` maps a `ToolCallRecord` down to that),
`name:action` (the gate's `extractToolCalls`), or the whole record as JSON — and a bare name
counts a call and no failure, so a profile whose traces carry only names never crosses a
threshold by accident. The one exception is the application's own convention: the last call of a
step that failed is the call that failed.

### The proposal

A tool over the threshold produces one draft of kind `tool` (`improve/tool-drafts.ts`) carrying
the tool name, the shipped description, the evidence — the four rates, their counts, and three
**redacted** example refusals — and a proposed description. Offline the proposal is a
deterministic template that quotes the evidence and asks for a rewrite; it is the same bytes
every sweep, which is what makes the veto work. Live it is the reflection model's answer, metered
through the sweep's meter and stopped by the same cap.

The draft is a draft like any other. It lands in quarantine, the frozen surface (gate 1) and the
content-hash veto (gate 5) refuse it before it is scored, a re-proposal of rejected bytes is
refused with a ledger row under `gate:content_vetoed`, and the only door out is
`trent improve promote <draftId>` — a human command. Tool drafts are held under the pseudo-agent
`__tools__` with the tool name as their task type, because a tool belongs to the profile rather
than to whichever seat called it most, and one tool has one live description. A tool description
that ships in code is still proposable: the frozen surface covers the suites, the goldens, the
judge prompt and the gate code, not the tools being graded.

There is deliberately no executing gate on a tool draft. A tool's evidence is its measured call
history; scoring a description against a seat's goldens would measure the seat. The iteration
therefore sits `quarantined` with `human_review`.

### What a promotion does

A promoted `tool` draft is written to `<profile>/tool-overrides.json` — owner-only, by rename —
as one description keyed by tool name with the draft id that proposed it. `buildTrentTools` reads
that file at registration and replaces **one line**: the description in the tool's instruction
block. Never the schema, never the handler. The adapter is served through a proxy over the
shipped one, so `execute` is the shipped function and every wrapper — autonomy, the hardline
blocklist, `approvals.deny`, the approval floors, the policy rules, idempotency, the user hooks,
provenance and disclosure — is the same chain in the same order. An improvement may change what
the model is told a tool does; it may not change what the tool does.

`trent improve rollback <iterationId>` takes the override back off and the shipped description is
what the next build serves.

**The limit, recorded.** The rewrite matches the block shape `renderToolInstructions` emits
(`"<name>: <description>"` as a block's first line), which is the same shape the disclosure layer
parses. An adapter that hand-writes its instruction prose instead — `file_ops` is one — has no
such line, so an override for its tools is reported as applied to nothing rather than guessed at.

### What a human sees

```
trent improve tools            calls, failure / invalid-argument / re-call rates and mean args size
                               per tool, which are over the threshold, the drafts waiting on a
                               decision, and "description from improvement <draftId>" for each
                               description the seats are reading from the loop rather than the code
trent improve tools --json     the same, machine-readable; --tool <name> narrows to one
```

The thresholds ship as constants in `improve/tool-health.ts` (`DEFAULT_TOOL_HEALTH_THRESHOLD`,
`DEFAULT_TOOL_HEALTH_MIN_CALLS`) and are overridable per sweep through `SweepDeps.toolHealth`.
They are deliberately **not** config keys yet: nothing that builds a sweep would read them, and a
config key nothing reads is the defect this repository already records twice.

## [W3] Retrieval goldens and the recall gate

Every later change to ingestion, chunking, ranking or reranking has a number: **recall@8 over the
profile's promoted retrieval goldens**, measured by the shipped ranker, deterministic, and gated in
this loop (harness upgrade audit, section 4 item 3; design decision E). There is deliberately no
LLM judge on this path: ids in, ids out, a number (audit section 5).

### What a retrieval golden is

A query and the chunk ids that answer it. It lives under `<profile>/goldens/retrieval/`, so the
frozen surface (gate 1, class `golden`) covers it with the failure goldens, and it carries a
`source`:

| source | how it arrives |
|---|---|
| `founder` | `trent improve goldens add --retrieval --query "..." --expect <chunk-id>[,<chunk-id>]` |
| `captured` | a run: when a seat calls `brain_read` on a chunk id that its own brain recall had ranked, the fleet-memory hook emits a `recall` note on the run bus (`{query, ranked_ids[], read_id}`, carried as a `step_note`), and the loop captures `{query, expected: [read_id]}` |

A golden may also name a document instead of a chunk (`expected_doc: {slug, page}`), for the case
where the founder knows the contract and the page and not the chunk number. Either way it starts
**quarantined**. `trent improve goldens list` shows it with its source; `promote <id>` and
`reject <id>` are the same human commands as for a failure golden, and only a promoted golden is
counted. The id is content-addressed (`rgold_<hash of query and ids>`), so a seat that reads the
same chunk in ten runs proposes one golden, and a decision already taken on it is never reopened.

### The number

`trent improve retrieval [--json]` runs `recallFromBrain` — the real ranker, over the profile's
brain index, with the embedder the profile configured or the lexical ranker when none is — once
per promoted golden, with no budget cut, and counts a golden as a **hit** when any expected id is
in the top 8. It prints recall@8, the floor, which ranker measured it, and every query with its
rank or, for a miss, what the top 8 held instead. Exit 0 at or over the floor, **exit 1 under it**,
so a CI step or a founder editing the chunker gets a verdict. Quarantined goldens are listed as
not counted; with nothing promoted, or the brain disabled, the number is reported as not measured
rather than as a pass.

```yaml
retrieval:
  min_recall: 0.9      # recall@8 over the promoted retrieval goldens the ranker must reach
```

The floor's default, 0.9, is the trigger design decision E recorded for the deferred reranker and
contextual chunk prefixes: under it retrieval is the problem to work on; over it, it is not.

### The gate

`improve/gate.ts` grades `retrieval_recall` as a deterministic grader, **first** and for free: a
measured breach ends the gate before any model call, the verdict is `blockedBy: "retrieval_recall"`
with the metric as its one failure cluster and the whole report attached (the number, the floor,
the queries the ranker lost and what it returned instead). The draft stays in **quarantine**, not
rejected — it was never measured; the ranker is what is under the floor — and a sweep after the
ranker is fixed decides it, as with a holdout regression. The sweep binds the grader to the
profile's brain and promoted goldens (`improve-retrieval.ts`, `retrievalGateFor`), evaluated once
per sweep; offline it measures the lexical ranker, `--live` adds the configured embedder, so an
offline sweep never calls an embedding endpoint. A profile with no promoted retrieval golden binds
nothing and the loop measures nothing about retrieval, which the sweep does not mistake for a pass.

A draft cannot edit its way past the floor: `fleet-memory/recall.ts`, `hybrid.ts`,
`brain-index.ts` and the whole `fleet-memory/ingest/` pipeline are frozen as class `ranking`
(gate 1). A change to the ranker is a human change, and `trent improve retrieval` is how it is
verified — which is what the audit's failing test asserts: the five fixture queries score
recall@8 = 1.0 with the shipped ranker, and a ranker patched through the evaluator's `rank` seam
to return the reverse order fails the gate with the metric named (`improve/retrieval-gate.test.ts`).

## [P2-13] The docs-corpus suite: the ranker measured on real documents

The promoted retrieval goldens above measure a profile's own brain. The ranker itself is measured
on a fixed exam in the repository: `packages/trent-core/src/improve/docs-corpus.test.ts`, offline
and in the default suite.

**The exam.** Twenty-eight of Trent's own `docs/*.md`, snapshotted byte for byte with a sha256 per
file, and imported through the real importer: 625 chunks. Forty questions:

- 12 exact-term;
- 12 paraphrased (zero shared tokens with the answer);
- 11 multi-hop;
- 5 with no answer in the corpus.

Each answer is a phrase that resolves to chunk ids through the shipped chunker.

**Offline equals live.** CI replays recordings, never the network:

- **`embeddings.json`**: each question's cosine against each chunk.
- **`rerank-scores.json`**: each question's pool and every score the rerank model gave it.

Each live harness asserts its replay reproduces the live ranking question for question:
`docs-corpus.live.test.ts` for the embeddings (about 2 cents, needs 665 embedding requests of the
free tier's 1,000 a day) and `docs-corpus-rerank.live.test.ts` for the rerank (about 8.4 cents).
A recording names its space: a task-typed one (`embeddings-task-types.json`, not yet recorded)
refuses a symmetric call, and a rerank replay refuses a pool it was not recorded on.

**What it enforces.** The measured values, as floors that only a human raises:

| Ranker | Floor |
|---|---|
| Shipped hybrid | recall@8 22/35: every exact term, 5/12 paraphrased, 5/11 multi-hop, 2/5 no-answer abstained |
| Lexical | 12/35 |
| Dense half | 21/35 |
| LLM reranker at its shipped threshold | 20/35, costing 0.21 cents a query |

The suite also asserts the reranker's pool holds 31/35 answers, the ceiling any reranker over it
has. At its default floor (0.9), the retrieval gate reports a measured breach on this exam, and
that breach is the open problem.

**Frozen.** `fleet-memory/lexical.ts` (the TF-IDF, the blend's inputs and the relatedness evidence)
and `fleet-memory/rerank.ts` / `rerank-llm.ts` (the pool, the picks and the prompt) joined
`recall.ts`, `hybrid.ts`, `brain-index.ts` and `ingest/` in the frozen `ranking` class (gate 1), so a
draft cannot rewrite the ranker this exam grades.

## What is deliberately not here

- **Automatic promotion.** Promotion is a human command and stays one (`improve/lifecycle.ts`),
  for a draft (`trent improve promote`) and for a golden (`trent improve goldens promote`).
- **Authored suites.** No agent and no founder writes a fixture: a suite grows only from a failure
  a real run produced (plan decision 4). The one exception is deliberate and narrow: a founder may
  name a chunk that answers a question (`goldens add --retrieval`), because a retrieval golden
  grades the ranker and not a seat, and it still enters the set only through `goldens promote`.
- **An independent judge.** The judge is a different model on the same key and the same family
  until a second provider key exists (decision 6, above).
