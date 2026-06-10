# Cursor Prompt Pack — Goal Loop, Client Skills, Client MCP, Self-Improvement, RUN CYCLE Fixes

> Coverage map vs cursor-trent-next-level-master-plan.md:
> §1 orchestration fixes → Prompts 12–16 · §2 goal loop → Prompts 1–7 + 11 ·
> §3 skills/MCP/self-improvement → Prompts 8–10.
> Suggested global order: 1–7 → 12–13 → 8 → 9 → 14–16 → 11 → 10.

> Feed these to Cursor **one at a time, in order, each in a FRESH chat**. Do not paste two
> at once. After each prompt: review the diff, confirm the verification commands are green,
> commit, then start the next. Reference designs: `docs/goal-loop-design.md`,
> `docs/orchestration-improvement-plan.md`, `platform-competitor-playbook.md`.
>
> Every prompt assumes repo rules: TDD first; `makeId("prefix")` / `nowIso()`; files <500
> lines; tenant API routes use auth → RBAC → rate limit → `withRlsContext`; never commit
> secrets; run `npx tsc --noEmit --incremental false` before declaring done.

---

## Prompt 1 — Goal entity + store (Slice 1a)

Read docs/goal-loop-design.md §2.1 and §3 Slice 1. Add a `Goal` model to
prisma/schema.prisma: id, companyId, objective, criteria (Json — array of {id, text,
status: "unmet"|"met"|"blocked", evidenceArtifactIds: string[]}), constraints (Json),
status enum string ("intake"|"active"|"round_running"|"awaiting_review"|"completed"|"stopped"),
rounds (Json array), progressLog (Json array), createdAt/updatedAt. Push the schema to BOTH
dev and test Postgres per docs/RUN.md. Write failing vitest tests first in
lib/goals.test.ts for a new lib/goals.ts store layer: createGoal, getGoal, listGoals(companyId),
updateGoalCriteria (only flips a criterion to "met" when evidenceArtifactIds is non-empty —
test that it throws otherwise), appendGoalProgress, setGoalStatus. Use the prisma-store
patterns from lib/prisma-store-base.ts. Touch ONLY: prisma/schema.prisma, lib/goals.ts,
lib/goals.test.ts, lib/types.ts (Goal types).
Verify: `npx vitest run lib/goals.test.ts` and `npx tsc --noEmit --incremental false`.
Commit: `feat(goals): Goal entity with evidence-gated criteria ledger`

## Prompt 2 — Goal intake + API route (Slice 1b)

Read docs/goal-loop-design.md §2.2 INTAKE. Create lib/goal-intake.ts: `intakeGoal(company,
rawGoalText)` calls the CEO agent runtime (getAgentRuntime(companyId, "ceo") +
callJson from lib/ai-client) to produce {objective, successCriteria[], budgetEstimateCents},
Zod-validated; on parse failure retry ONCE with the validation error appended to the prompt
(mirror the repair pattern in lib/workbench-agent-prompts.ts buildRepairFeedback); on second
failure throw — never silently fall back. Create app/api/companies/[id]/goals/route.ts with
GET (list) and POST (raw goal text → intake → createGoal with status "intake"); follow the
auth/RBAC/rate-limit/withRlsContext pattern from app/api/companies/[id]/cycles/route.ts
exactly. Tests first: intake parse-retry behavior (mock the model), route auth rejection.
Touch ONLY: lib/goal-intake.ts + test, app/api/companies/[id]/goals/route.ts + test.
Verify: `npx vitest run lib/goal-intake.test.ts app/api/companies/[id]/goals/route.test.ts`
and tsc.
Commit: `feat(goals): CEO goal intake with retry-on-parse + tenant goals API`

## Prompt 3 — Round runner (Slice 2a)

Read docs/goal-loop-design.md §3 Slice 2. Create lib/goal-rounds.ts: `runGoalRound(goalId)`
loads the Goal, builds a planning context bundle that lists UNMET criteria first, the last
round's summary from progressLog, and (if available) recallRelevantMemory from
lib/orchestrator. It then calls launchOrchestration (lib/orchestrator.ts) with the
objective composed from the unmet criteria, threading goalId + roundN onto the run (extend
the OrchestrationRun type and launchOrchestration opts minimally — additive only, do not
break existing callers/tests). Flip goal status to "round_running"; append a progressLog
entry. Tests first with a mocked launchOrchestration: context bundle puts unmet criteria
first; goalId threads through; status flips. Touch ONLY: lib/goal-rounds.ts + test, minimal
additive edits to lib/orchestrator.ts / lib/orchestrator-runtime.ts types.
Verify: `npx vitest run lib/goal-rounds.test.ts lib/orchestrator-runtime.test.ts
lib/orchestrator-durable-run.test.ts` and tsc — existing orchestrator tests MUST stay green.
Commit: `feat(goals): round runner threads goals through the durable orchestrator`

## Prompt 4 — CEO goal review in consolidation (Slice 2b)

Read docs/goal-loop-design.md §2.2 CEO GOAL REVIEW. Create lib/goal-review.ts:
`reviewGoalProgress(run, goal)` — model call that maps the run's accepted step outputs to
criteria and returns {criteriaUpdates: [{id, status, evidenceArtifactIds}], roundSummary,
nextRoundTasks: [{title, seat, rationale, targetsCriterionId}] | null (null = goal complete)},
Zod-validated with the same retry-once pattern. In lib/orchestrator-run-phases.ts
processConsolidatePhase, when run has a goalId: call reviewGoalProgress instead of the
generic ceoChatResponse follow-up, apply criteria updates via updateGoalCriteria (which
enforces evidence), append the round record, set goal status to "completed" when all
criteria met else "awaiting_review" with nextRoundTasks stored on the goal. Tests first:
criteria only flip with evidence; completion path; awaiting_review path with a proposal.
Touch ONLY: lib/goal-review.ts + test, the goalId branch in lib/orchestrator-run-phases.ts.
Verify: `npx vitest run lib/goal-review.test.ts lib/orchestrator-replan-e2e.test.ts` + tsc.
Commit: `feat(goals): evidence-gated CEO goal review proposes next round`

## Prompt 5 — Artifact-first step outputs (Slice 3)

Read docs/goal-loop-design.md §3 Slice 3. In lib/orchestrator-runtime.ts
executeStepWithRuntime: after a seat completes, validate its final output against the
seat's contract from lib/seat-output-schemas.ts; persist a typed artifact (reuse the
artifact persistence pattern from lib/workbench-verification-artifacts.ts /
store.addWorkbenchArtifact or the company artifact store in lib/artifacts.ts — pick the one
the Artifacts page reads) and record artifactIds on the StepRecord. Contract-invalid output
= failed step with the Zod error as the failure detail (do NOT write prose artifacts).
For engineer steps whose objective matches a build intent, delegate to a workbench session
(runWorkbenchSelfHealingLoop or the messages-route pattern) and attach the session's
artifacts to the step. Tests first: artifact persisted per step; invalid contract fails the
step; engineer delegation attaches workbench artifacts (mock the workbench call).
Touch ONLY: lib/orchestrator-runtime.ts, lib/seat-output-schemas.ts (additive),
tests.
Verify: `npx vitest run lib/orchestrator-runtime.test.ts lib/seat-output-schemas.test.ts`
+ tsc.
Commit: `feat(orchestrator): typed artifact-first step outputs; engineer steps build in workbench`

## Prompt 6 — Evidence-based critic (Slice 4)

Read docs/goal-loop-design.md §3 Slice 4. Extend critiqueStepOutput (in
lib/orchestrator-runtime.ts) with an evidence parameter: artifact bodies (capped),
workbench verification verdict + screenshot refs for build steps, source links for analyst
steps. The critic prompt must require citing evidence for its verdict. For steps with a
workbench verification verdict, derive the critic result from that verdict directly instead
of a second model call (cheaper + observation-based). Keep verdict semantics
(pass/retry/replan/escalate) unchanged so handleStepCritique keeps working. Tests first.
Touch ONLY: the critique path in lib/orchestrator-runtime.ts + tests.
Verify: `npx vitest run lib/orchestrator-runtime.test.ts lib/orchestrator-mid-loop-approval.test.ts` + tsc.
Commit: `feat(orchestrator): critic judges artifacts with evidence, not prose claims`

## Prompt 7 — Goal cockpit in Command (Slice 5)

Read docs/goal-loop-design.md §3 Slice 5. In components/command-client.tsx (and a new
components/goal-cockpit.tsx kept under 500 lines): a goal composer (textarea → POST
/api/companies/{id}/goals), criteria checklist with met/unmet status and evidence artifact
links, rounds timeline, and when goal status is "awaiting_review" a next-round proposal
card with Approve (calls a new POST /api/companies/[id]/goals/[goalId]/rounds route that
invokes runGoalRound) / Stop buttons. Reuse house styles from command-client-parts.tsx and
the evidence-rail artifact link patterns. Follow existing SSE wiring for live run events.
Tests: route tests for the rounds endpoint (auth + status transitions).
Touch ONLY: components/goal-cockpit.tsx, minimal mount point in command-client.tsx,
app/api/companies/[id]/goals/[goalId]/rounds/route.ts + test.
Verify: route vitest + tsc + `npm run build`.
Commit: `feat(command): goal cockpit — criteria, rounds, approve-next-round gate`

## Prompt 8 — Client-authored skills (instruction-only)

Custom per-company skills, no client code execution. Prisma model CompanySkill {id,
companyId, name, instructions (text), enabled, createdBy, timestamps} (push to both DBs).
Store methods + tenant CRUD route app/api/companies/[id]/skills/route.ts (standard
auth/RBAC/rate-limit/RLS chain; member role to write). Inject enabled company skills into
seat prompts through the existing prelude: extend buildCompanySkillPrelude /
loadGrantedSkillInstructions in lib/agent-skill-instructions.ts to merge CompanySkill rows
(cap total injected length; truncate oldest first). Settings UI: a simple skills editor
section (name + instructions + enabled toggle) following SettingsPageClient patterns in
components/sub-pages.tsx. Tests first: injection merge + cap; route auth; disabled skills
excluded.
Verify: `npx vitest run lib/agent-skill-instructions.test.ts` (create if missing) + route
test + tsc.
Commit: `feat(skills): client-authored instruction skills injected into seat prompts`

## Prompt 9 — Client MCP servers as tool adapters

Read lib/tools.ts ToolAdapter and lib/external-action-guardrails.ts first. Add
@modelcontextprotocol/sdk. Prisma model McpServer {id, companyId, name, url, authRef
(credential id — store the secret via the existing credential/integration encryption
pattern in lib/secrets.ts + credential boundary, NEVER plaintext), toolAllowlist (Json),
approvalPolicy ("always_approve"|"reversible_auto"), enabled}. Create
lib/mcp-tool-adapter.ts: connects over streamable HTTP, lists tools, exposes each
allowlisted tool as a ToolAdapter named `mcp_{serverName}_{toolName}`; every invocation
runs through executeExternalActionWithGuardrails and defaults to requires-approval unless
approvalPolicy permits; sanitizeError on all failures; failures feed tool-health-cache.
Tenant CRUD route app/api/companies/[id]/mcp-servers/route.ts (admin role; test-connection
action). Register adapters into the seat tool registry at runtime load (follow how
adapters are assembled in lib/tools.ts / seat-agent-loop). Tests first with a mocked MCP
client: namespacing, allowlist enforcement, approval default, secret never in errors.
Verify: `npx vitest run lib/mcp-tool-adapter.test.ts` + route test + tsc.
Commit: `feat(integrations): client-configured MCP servers as guarded seat tools`

## Prompt 10 — Self-improvement loop (trace → skill draft → eval-gated promotion)

Read lib/skill-foundry.ts and lib/self-improvement/skill-draft-store.prisma.ts (scaffold
exists; SKILL_INJECTION_ENABLED flag already wired in lib/orchestrator-runtime.ts). Build:
(1) lib/self-improvement/trace-reflection.ts — after reviewGoalProgress, mine the run's
routing decisions, critiques, retries, and outcomes into candidate skill drafts (model
call, Zod-validated, retry-once); (2) promotion gate — a draft is promoted to live only
when running the relevant seat eval (lib/seat-evals.ts / lib/runtime-acceptance-evals.ts)
with the draft injected scores >= baseline; store baseline + scores on the draft;
(3) demotion — if a live skill appears in N consecutive failed-critique steps, disable it
and log why; (4) wire promoted skills into the existing injection path and flip
SKILL_INJECTION_ENABLED handling so per-company enablement is a Company setting, not a
global env. Tests first for each: derivation produces drafts from a fixture trace;
promotion blocked when eval regresses; demotion trigger; injection respects company
setting.
Verify: `npx vitest run lib/self-improvement lib/skill-foundry.test.ts` (create as needed)
+ tsc.
Commit: `feat(self-improvement): trace reflection, eval-gated skill promotion, auto-demotion`

---

## Prompt 11 — Goal governance + metrics (Goal Loop Slice 6)

Read docs/goal-loop-design.md §3 Slice 6. (1) Per-goal budget governor: before each round,
check cumulative round costCents against goal.constraints.budgetCentsCap via a new
assertGoalBudget in lib/goal-rounds.ts; breach → goal status "awaiting_review" with a
budget-breach progressLog entry, never silent overrun. (2) Auto-continue: when goal
constraints.approvalsPolicy === "auto_low_risk" AND every proposed next-round task is
reversible (no irreversible classification) AND budget unbreached, launch the next round
without the human gate; log the auto-continue decision to the audit log. (3) Metrics:
record per-goal rounds-to-complete, cost-per-criterion, critic pass rate, and % criteria
met with evidence into the orchestration eval surface (lib/orchestration-eval.ts patterns).
Tests first for all three. Touch ONLY: lib/goal-rounds.ts, lib/goal-review.ts,
lib/orchestration-eval.ts (additive), tests.
Verify: `npx vitest run lib/goal-rounds.test.ts lib/goal-review.test.ts
lib/orchestration-eval.test.ts` + tsc.
Commit: `feat(goals): budget governor, auto-continue policy, goal metrics`

---

# Section B — RUN CYCLE orchestration fixes (master plan §1)

> These fix the engine behind the console RUN CYCLE button. Independent of Prompts 1–11;
> can be interleaved, but keep the one-prompt-per-chat rule. Reference:
> docs/orchestration-improvement-plan.md (P0–P3).

## Prompt 12 — OperatingStateBundle + no silent plan fallback (P0-2, P0-3)

Read docs/orchestration-improvement-plan.md P0-2/P0-3. Create lib/operating-state.ts:
`buildOperatingStateBundle(companyId)` returns a compact, token-capped bundle — open +
stale tasks with age (cap 20), last cycle summary + per-seat outcomes, pending approvals
(cap 10), budget remaining vs recent burn, and recallRelevantMemory results (cap 5).
Each section individually length-capped; total target <2k tokens. In lib/ai.ts
generateOperatingPlan: include the bundle in the planning prompt instead of only
JSON.stringify(company); on schema parse failure retry ONCE with the Zod error appended;
if the retry fails, return the deterministic fallback BUT mark the plan degraded and write
a visible warning into the Cycle summary + audit log (no more silent fallback). Tests
first: bundle caps respected; retry-on-parse; degraded flag surfaces.
Touch ONLY: lib/operating-state.ts + test, lib/ai.ts, lib/cycles.ts (degraded warning),
their tests.
Verify: `npx vitest run lib/operating-state.test.ts lib/cycles.test.ts` + tsc.
Commit: `feat(cycles): operating-state bundle for planning + no silent plan fallback`

## Prompt 13 — Cycle plans emit dependsOn; cycles run on the durable orchestrator (P1-2, P0-1)

Read docs/orchestration-improvement-plan.md P0-1/P1-2 and lib/orchestrator.ts
launchOrchestration / lib/orchestrator-runtime.ts saveCycleForRun. Extend the plan schema
in lib/ai.ts so each task may declare dependsOn (ids of other tasks in the same plan;
validate references). Rework runCompanyCycle in lib/cycles.ts: instead of the sequential
executeStepWithRuntime loop, convert plan tasks into an orchestration plan and submit
through launchOrchestration (threading cycleId); let the DAG pool execute with
concurrency; keep the existing tail (report, episodic memory, CEO briefing) by moving it
into / after the consolidation of that run. Preserve the existing API response shape of
POST /api/companies/[id]/cycles. Existing orchestrator + cycles tests MUST stay green;
update cycles.test.ts to the new flow. Touch ONLY: lib/ai.ts (schema), lib/cycles.ts,
minimal additive changes in lib/orchestrator.ts, tests.
Verify: `npx vitest run lib/cycles.test.ts lib/orchestrator-dag-concurrency.test.ts
lib/orchestrator-durable-run.test.ts` + tsc.
Commit: `feat(cycles): cycles execute as durable DAG runs with task dependencies`

## Prompt 14 — Typed decomposition + structured handoffs (P1-1, P1-3)

Read docs/orchestration-improvement-plan.md P1-1/P1-3 and lib/planner.ts Subtask schema.
(1) Replace the keyword planning in generateOperatingPlan's prompt with instructions to
emit, per task: a specific measurable objective (never "contribution for: X"), seat,
outputContractId from lib/seat-output-schemas.ts, toolGuidance, boundaries, budgetCents,
dependsOn — plus effort-scaling rules in the prompt (trivial → 1 task, standard → 2–4,
complex only when work parallelizes; never a seat without a concrete deliverable). Keep
lib/planner.ts selectPlannerSeats as the zero-key fallback only. (2) Structured handoffs:
in the DAG execution path, dependent steps receive the upstream step's contract-validated
output object (artifact ref + typed summary) instead of the raw output string — replace
the raw-string map from buildCompletedStepOutputs usage in step prompt assembly. Tests
first: plan tasks carry contracts/deps; dependent step prompts contain typed upstream
summaries, not raw prose.
Touch ONLY: lib/ai.ts, lib/orchestrator-runtime.ts (handoff assembly), tests.
Verify: `npx vitest run lib/cycles.test.ts lib/orchestrator-runtime.test.ts
lib/planner.test.ts` + tsc.
Commit: `feat(orchestrator): effort-scaled typed decomposition + contract handoffs`

## Prompt 15 — decideEffort verification in cycle steps (P2-1)

Read docs/orchestration-improvement-plan.md P2-1, lib/planner.ts decideEffort, and
lib/seat-worker.ts SEAT_POLICY. In the step execution path used by cycle runs: classify
each task (complexity/reversibility), apply decideEffort — critic pass for standard+
(reuse critiqueStepOutput), verifier + human approval for irreversible (create the
Approval with preview, pause the step via the existing mid-loop approval machinery).
Engineer tasks with build intent route through the workbench delegation added in Prompt 5
(if Prompt 5 not yet done, implement the delegation here instead and skip it there).
Tests first: standard task gets critic; irreversible task pauses for approval; build task
delegates.
Touch ONLY: lib/orchestrator-runtime.ts, lib/cycles.ts glue, tests.
Verify: `npx vitest run lib/orchestrator-runtime.test.ts
lib/orchestrator-mid-loop-approval.test.ts lib/cycles.test.ts` + tsc.
Commit: `feat(cycles): effort-scaled critic/verifier/approval gates on cycle steps`

## Prompt 16 — Accountability surface + task hygiene (P3-1, P3-2)

Read docs/orchestration-improvement-plan.md P3-1/P3-2. (1) Task hygiene: in cycle
planning, pass open tasks (from the Prompt 12 bundle) and instruct the planner to ADOPT or
CLOSE existing tasks before creating new ones; dedupe created tasks against open ones by
title similarity; age out tasks queued >14 days to an "stale" status with an audit entry.
(2) Accountability UI: per-cycle view in the console rendering the routing decisions and
handoff audit entries (recordRouting/recordHandoff write them already) — why each seat was
chosen, model tier, budget, confidence — plus a simple handoff list. Follow the existing
cycle detail component patterns. Tests: dedupe/adopt logic; stale aging; route test for
the audit feed endpoint if one is added.
Touch ONLY: lib/cycles.ts (hygiene), one console component + its data route, tests.
Verify: targeted vitest + tsc + `npm run build`.
Commit: `feat(console): routing accountability surface + cycle task hygiene`

---

### Operating procedure (every prompt)

1. Fresh Cursor chat. Paste ONE prompt.
2. Let it read the referenced files/design docs before writing code.
3. Demand the failing test first if it jumps to implementation.
4. Run the verification commands yourself before accepting.
5. Review the diff (especially schema + route auth chains). Commit. Push. Deploy with
   `railway up --service trent-web --detach` when a slice is user-visible.
6. If a prompt balloons past ~30 tool steps or starts touching unlisted files, stop it,
   reset the chat, and re-paste with the boundary restated.
