# Orchestrator wrapping contract (Stage 00)

## Headline: the real pipeline runs with NO Postgres and NO Redis.

Two fallbacks in the existing app make this true:
- `store.ts:11-13` — `store = process.env.DATABASE_URL ? prismaStore : memStore`. Unset DATABASE_URL
  gives a pure in-process store; Prisma is never imported.
- `queue.ts:669-674` — `getQueue()` returns null when `REDIS_URL` is unset, and `runFallbackJob`
  executes `processJobData` inline. `TRENT_EVAL_SYNC_QUEUE=1` makes it synchronous.

No `next/*` and no `server-only` anywhere in the orchestrator chain. The only coupling is the
`@/lib/*` path alias.

## Correction to the Implementation Plan
**There is no `runOrchestration()`.** The entry point is `launchOrchestration(opts)`
(orchestrator.ts:265), which enqueues a plan job. The pipeline advances through phase workers, and
the caller must DRAIN the job queue. Our wrapper is what creates the single-call abstraction the
plan assumes.

## Pipeline in call order
1. `launchOrchestration` (orchestrator.ts:265) -> createOrchestratorRun -> emit `run_start` -> enqueue plan job
2. `processOrchestrationStepJob` (orchestrator-run-worker.ts:40) branches on action
3. `processPlanPhase` (run-phases.ts:114) -> `generateOrchestrationPlan` (runtime.ts:612, Zod, 1-12 steps)
4. `enqueueReadyOrchestrationSteps` (run-queue.ts:141) — the DAG scheduler, via
   `selectReadyStepsForEnqueue` (orchestrator.ts:80), bounded by ORC_MAX_CONCURRENCY (default 4)
5. `processExecuteStepPhase` (run-phases.ts:145) -> approval gate -> `executeStepWithRuntime`
   (runtime.ts:1363) -> `critiqueStepOutput` (runtime.ts:969)
6. Retry once (phases.ts:288-317); then replan via `handleStepCritique` (orchestrator.ts:162) or escalate
7. Delegation: `buildDelegatedStepsForWorkRequests` (delegation.ts:59) — caps 8/batch, 6/run, depth 2
8. `processConsolidatePhase` (phases.ts:500) -> `consolidateRun` -> report -> terminal events

## Event stream — exactly what the CLI renders
`orchestrator-events.ts:12-32`. 20 event kinds: run_preflight, run_start, plan_start, plan_end,
step_pending, step_start, step_output, step_critic, step_note, step_end, step_blocked,
step_awaiting_approval, step_approved, consolidate_start, consolidate_end, run_awaiting_approval,
run_done, run_failed, run_cancelled, heartbeat.

Transport is an in-process pub/sub Map on `globalThis.__trentOrcBus` (events.ts:45-47), NOT an
EventEmitter and NOT SSE-native. `subscribeOrcEvents(runId, listener)` returns an unsubscribe fn.
The web SSE route is just a thin adapter over the same bus — so the CLI subscribes identically.
`[Engineer] Reading files...` comes from `step_start` (`e.step.agentRole`, `e.step.title`).

## The DI seam — use this, do not mock modules
`lib/runtime-eval-overrides.ts` exposes `setRuntimeEvalOverrides({ createCompletion, executeSeatModelFn })`.
And `lib/orchestration-eval-integration.ts:29-77` (`runOrchestrationIntegrationSuite`) is
PRODUCTION code that already does what the CLI needs: forces REDIS_URL="", disables the queue
fallback, installs overrides, launches, and drains (drain loop at :126-144). Swap the mock
completion for the real gateway and it is a live CLI run.

## Persistence consequence
memStore is in-memory only, so orchestration works inside ONE CLI invocation with zero setup.
Durable sessions/traces ACROSS invocations still need a store. That is the real reason for a
SQLite adapter — not for running the pipeline.

## Catalog
`CatalogAgent` at agent-catalog.ts:22-59. 164 agents: specialized 41, marketing 30, engineering 29,
design 8, sales 8, testing 8, paid-media 7, project-management 6, spatial-computing 6, support 6,
product 5, finance 5, academic 5. Runtime resolution via `getAgentRuntime(companyId, role)`
(agent-runtime.ts:60); catalog `modelPolicy` is advisory only — real routing is
PLANNER_MODEL/SPECIALIST_MODEL/CRITIC_MODEL (runtime.ts:68-70).

## Degradation with no API key
`isNotConfiguredError` makes the planner fall back to deterministic plans and the critic auto-pass
(runtime.ts:1029). Useful for offline tests; must NOT be mistaken for real output in the REPL.
