/**
 * The real `DelegatedChildRunner`: one `[delegated]` child step in the live run, executed through
 * the app's own `executeStepWithRuntime` and persisted with the same `persistStep` /
 * `emitPersistedOrcEvent` calls the execute phase uses (`orchestrator-run-phases.ts`), so the
 * step shows up in the snapshot, the event stream, `fleet_search` (tagged delegated) and the
 * improve loop's traces exactly like a `workRequests` child would.
 *
 * What is deliberately different from the `workRequests` path:
 *   - the child runs NOW, inside the parent's tool call, and its output is returned to the parent;
 *   - no critic pass: the parent reads the result and judges it, as Hermes's `delegate_task` does;
 *   - a child that pauses for tool approval is reported `blocked` to the parent instead of parking
 *     the run, because the parent's tool loop cannot wait on a founder decision mid-call.
 *
 * `apps/web` is not modified; the modules are imported lazily like `libs.ts`, after the env is set.
 */
import { SEAT_ROLES } from "./seat-wiring.js";
import type { DelegatedChildOutcome, DelegatedChildRunner, DelegatedChildSpec } from "./delegate-port.js";
import type { ToolCallRecord } from "../tools/types.js";

/** `StepRecord` (`orchestrator-runtime.ts:327`), the fields this module reads and writes. */
interface ChildStep {
  id: string;
  title: string;
  rationale: string;
  agentRole: string;
  dependsOn: string[];
  expectedOutput: string;
  riskLevel: string;
  needsApproval: boolean;
  status: string;
  output?: string;
  handoff?: unknown;
  startedAt?: string;
  completedAt?: string;
  model?: string;
  tokens?: number;
  costCents?: number;
  toolCalls?: ToolCallRecord[];
}

interface ChildRun {
  id: string;
  companyId: string;
  objective: string;
  cycleId?: string;
  steps: ChildStep[];
}

interface ExecResult {
  output: string;
  handoff: unknown;
  model: string;
  tokens: number;
  costCents: number;
  toolCalls: ToolCallRecord[];
  maxStepsReached?: boolean;
  execution: unknown;
}

interface ChildLibs {
  getOrchestrationRun(runId: string): ChildRun | undefined;
  getCompany(companyId: string): Promise<unknown>;
  saveExecution(execution: unknown): Promise<unknown>;
  capabilityToRole(capability: string): Promise<string | null>;
  executeStepWithRuntime(input: Record<string, unknown>): Promise<ExecResult>;
  isAwaitingApproval(error: unknown): error is { seatLoopState: { pendingToolCall: { name: string } }; toolCalls: ToolCallRecord[] };
  persistStep(run: ChildRun, step: ChildStep): Promise<void>;
  emitPersistedOrcEvent(run: ChildRun, event: { kind: string; runId: string; at: string; step: ChildStep }): Promise<void>;
  buildCompletedOutputs(steps: ChildStep[]): Record<string, string>;
  cacheOrchestrationRun(run: ChildRun): void;
}

async function loadChildLibs(): Promise<ChildLibs> {
  const [orchestratorMod, storeMod, delegationMod, runtimeMod, persistMod, cacheMod] = await Promise.all([
    import("@/lib/orchestrator") as Promise<Pick<ChildLibs, "getOrchestrationRun">>,
    import("@/lib/store") as Promise<{ store: Pick<ChildLibs, "getCompany" | "saveExecution"> }>,
    import("@/lib/orchestrator-delegation") as Promise<Pick<ChildLibs, "capabilityToRole">>,
    import("@/lib/orchestrator-runtime") as unknown as Promise<Pick<ChildLibs, "executeStepWithRuntime"> & { SeatLoopAwaitingApprovalError: new (...args: never[]) => unknown }>,
    import("@/lib/orchestrator-run-persist") as unknown as Promise<Pick<ChildLibs, "persistStep" | "emitPersistedOrcEvent" | "buildCompletedOutputs">>,
    import("@/lib/orchestrator-cache") as unknown as Promise<Pick<ChildLibs, "cacheOrchestrationRun">>,
  ]);
  return {
    getOrchestrationRun: (runId) => orchestratorMod.getOrchestrationRun(runId),
    getCompany: (companyId) => storeMod.store.getCompany(companyId),
    saveExecution: (execution) => storeMod.store.saveExecution(execution),
    capabilityToRole: (capability) => delegationMod.capabilityToRole(capability),
    executeStepWithRuntime: (input) => runtimeMod.executeStepWithRuntime(input),
    isAwaitingApproval: (error): error is { seatLoopState: { pendingToolCall: { name: string } }; toolCalls: ToolCallRecord[] } =>
      error instanceof runtimeMod.SeatLoopAwaitingApprovalError,
    persistStep: (run, step) => persistMod.persistStep(run, step),
    emitPersistedOrcEvent: (run, event) => persistMod.emitPersistedOrcEvent(run, event),
    buildCompletedOutputs: (steps) => persistMod.buildCompletedOutputs(steps),
    cacheOrchestrationRun: (run) => cacheMod.cacheOrchestrationRun(run),
  };
}

export const DELEGATED_TITLE_PREFIX = "[delegated]";

function isDelegatedStep(step: { title: string }): boolean {
  return step.title.startsWith(DELEGATED_TITLE_PREFIX);
}

function isSeatRole(value: string | undefined): value is (typeof SEAT_ROLES)[number] {
  return value !== undefined && (SEAT_ROLES as readonly string[]).includes(value);
}

/** A child step in the shape `buildDelegatedStepsForWorkRequests` produces, with the parent's context in the brief. */
function buildChildStep(spec: DelegatedChildSpec, role: string): ChildStep {
  const brief = [`Handle delegated task: ${spec.task}`];
  if (spec.context !== undefined && spec.context.trim() !== "") brief.push(`Context from the ${spec.parentSeat} seat:\n${spec.context.slice(0, 4000)}`);
  return {
    id: spec.stepId,
    title: `${DELEGATED_TITLE_PREFIX} ${spec.task.slice(0, 200)}`,
    rationale: `Requested by ${spec.parentSeat} agent through delegate_task`,
    agentRole: role,
    // Not `dependsOn: [parent]`: the parent is still running, and the pipeline's readiness pass
    // must never re-enqueue this step, which is complete before the parent's tool call returns.
    dependsOn: [],
    expectedOutput: brief.join("\n\n"),
    riskLevel: "medium",
    needsApproval: false,
    status: "pending",
  };
}

async function finish(libs: ChildLibs, run: ChildRun, step: ChildStep, status: string, output: string): Promise<void> {
  step.status = status;
  step.output = output;
  step.completedAt = new Date().toISOString();
  await libs.persistStep(run, step);
  await libs.emitPersistedOrcEvent(run, { kind: "step_output", runId: run.id, at: step.completedAt, step });
  await libs.emitPersistedOrcEvent(run, { kind: "step_end", runId: run.id, at: step.completedAt, step });
  libs.cacheOrchestrationRun(run);
}

export function createAppDelegatedChildRunner(load: () => Promise<ChildLibs> = loadChildLibs): DelegatedChildRunner {
  let libsPromise: Promise<ChildLibs> | undefined;
  const libs = (): Promise<ChildLibs> => (libsPromise ??= load());

  return {
    async delegatedCount(runId) {
      const run = (await libs()).getOrchestrationRun(runId);
      return run === undefined ? 0 : run.steps.filter(isDelegatedStep).length;
    },
    async run(spec): Promise<DelegatedChildOutcome> {
      const app = await libs();
      const run = app.getOrchestrationRun(spec.runId);
      if (run === undefined) throw new Error(`orchestration run ${spec.runId} is not live`);
      const role = isSeatRole(spec.agent) ? spec.agent : await app.capabilityToRole(spec.task);
      if (role === null || role === undefined) {
        return { agent: spec.parentSeat, status: "failed", output: `No seat owns "${spec.task.slice(0, 120)}"; do this part yourself.`, toolCalls: [] };
      }
      if (role === spec.parentSeat) {
        return { agent: role, status: "blocked", output: `Self-delegation to ${role} is blocked; do this part yourself.`, toolCalls: [] };
      }
      const company = await app.getCompany(spec.companyId);
      const step = buildChildStep(spec, role);
      const insertAt = run.steps.findIndex((item) => item.id === spec.parentStepId) + 1;
      run.steps.splice(insertAt > 0 ? insertAt : run.steps.length, 0, step);
      await app.persistStep(run, step);
      await app.emitPersistedOrcEvent(run, { kind: "step_pending", runId: run.id, at: new Date().toISOString(), step });
      step.status = "running";
      step.startedAt = new Date().toISOString();
      await app.persistStep(run, step);
      await app.emitPersistedOrcEvent(run, { kind: "step_start", runId: run.id, at: step.startedAt, step });

      try {
        const exec = await app.executeStepWithRuntime({
          step,
          company,
          previousOutputs: app.buildCompletedOutputs(run.steps),
          previousHandoffs: {},
          ...(run.cycleId === undefined ? {} : { cycleId: run.cycleId }),
          approvalGranted: false,
          objective: run.objective,
        });
        step.handoff = exec.handoff;
        step.model = exec.model;
        step.tokens = exec.tokens;
        step.costCents = exec.costCents;
        step.toolCalls = exec.toolCalls;
        await app.saveExecution(exec.execution).catch(() => undefined);
        const status = exec.maxStepsReached === true ? "failed" : "completed";
        await finish(app, run, step, status, exec.output);
        return { agent: role, status, output: exec.output, toolCalls: exec.toolCalls };
      } catch (error) {
        if (app.isAwaitingApproval(error)) {
          const tool = error.seatLoopState.pendingToolCall.name;
          step.toolCalls = error.toolCalls;
          const output = `The delegated ${role} step stopped: its ${tool} call needs founder approval, and a delegated child cannot wait for one. Do this part yourself.`;
          await finish(app, run, step, "blocked", output);
          return { agent: role, status: "blocked", output, toolCalls: error.toolCalls };
        }
        const message = error instanceof Error ? error.message : String(error);
        await finish(app, run, step, "failed", `Delegated step failed: ${message}`);
        return { agent: role, status: "failed", output: `Delegated step failed: ${message}`, toolCalls: step.toolCalls ?? [] };
      }
    },
  };
}
