# The Goal Loop — Command Goal → Tasks → Artifacts → Critic → CEO Review → Next Steps

Date: 2026-06-10 · Status: design for implementation · Companion: `docs/orchestration-improvement-plan.md`, `platform-competitor-playbook.md`

## 0. The one-sentence design

A **Goal** is a persistent object with explicit success criteria; the orchestrator runs
**rounds** against it — each round plans tasks for unmet criteria, agents produce
**typed artifacts** (never prose claims), a critic judges each artifact **with evidence**,
and the CEO maps artifacts to criteria, marks progress, and proposes the next round —
until every criterion is met or the human stops it.

## 1. Why Trent isn't there yet (gap analysis against the live code)

The Command page already drives the strongest engine (`launchOrchestration` →
plan → DAG pool → `critiqueStepOutput` per step → `processConsolidatePhase`). Five gaps
separate it from the a competing product/a competing platform bar:

1. **Runs are one-shot.** A run completes, emits a markdown report and loose CEO
   "suggestions", and forgets. There is no goal that persists, no criteria ledger, no
   round 2 informed by round 1. (a competing platform's deepest lesson: *plans and task lists live
   outside the context window* — "the codebase is the memory.")
2. **Outputs are prose.** `StepRecord.output` is a string. The critic judges what the
   agent *says it did*, not what it *made*. `lib/artifacts.ts` and
   `seat-output-schemas.ts` exist but the orchestration path doesn't produce persisted,
   typed artifacts per step.
3. **The critic has no evidence.** a competing platform's verifier subagent interacts with the real
   running app — clicks, screenshots, REPL signals — and reports "what works / what's
   broken" from observation. Trent's workbench has exactly this machinery (browser DOM
   inspection, screenshots, interaction checks — all fixed and green as of this branch)
   but only for workbench sessions, not for orchestration steps.
4. **Delegation isn't effort-scaled or specific.** Anthropic's data: vague subtasks are
   the top failure; spawn 1 agent for simple tasks, 2–4 for standard, the full swarm only
   when work genuinely parallelizes.
5. **Engineer steps don't use the workbench.** A "build X" step returns prose from
   `seat-agent-loop` instead of routing into the verified build pipeline
   (scaffold → build → typecheck → browser verification → screenshot artifacts) that now
   works end-to-end.

## 2. The design

### 2.1 Goal entity (new)

```
Goal {
  id, companyId, objective: string,
  successCriteria: [{ id, text, status: "unmet"|"met"|"blocked", evidenceArtifactIds: string[] }],
  constraints: { budgetCentsCap, deadline?, approvalsPolicy: "gate_each_round"|"auto_low_risk" },
  status: "intake"|"active"|"round_running"|"awaiting_review"|"completed"|"stopped",
  rounds: [{ n, runId, plannedTaskCount, costCents, criteriaDelta, summary }],
  progressLog: append-only [{ at, kind, text, refs }],
}
```

Stored in Prisma; the Goal *is* the external memory (a competing platform principle #5). Every round
reads it; nothing about the goal lives only in a context window.

### 2.2 The loop (states and gates)

```
[Command input]
   └─ INTAKE: CEO model turns the raw goal into objective + measurable success criteria
      + budget estimate. HUMAN GATE #1: founder approves/edits criteria. (a competing platform Plan Mode)
   └─ ROUND N PLAN: planner input = goal + criteria ledger (unmet first) + last round's
      review + artifact index + recallRelevantMemory(). Emits typed tasks with
      dependsOn, per-task outputContractId, tool guidance, boundaries, budget —
      effort-scaled (1 task for trivial gaps; full fan-out only for parallelizable work).
   └─ EXECUTE: existing DAG pool, concurrency 4, mid-loop approvals. Each step MUST
      return an artifact reference satisfying its output contract:
        • engineer "build" steps → workbench session (verified build + screenshot artifacts)
        • content/growth/sales/support → typed document artifacts (draft, brief, campaign,
          reply pack) persisted via the artifact store
        • analyst → research memo artifact with sources
      A step whose output fails its Zod contract = failed step (no prose passes).
   └─ CRITIC (per artifact, evidence-based): inputs = artifact body + verification
      evidence (workbench verdict/screenshots for builds; source links for research;
      rendered preview for content) + the criterion it targets. Verdicts stay
      retry / replan / escalate (already implemented) — but judged on evidence.
   └─ CEO GOAL REVIEW (replaces generic consolidation): map each accepted artifact to
      criteria; flip criteria to met ONLY with evidenceArtifactIds; write criteriaDelta +
      round summary to the progressLog; then either:
        • all criteria met → status: completed, final report
        • gaps remain → propose Round N+1 task list (specific, gap-targeted)
   └─ HUMAN GATE #2: founder sees criteria checklist + artifact gallery + next-round
      proposal → Approve / Edit / Stop. (Optional auto-continue when every proposed task
      is reversible AND budget cap unbreached — "human-on-the-loop, not in-the-loop".)
   └─ loop to ROUND N+1
```

### 2.3 Scope isolation per step (a competing platform's #1 reliability lever)

Each step's context = its subtask contract + the specific upstream artifacts it depends
on (refs resolved to content at injection, capped) + seat manifest. Never the whole goal
history, never sibling outputs it doesn't depend on. Fresh context per step; the round
review compacts everything back into the Goal record.

### 2.4 What the critic sees (worked example)

Step: "content: landing-page hero copy for criterion C2 (signup page live)".
Critic input: the copy artifact + the rendered preview screenshot + C2's text + brand
voice policy. NOT: the agent's self-report. Verdict `retry` regenerates with the critique
appended (already wired); two retries → `replan` (already wired).

## 3. Implementation slices (each independently shippable + testable)

### Slice 1 — Goal entity + intake (schema, API, UI composer)
- Prisma `Goal` model (+ JSON criteria column), `store` methods, `POST/GET
  /api/companies/{id}/goals`, RLS + auth like every tenant route.
- Intake call: CEO runtime prompt → `{ objective, successCriteria[], budgetEstimate }`
  (Zod-validated, retry-once-on-parse like the workbench repair pattern).
- Command UI: goal composer + criteria checklist with Approve/Edit.
- Tests: schema round-trip; intake parse-retry; route auth.

### Slice 2 — Round runner wrapping the existing engine
- `runGoalRound(goalId)`: builds plan input from the Goal (criteria-first context
  bundle), calls `launchOrchestration` with `goalId` + `roundN` threaded through
  `OrchestrationRun`, flips goal status.
- `reviewGoalProgress(run, goal)` replaces the generic CEO follow-up inside
  `processConsolidatePhase` when a run has a goalId: criteria mapping + next-round
  proposal, persisted to the Goal.
- Tests: round lifecycle; criteria only flip with evidence refs; proposal generated on
  partial completion.

### Slice 3 — Artifact-first step outputs
- Extend `executeStepWithRuntime` final-output handling: persist artifact via the
  artifact store typed by `seat-output-schemas`; `StepRecord.artifactIds`.
- Engineer build steps: delegate to a workbench session; the session's verified
  artifacts (files, screenshots, verdict) become the step's artifacts.
- Reject contract-violating outputs (step fails with the Zod error as feedback — the
  syntax-gate pattern applied one level up).
- Tests: artifact persisted per step; contract rejection; workbench delegation.

### Slice 4 — Evidence-based critic
- `critiqueStepOutput` gains an `evidence` argument (artifact body, verification verdict,
  screenshot refs); prompt requires citing evidence in the verdict.
- For build artifacts, reuse the workbench verification verdict directly rather than
  re-judging prose.
- Tests: critic receives evidence; build steps bypass prose-judging.

### Slice 5 — Goal cockpit in Command
- Criteria checklist with evidence links; rounds timeline; artifact gallery (reuse
  workbench evidence-rail patterns); next-round proposal card with Approve/Edit/Stop;
  live SSE (`orchestrate/stream` already streams run events — add goal events).

### Slice 6 — Governance + metrics
- Per-goal budget governor (`assertSpendAvailable` against the goal cap, not just company).
- Auto-continue policy for fully-reversible proposed rounds.
- Metrics into the eval harness (`orchestration-eval`): rounds-to-complete,
  cost-per-criterion, critic pass rate, % criteria met with evidence. These are the
  numbers that prove "world-class" instead of asserting it.

## 4. Quality bar — how we'll know it's a competing product/a competing platform class

- ≥80% of goal rounds produce only contract-valid artifacts (no prose passes).
- Every met criterion has at least one evidence artifact a human can open.
- Engineer build tasks ship through the verified workbench pipeline 100% of the time.
- A 3-round goal costs less than 3× a 1-round goal (context compaction working).
- The founder's only required touches: criteria approval + round gates.

## 5. Research anchors

- Anthropic, "How we built our multi-agent research system" — orchestrator-worker,
  delegation specificity, effort scaling. https://www.anthropic.com/engineering/multi-agent-research-system
- a competing platform, "Enabling Agent 3 to Self-Test at Scale" — verifier subagent with minimal
  shared context, evidence-based reporting, reflection loop economics.
  https://blog.competitor.com/automated-self-testing
- MAST failure taxonomy — inter-agent misalignment (36.9%) fixed by validated schemas +
  explicit verification stages. https://www.augmentcode.com/guides/why-multi-agent-llm-systems-fail-and-how-to-fix-them
- In-repo: `platform-competitor-playbook.md` (the shared blueprint §Part 1) — this design is
  that blueprint applied to the whole company loop, not just code generation.
