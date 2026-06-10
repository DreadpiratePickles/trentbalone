# Orchestration Improvement Plan — "Run the Company" Loop

Date: 2026-06-10 · Author: Claude (session audit) · Status: proposal

## 1. How it actually works today

There are **three orchestration engines** in the codebase. They do not share an execution path.

### Engine A — the one the console button runs (weakest)

`RUN CYCLE` → `POST /api/companies/{id}/cycles` → `runCompanyCycle()` in `lib/cycles.ts`:

1. `generateOperatingPlan()` (`lib/ai.ts`) makes **one** LLM call whose only context is
   `JSON.stringify(company)`. No open tasks, no last-cycle results, no pending approvals,
   no memory retrieval, no metrics. On any parse failure it **silently** falls back to a
   canned deterministic plan.
2. The 7 cycle phases (`inspect_state`, `identify_opportunities`, …) are **labels stored on
   the Cycle row** — no actual state inspection happens.
3. Tasks execute **strictly sequentially** via `executeStepWithRuntime`, with
   `dependsOn: []` and `needsApproval: false` hardcoded; risk level is derived from
   priority alone. Success = `status !== "failed"` — no critic, no verifier.
4. Good bones at the end: report, episodic-memory write, CEO briefing + suggestions.

### Engine B — the strong one, wired only to the Command page

`/api/companies/{id}/orchestrate` → `lib/orchestrator.ts` ("Devin-class"): durable runs
(BullMQ + persist + cache), **DAG execution with dependsOn and concurrency 4**
(`ORC_MAX_CONCURRENCY`), mid-loop approval pause/resume, escalation **replan**
(`orchestrator-replan.ts`), model policy snapshots, trace replay, SSE streaming.
It executes seats through `seat-agent-loop.ts`: real tool calls with semantic tool routing
(`semantic-router.ts`), external-action guardrails, durable approval resume.

### Engine C — the typed swarm substrate (dormant at the top level)

`lib/planner.ts` + `lib/seat-worker.ts` (Phase 10): Zod contracts for `Subtask`,
`WorkRequest`, `HandoffEvent`, `RoutingDecision`; parallel batching; fan-out depth caps;
spend authorization; confidence gates; per-seat critic policy. **But** `classifyTask` and
`selectPlannerSeats` are regex/keyword tables, seat objectives are template strings
(`"${seat} contribution for: ${prompt}"`), and `seat-worker.ts` is imported by nothing but
its tests. Its contracts *are* reused by `seat-agent-loop` / `orchestrator-delegation` /
`model-gateway`, so the substrate is live as a type system, dormant as a runtime.

**Net effect:** the user-facing "run the company" loop is a single context-starved LLM call
followed by sequential execution, while a parallel-DAG, replanning, approval-aware engine
sits one tab over.

## 2. Research grounding

- Anthropic's multi-agent research system (orchestrator-worker, 90.2% improvement over
  single-agent): the orchestrator must be **taught to delegate** — every subtask needs a
  clear objective, output format, tool guidance, and boundaries; effort must be **scaled to
  complexity** (1 agent for simple tasks, 2–4 for comparisons, 10+ only for genuinely
  parallel research); vague delegation is the #1 failure (duplicate work, gaps).
  https://www.anthropic.com/engineering/multi-agent-research-system
- MAST failure taxonomy (1,600+ annotated traces): **inter-agent misalignment is 36.9% of
  all failures** — agents operating on inconsistent views of shared state. Mitigations:
  validated schemas over natural-language handoffs (Trent already has these in Engine C —
  unused by Engine A), unambiguous resource ownership, verification breakdowns addressed
  by explicit verifier stages. https://www.augmentcode.com/guides/why-multi-agent-llm-systems-fail-and-how-to-fix-them
- Memory engineering for multi-agent systems: retrieval at plan time (not just write at
  cycle end), compaction, and feeding "lessons" forward.
  https://www.oreilly.com/radar/why-multi-agent-systems-need-memory-engineering/
- Context engineering failure modes (overload / distraction / contamination / drift):
  argue for compact, structured operating-state bundles rather than `JSON.stringify(company)`.
  https://www.digitalapplied.com/blog/context-engineering-agent-reliability-playbook-2026

## 3. Recommendations (priority order)

### P0-1 · One engine: route RUN CYCLE through the durable orchestrator

Replace Engine A's sequential loop with Engine B. Concretely: `runCompanyCycle` should
build an orchestration plan (tasks with real `dependsOn`) and submit it through
`enqueueOrchestrationPlanJob`, then persist the Cycle row from the run record
(`saveCycleForRun` already exists). Benefits: parallel independent tasks, mid-loop
approvals instead of hardcoded `needsApproval:false`, replan on failure instead of
fail-the-cycle, one audit/trace surface. Engine A's report/memory/briefing tail can run as
the consolidation phase.

### P0-2 · Real state inspection before planning

Make `inspect_state` a real phase. Build a compact `OperatingStateBundle` for the planner
prompt: open + stale tasks (and their age), last cycle summary + per-seat outcomes,
pending approvals, budget remaining vs. burn, key integration signals, and
`recallRelevantMemory()` results (already exported from `lib/orchestrator.ts`, unused in
cycle planning). Hard-cap each section (token budget per section, not per dump). This is
the single highest-leverage change: today every cycle plans from amnesia, so cycles
re-propose the same work and cannot follow through on multi-cycle arcs.

### P0-3 · Stop silent plan fallbacks

`generateOperatingPlan` swallowing parse failures into a canned plan means the console can
show a "successful" cycle that planned nothing real. Retry once with the validation error
in-context (the workbench repair pattern — it works), then surface a degraded-plan warning
on the Cycle row.

### P1-1 · Model-based decomposition emitting the existing typed contracts

Replace the regex `classifyTask`/`selectPlannerSeats` with a planner-model call that emits
Engine C's `Subtask` schema directly: per-seat objective (specific, not
"contribution for: X"), `outputContractId` from `seat-output-schemas`, tool guidance,
boundaries, and budget. Keep the keyword table as the zero-key fallback. Add Anthropic's
effort-scaling rules to the planner prompt: trivial → 1 seat, standard → 2–4, complex →
full swarm; never spawn a seat without a concrete deliverable.

### P1-2 · Dependencies in the plan schema

Let the plan emit `dependsOn` between tasks (content depends on analyst research; growth
depends on content). Engine B executes DAGs already; Engine A throws that information away.
Sequential-only execution makes cycles slow and forces stale-context handoffs.

### P1-3 · Structured handoffs between dependent steps

`previousOutputs[stepId] = raw string` is the textbook MAST misalignment vector. Dependent
steps should receive the upstream seat's **validated output contract** (artifact ref +
typed summary), not its prose. The schemas exist (`seat-output-schemas.ts`); wire them
through `buildCompletedStepOutputs`.

### P2-1 · Verification stage per decideEffort

`decideEffort()` (Engine C) already maps complexity/reversibility → critic/verifier/human
gate, and `SEAT_POLICY` defines per-seat critic + abstain thresholds — Engine A ignores
both. Apply them in the runtime step: critic pass for standard+ work, verifier for
irreversible, and route engineer build tasks through the **workbench pipeline** (now green
end-to-end) so "build X" tasks get typecheck/build/browser verification instead of a prose
answer claiming success.

### P2-2 · Close the memory loop

Episodic memory is written at cycle end but never read at cycle start (see P0-2). Add:
retrieval into planning, a rolling "company operating summary" compacted across cycles
(drift control), and per-seat lessons (the skill-foundry flag `SKILL_INJECTION_ENABLED`
already scaffolds injection — define the promotion path from episodic memory to distilled
skill).

### P2-3 · Budget realism

`budgetForSeat` is a constants table (20–50¢). Derive subtask budgets from classification ×
remaining company budget, record planned vs. actual per seat (the data already flows
through `recordSessionSpend`/usage), and let the planner see last cycle's variance.

### P3-1 · Surface the accountability trail in the console

`recordRouting`/`recordHandoff` write rich audit entries that the console never shows.
Render per-cycle: why each seat was chosen, model tier, budget, confidence, and the
handoff graph. This is both a debugging surface and the product's differentiation
("a competing product-beating accountability" per the planner's own comments).

### P3-2 · Task hygiene

Cycles create plan tasks blindly each run — with P0-2 the planner sees open tasks, so add
dedupe/adopt semantics: progress or close existing tasks before minting new ones, and age
out stale `queued` tasks.

## 4. Suggested sequencing

1. **Slice 1 (P0-2 + P0-3):** state bundle + retry-on-parse — pure planner-input change,
   no execution-path risk, immediately visible in plan quality.
2. **Slice 2 (P1-2 + P0-1):** plan emits `dependsOn`; cycles submit to the durable
   orchestrator; cycle tail becomes consolidation.
3. **Slice 3 (P1-1 + P1-3):** typed model-based decomposition + contract handoffs.
4. **Slice 4 (P2-x):** verification stage, memory loop, budget realism.
5. **Slice 5 (P3-x):** console accountability surface + task hygiene.

Each slice is independently testable with the existing vitest patterns (Engine B and C
already have strong suites — orchestrator-dag-concurrency, replan-e2e, planner, seat-evals
— extend rather than invent).
