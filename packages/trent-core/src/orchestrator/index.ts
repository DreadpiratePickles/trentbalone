/**
 * Orchestrator wrapper — the single-call abstraction the CLI, TUI and Desktop surfaces need.
 *
 * `apps/web/lib/orchestrator.ts` exposes no `runOrchestration()`. `launchOrchestration()` creates the
 * run row, emits `run_start` and ENQUEUES a plan job; the pipeline then advances one queued job at a
 * time and the CALLER must drain the queue. Only the eval harness
 * (`apps/web/lib/orchestration-eval-integration.ts:126-144`) ever did that, and it is not a library.
 * This module owns the drain loop, subscribes to the in-process event bus, and hands back an
 * async-iterable handle.
 *
 * `apps/web/` is read-only: nothing here modifies it. The model ports are injected through the
 * existing DI seam (`lib/runtime-eval-overrides.ts`), never by mocking modules.
 *
 * What the wrapper adds on top of the raw pipeline (each from the live proof,
 * `04_verification/output/live-agents-and-tools.md` §4):
 *   - config -> env for the model resolver, before the libs load (F2 / D1a, `model-env.ts`);
 *   - a seat guard port that records every seat model call, so a run whose every call failed at the
 *     provider ends `failed` with the provider's message instead of `completed` (F2 / D1b);
 *   - the same port normalises split tool names (`{name:"memory",action:"read"}` -> `memory:read`)
 *     when unambiguous (F3, `tool-names.ts`);
 *   - `run_start` synthesised from the launch result, since the bus emits it before anyone can
 *     subscribe (F5 / D2);
 *   - the drain loop WAITS while the run is parked on an approval and resumes after `approve()` /
 *     `reject()`, instead of closing the handle (D2);
 *   - an explanation on the `*_awaiting_approval` events the fallback planner's keyword gate
 *     produces, so a surface can render it as an answerable gate (F4 / D4);
 *   - the self-improvement loop's bus hook (`deps.improve`, see `../improve/hook.ts`): every event
 *     is handed to it and its writes are awaited before the run settles, so traces and failure
 *     goldens are durable by the time a caller sweeps;
 *   - the planner and the critic reach the CONFIGURED provider: the gateway-backed
 *     `createCompletion` port is installed through the overrides seam by default (finding 1 of the
 *     live proof: `callJson` is OpenAI-only, so on Gemini the plan was canned and the critic
 *     auto-passed). A planner failure with a provider configured fails the run instead of
 *     silently substituting the canned plan (`provider-ports.ts`);
 *   - the consolidator has no seam at all (`callText` takes no options), so the wrapper detects
 *     the literal fallback summary on `consolidate_end` and writes the real brief through the
 *     gateway, replacing it in the snapshot, the store and the emitted events;
 *   - [X5] auto-recovery cycles (`auto-recovery.ts`): a step that failed on a transient provider
 *     or tool error is reset to pending inside its own `step_end`, so the app re-enqueues it;
 *   - [P2-11] a verdict (`verdict.ts`): a run that failed at a provider, or whose drain died, ends
 *     with one `run_failed` frame and a snapshot carrying the failed steps, the spend and the cause.
 */

import { createCompletionPort } from "../model-gateway/completion-port.js";
import { createModelGateway } from "../model-gateway/index.js";
import type { ModelGateway } from "../model-gateway/types.js";
import { IN_MEMORY_DATABASE, applyStandaloneEnv, assertStandaloneEnv } from "../runtime/env.js";
import { EventChannel } from "./event-channel.js";
import { loadLibs, type LaunchedRun, type Libs } from "./libs.js";
import { slugify } from "./drain.js";
import { applyModelEnv, assertRoutableModel } from "./model-env.js";
import { PortShaper, PortTally } from "./provider-ports.js";
import { DEFAULT_MAX_CONCURRENT_RUNS, RunSlots, type ReleaseSlot } from "./run-slots.js";
import { closeRunScope, createContextNoticeBus, openRunScope } from "./run-hooks.js";
import { applyConsolidation, finishRunVerification, type RunVerificationPort } from "./run-verification.js";
import { SeatTally, shapeEvent, type SeatModelFn } from "./seat-guard.js";
import { createRunSpendMeter, createSeatChatPort, type RunSpendMeter } from "./spend-meter.js"; // [P2-8] seats through the gateway, every call metered at list price
import { AutoRecovery, DEFAULT_AUTO_RECOVERY_CYCLES } from "./auto-recovery.js";
import { applyPlannerFailure, applySeatFailureOverride, VerdictBook } from "./verdict.js"; // [P2-11]
import { guardedSeatModel } from "./seat-guard-budget.js";
import { toolInstructions, wireSeatTools } from "./seat-wiring.js";
import { drainRun } from "./drain.js";
import type { FleetMemoryHook } from "../fleet-memory/orchestrator-hook.js";
import type { OrchestratorDelegatePort } from "./delegate-port.js";
import { createHumanHook } from "./human-hook.js";
import { describeResume, hydrateOrThrow, prepareResume } from "./resume.js";
import type { HumanAnswers } from "../tools/human/index.js";
import type { TrentToolAdapter } from "../tools/types.js";
import {
  type OrcEvent,
  type Orchestrator,
  type OrchestratorDeps,
  type OrchestratorResumeOptions,
  type OrchestratorRunHandle,
  type OrchestratorRunOptions,
  type OrchestrationRunSnapshot,
} from "./types.js";

export type * from "./types.js";
export { FALLBACK_PLANNER_APPROVAL_TRIGGERS, FALLBACK_PLAN_REASONING, FALLBACK_RUN_SUMMARY } from "./types.js";
export { buildConsolidationPrompt, isFallbackSummary, WRAPPER_CONSOLIDATED_DETAIL } from "./provider-ports.js";
export { applyModelEnv, assertRoutableModel, modelEnvKeys, resolveSeatModel, seatTierVar } from "./model-env.js";
export { resolveToolName, normaliseSeatTurn } from "./tool-names.js";
export { wireSeatTools, seatEnvironment, toolsetEnvironment, SEAT_ROLES } from "./seat-wiring.js";
export { createOrchestratorDelegatePort, DELEGATE_MAX_CHILDREN, DELEGATE_MAX_DEPTH } from "./delegate-port.js";
export type { OrchestratorDelegatePort, DelegatedChildRunner, DelegatedChildSpec, DelegatedChildOutcome } from "./delegate-port.js";
export { createAppDelegatedChildRunner } from "./delegate-child.js";
export { DEFAULT_MAX_CONCURRENT_RUNS, RunSlots } from "./run-slots.js";
export { createGoalVerificationPort, finishRunVerification, type RunVerificationPort } from "./run-verification.js";
export { describeResume, prepareResume, RESUME_OPERATION, type PreparedResume, type ResumePlan } from "./resume.js";

/**
 * Default drain bound. A 12-step plan (the planner's Zod maximum) costs one plan job, up to 12
 * execute jobs, up to 12 retries, up to 6 delegated steps and one consolidate job; 60 clears that
 * with margin while still guaranteeing termination if a phase worker ever re-enqueues itself.
 */
export const DEFAULT_MAX_JOBS = 60;

/** A bus hook with a flush the run awaits: what `../improve/hook.ts` builds. */
export interface RunBusHook {
  readonly sink: (event: OrcEvent) => void;
  flush(): Promise<void>;
}

/** `OrchestratorDeps` plus the self-improvement hook. Declared here so `types.ts` stays a pure mirror. */
export type OrchestratorDepsWithImprove = OrchestratorDeps & {
  /** Receives every event and is flushed before `result()` resolves. */
  readonly improve?: RunBusHook;
  /**
   * The toolset adapters the seats may use (`buildTrentToolAdapters(config, ...)`). Registered
   * through the app's `registerExternalAdapters` seam and written into every seat's environment
   * before a run launches; their usage text rides into the seat prompt through the seat guard.
   */
  readonly tools?: readonly TrentToolAdapter[];
  /**
   * Fleet memory (`../fleet-memory/`): its `memory` and `fleet_search` adapters join `tools`, every
   * seat call is wrapped so the run's frozen prelude (shared MEMORY.md/USER.md, shared skills
   * index, cross-agent recall) rides in `dynamicPrompt`, and the run boundaries are reported so
   * the next run sees this run's writes.
   */
  readonly fleetMemory?: FleetMemoryHook;
  /**
   * The `delegate_task` binding (`./delegate-port.ts`): the same port object handed to
   * `buildTrentToolAdapters({ delegate })`. Every seat call is wrapped so the port knows which
   * step is delegating, and the run boundaries are reported so a child lands in the right run.
   */
  readonly delegate?: OrchestratorDelegatePort;
  /** Where `answer()` leaves the founder's text for `ask_human`'s replay; defaults to the shared registry `buildTrentTools` uses. */
  readonly humanAnswers?: HumanAnswers;
  /**
   * `runtime.max_concurrent_runs`: how many runs this orchestrator drives at once. A run past the
   * cap waits FIFO for a slot before it is launched, and says so with one `heartbeat` event
   * (`detail: "queued: N ahead ..."`). A run parked on an approval keeps its slot (`./run-slots.ts`).
   */
  readonly maxConcurrentRuns?: number;
  /** [D4] The run-end hook: goal gates before the judge, and `verify_on_stop` (`run-verification.ts`). */
  readonly verification?: RunVerificationPort;
  /** [X5] `agent.auto_recovery_cycles`: re-runs of a step that failed on a transient error; default 1, 0 turns it off. */
  readonly autoRecoveryCycles?: number;
};

// --- Public factory -----------------------------------------------------------------------------

export function createOrchestrator(deps: OrchestratorDepsWithImprove = {}): Orchestrator {
  // Must happen before any apps/web module is imported. Without TRENT_QUEUE_FALLBACK=disabled the
  // inline fallback races this drain loop and every job executes twice, silently.
  applyStandaloneEnv(deps.databaseUrl ?? IN_MEMORY_DATABASE);
  // Same rule for the model resolver: the configured model has to be in the env before the libs load,
  // and its report is READ: a provider nothing can route fails here (exit code 3), it is not
  // silently swapped for another one (harness audit D-7).
  assertRoutableModel(applyModelEnv(deps.model), deps.model?.provider);
  assertStandaloneEnv();

  const defaultMaxJobs = deps.maxJobs ?? DEFAULT_MAX_JOBS;
  const slots = new RunSlots(deps.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS);
  const notices = createContextNoticeBus(deps.fleetMemory); // `context_pressure` -> the naming run's bus

  /** Parked runs waiting for approve()/reject()/cancel(), by run id. */
  const resumers = new Map<string, Set<() => void>>();
  function wake(runId: string): void {
    for (const resume of resumers.get(runId) ?? []) resume();
  }
  function waitForResume(runId: string, signal: AbortSignal | undefined, isInterrupted: () => boolean): Promise<void> {
    if (isInterrupted()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const set = resumers.get(runId) ?? new Set<() => void>();
      resumers.set(runId, set);
      const done = (): void => {
        set.delete(done);
        if (set.size === 0) resumers.delete(runId);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      set.add(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * The gateway the planner, critic and consolidator go through. Built lazily — AFTER the env
   * writes above, because `createModelGateway` imports apps/web and freezes its policy — and once
   * per orchestrator, so every run routes the same way.
   */
  let gatewayPromise: Promise<ModelGateway> | undefined;
  function loadGateway(): Promise<ModelGateway> {
    if (deps.gateway) return Promise.resolve(deps.gateway);
    gatewayPromise ??= createModelGateway();
    return gatewayPromise;
  }

  // ── fleet-memory hook (owned by ../fleet-memory; the only lines here that know about it) ──────
  const allTools: readonly TrentToolAdapter[] = [...(deps.tools ?? []), ...(deps.fleetMemory?.adapters ?? [])];
  const withFleetPrelude = (seat: SeatModelFn): SeatModelFn => (deps.fleetMemory ? deps.fleetMemory.wrapSeatModel(seat) : seat);
  // ── end fleet-memory hook ────────────────────────────────────────────────────────────────────
  // ── delegate-port hook (owned by ./delegate-port.ts) ─────────────────────────────────────────
  const withDelegateCaller = (seat: SeatModelFn): SeatModelFn => (deps.delegate ? deps.delegate.wrapSeatModel(seat) : seat);
  // ── end delegate-port hook ───────────────────────────────────────────────────────────────────
  // ── human hook (owned by ./human-hook.ts): delegated-step tracking and the answer registry for ask_human ──
  const human = createHumanHook(allTools, deps.humanAnswers);
  // ── end human hook ───────────────────────────────────────────────────────────────────────────

  const seatInstructions = toolInstructions(allTools);

  function installPorts(libs: Libs, gateway: ModelGateway, tally: SeatTally, ports: PortTally, recovery: AutoRecovery, emit: (event: OrcEvent) => void, meter: RunSpendMeter): void {
    // [P2-11] Inside the meter: the app keeps only the last provider's error; the attribution keeps the real one.
    const underlying = meter.seatModel(recovery.attributeSeatErrors((deps.executeSeatModelFn as SeatModelFn | undefined) ?? libs.gateway.executeSeatModel));
    const chat = deps.createChatCompletion ? (deps.executeSeatModelFn ? undefined : deps.createChatCompletion) : gateway.configuredProviders().length > 0 ? createSeatChatPort(gateway) : undefined;
    // B2: provider guard inside, spend cap outside; [X5] the recovery wrapper outside both, so a thrown transient error is seen and a budget refusal is not retried.
    const seat = recovery.wrapSeatModel(guardedSeatModel({ underlying, chat, tally, instructions: seatInstructions, emit }));
    libs.overrides.setRuntimeEvalOverrides({
      orchestration: {
        // Default, not test-only: the planner and the critic reach the configured provider.
        createCompletion: deps.createCompletion ?? createCompletionPort(meter.portGateway(gateway), { onCall: (call) => ports.record(call) }),
        executeSeatModelFn: human.wrapSeatModel(withDelegateCaller(withFleetPrelude(seat))),
      },
    });
  }

  async function snapshotOf(libs: Libs, runId: string): Promise<OrchestrationRunSnapshot | undefined> {
    const raw = await libs.orchestrator.getOrchestrationRunSnapshot(runId);
    return raw as OrchestrationRunSnapshot | undefined;
  }

  /** What `run` and `resume` each supply: whose run it is, and how its row and queue come to exist. */
  interface Launch {
    readonly companyId: string;
    readonly objective: string;
    launch(): Promise<{ launched: LaunchedRun; note?: string }>;
  }
  type DriveOptions = Omit<OrchestratorRunOptions, "companyId" | "objective">;

  function drive(prepare: (libs: Libs) => Promise<Launch>, options: DriveOptions): OrchestratorRunHandle {
    const channel = new EventChannel();
    const maxJobs = options.maxJobs ?? defaultMaxJobs;
    const tally = new SeatTally();
    const ports = new PortTally();
    let shaper: PortShaper | undefined;
    let recovery: AutoRecovery | undefined;
    let runId: string | undefined;
    const meter = createRunSpendMeter(() => runId);
    let scope: { companyId: string; objective: string } | undefined;
    let cancelRequested = false;

    const isInterrupted = (): boolean =>
      cancelRequested || options.signal?.aborted === true || shaper?.plannerFailure !== undefined;

    const deliver = (event: OrcEvent): void => {
      deps.traceSink?.(event);
      deps.improve?.sink(event);
      channel.push(event);
    };

    let releaseSlot: ReleaseSlot | undefined;
    const started: Promise<string> = (async () => {
      // The cap is enforced before the run exists: a queued run has no row and no drain loop. The
      // one heartbeat tells the caller why nothing is happening yet. It goes to the handle and the
      // trace sink only: the run has no id, and the bus hooks key their state by run.
      releaseSlot = await slots.acquire((ahead) => {
        const queued: OrcEvent = {
          kind: "heartbeat",
          runId: "",
          at: new Date().toISOString(),
          detail: `queued: ${ahead} ahead; max_concurrent_runs is ${slots.capacity}`,
        };
        deps.traceSink?.(queued);
        channel.push(queued);
      });
      if (isInterrupted()) throw new Error("run cancelled while queued for a slot");
      const libs = await loadLibs();
      const gateway = await loadGateway();
      assertStandaloneEnv();
      const prepared = await prepare(libs);
      scope = { companyId: prepared.companyId, objective: prepared.objective };
      recovery = new AutoRecovery({ cycles: deps.autoRecoveryCycles ?? DEFAULT_AUTO_RECOVERY_CYCLES, tally, persistStep: libs.runPersist.persistStep });
      installPorts(libs, gateway, tally, ports, recovery, (event) => deliver({ ...event, runId: runId ?? event.runId }), meter);
      // The seats' tools exist before the plan is made: registry, router catalog, seat environments.
      await wireSeatTools(libs, prepared.companyId, allTools);
      try {
        const { launched, note } = await prepared.launch();
        runId = launched.id;
        notices.open(launched.id, deliver);
        // The per-run hooks (`run-hooks.ts`): the fleet-memory prelude is built on the first seat
        // call, and the conversation rides along so the hook renders it AFTER that frozen prelude.
        openRunScope([deps.fleetMemory, deps.delegate], launched.id, { ...options, ...scope });
        // The bus emits run_start inside launchOrchestration, before anyone can subscribe. The
        // launch result carries the same fields, so the stream starts with it after all (D2).
        deliver({
          kind: "run_start",
          runId: launched.id,
          at: launched.startedAt,
          run: {
            id: launched.id,
            companyId: prepared.companyId,
            objective: launched.objective,
            status: launched.status as OrchestrationRunSnapshot["status"],
            trigger: launched.trigger as OrchestrationRunSnapshot["trigger"],
          },
        });
        if (note !== undefined) deliver({ kind: "heartbeat", runId: launched.id, at: new Date().toISOString(), detail: note });
        return launched.id;
      } catch (error) {
        libs.overrides.clearRuntimeEvalOverrides();
        throw error;
      }
    })();

    const finished: Promise<OrchestrationRunSnapshot> = (async () => {
      const libs = await loadLibs();
      const gateway = await loadGateway();
      let unsubscribe: (() => void) | undefined;
      // Events are shaped in order; a consolidation in flight holds everything behind it.
      let chain: Promise<void> = Promise.resolve();
      const enqueue = (work: () => Promise<void>): void => {
        chain = chain.then(work, work);
      };
      try {
        const id = await started;
        const { companyId, objective } = scope!;
        const book = new VerdictBook(recovery!, () => libs.orchestrator.getOrchestrationRun(id)); // [P2-11]
        const portShaper = new PortShaper(ports, book.consolidatorGateway(meter.consolidatorGateway(gateway)), {
          objective,
          liveRun: () => libs.orchestrator.getOrchestrationRun(id),
          persistSummary: (summary) => applyConsolidation(libs, id, summary),
        });
        shaper = portShaper;
        // Subscribed before the first job is drained, so no phase event is lost.
        unsubscribe = libs.events.subscribeOrcEvents(id, (raw) => {
          // [X5] Synchronous, inside the app's emit: a failed step is reset before the app schedules what follows it.
          const observed = recovery!.onBusEvent(raw, libs.orchestrator.getOrchestrationRun(id));
          if (observed.work) enqueue(observed.work);
          for (const event of observed.events) {
            enqueue(async () => {
              const withPorts = await portShaper.shape(event);
              if (!withPorts) return;
              const shaped = shapeEvent(withPorts, tally, portShaper.fallbackPlan);
              if (shaped) deliver(book.observe(meter.stamp(shaped)));
            });
          }
        });
        try {
          await drainRun(libs, companyId, id, maxJobs, {
            isInterrupted,
            waitForResume: () => waitForResume(id, options.signal, isInterrupted),
            settle: () => chain,
          });
          await chain;
        } catch (error) {
          // [P2-11] A job or a frame threw: the stream still ends with a verdict, and result() still rejects.
          await chain.catch(() => undefined);
          await book.abandon(libs, id, error, deliver);
          throw error;
        }
        if (portShaper.plannerFailure !== undefined) {
          const { summary, completedAt } = await applyPlannerFailure(libs, id, portShaper.plannerFailure);
          deliver(book.plannerFailed(portShaper.plannerFailedEvent(id, summary, completedAt), portShaper.plannerFailure));
        } else if (portShaper.consolidated !== undefined) {
          await applyConsolidation(libs, id, portShaper.consolidated);
        }
        await applySeatFailureOverride(libs, id, tally);
        await recovery!.finish(libs, id); // [X5] a step that exhausted its cycles fails the run, with every error named
        await book.finish(libs, id, { interrupted: isInterrupted(), deliver }); // [P2-11] written last: the verdict wins
        // [D4] Gates before judgment, then verify_on_stop; a refusal rides the bus as a step_note.
        await finishRunVerification(deps.verification, { runId: id, objective, deliver });
        // The loop's writes are part of the run: a caller that sweeps right after must see them.
        await deps.improve?.flush();
        const snapshot = await snapshotOf(libs, id);
        if (!snapshot) throw new Error(`Orchestration run ${id} vanished before a snapshot could be read`);
        return book.attach(snapshot);
      } finally {
        unsubscribe?.();
        channel.close();
        // The slot goes to the oldest waiter, if any, before this handle's caller can observe the end.
        releaseSlot?.();
        libs.overrides.clearRuntimeEvalOverrides();
        // This run's memory writes become visible to the next run.
        closeRunScope([deps.fleetMemory, deps.delegate, notices], runId);
      }
    })();
    // The handle exposes this through result(); nothing is unhandled if the caller only iterates.
    finished.catch(() => undefined);

    const handle: OrchestratorRunHandle = {
      get runId(): string {
        if (!runId) {
          throw new Error("runId is not available until the run has started; await handle.started");
        }
        return runId;
      },
      started,
      [Symbol.asyncIterator]: () => channel.iterate(),
      result: () => finished,
      cancel: async () => {
        cancelRequested = true;
        // A run that never launched (still queued, or the launch failed) has nothing to cancel.
        const id = await started.catch(() => undefined);
        if (id === undefined) return true;
        const libs = await loadLibs();
        const cancelled = await libs.orchestrator.cancelOrchestration(id);
        wake(id);
        return cancelled;
      },
    };
    return handle;
  }

  function run(options: OrchestratorRunOptions): OrchestratorRunHandle {
    return drive(
      async (libs) => ({
        companyId: options.companyId,
        objective: options.objective,
        launch: async () => ({
          launched: await libs.orchestrator.launchOrchestration({
            companyId: options.companyId,
            objective: options.objective,
            trigger: options.trigger ?? "manual",
            fullTeam: options.fullTeam ?? false,
          }),
        }),
      }),
      options,
    );
  }

  /** D2 (`./resume.ts`): the run's own company and objective, and its queue rebuilt from its rows. */
  function resume(runId: string, options: OrchestratorResumeOptions = {}): OrchestratorRunHandle {
    return drive(
      async (libs) => {
        const run = await hydrateOrThrow(libs, runId);
        return {
          companyId: run.companyId,
          objective: run.objective,
          launch: async () => {
            const prepared = await prepareResume(libs, runId);
            return { launched: prepared.launched, note: describeResume(prepared.plan) };
          },
        };
      },
      options,
    );
  }

  const approve = async (runId: string, stepId: string): Promise<boolean> => {
    const ok = await (await loadLibs()).orchestrator.approveStep(runId, stepId);
    wake(runId);
    return ok;
  };

  return {
    run,
    resume,
    ensureCompany: async (input) => {
      const libs = await loadLibs();
      const slug = (input.slug ?? slugify(input.name)).toLowerCase();
      const existing = (await libs.store.listCompanies()).find((company) => company.slug.toLowerCase() === slug);
      if (existing) return existing.id;
      const created = await libs.store.createCompany({ name: input.name, brief: { vision: input.vision ?? input.name } });
      return created.id;
    },
    snapshot: async (runId) => snapshotOf(await loadLibs(), runId),
    approve,
    reject: async (runId, stepId) => {
      const ok = await (await loadLibs()).orchestrator.rejectStep(runId, stepId);
      wake(runId);
      return ok;
    },
    answer: (runId, stepId, text) => human.answer(runId, stepId, text, approve),
  };
}
