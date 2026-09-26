/**
 * [S2] The runner port by agent mode: the one object every surface drives.
 *
 * `fleet` is today's runner: the orchestrator's stream over the planner, the critic, the
 * consolidator and the nine seats, the orchestrator as the approval target. `solo` is one agent
 * with one tool loop (`@trent/core/solo`), built from the SAME graph the headless runtime already
 * holds, so nothing a seat relies on is rebuilt for it:
 *   - the tools: the runtime's gated adapters and the fleet-memory tools, as the orchestrator gets
 *     them, with the surface's hold policy applied (council B8, `solo/hold-policy.ts`);
 *   - the memory: the fleet-memory tier builders as seat `trent`, `solo.md` kept out of the brain
 *     block (`solo/fleet-memory-port.ts`);
 *   - the conversation: the profile session for a REPL session or a gateway thread, the runner its
 *     only writer (A1); an in-process one for an A2A context; a fresh one for a one-off run;
 *   - the spend: the run meter over the one daily ledger (`budget.per_run_cap`, `budget.daily_cap`),
 *     one row per model per run close, seat `trent`, so `trent usage --by seat` shows it;
 *   - the checkpoints: the session's write ledger, one turn per run;
 *   - the frames: every one on the runtime's bus hooks and trace sink (approval cards, traces,
 *     alerts, the failure channel) and on the fleet's audit rows (A12, B4).
 * One runner per conversation behind a router that finds a run's runner by id (A2).
 *
 * Precedence: a launch override (`--solo`, `trent solo`, `trent run --solo`) beats `agent.mode` in
 * config, which beats `fleet`. The override lasts for the launch and writes nothing.
 */
import { SessionManager, type ConfigManager } from "@trent/core";
import { agentMode, type AgentMode } from "@trent/core/config/sections/agent.js";
import { EXIT, TrentError } from "@trent/core/errors/index.js";
import type { FleetMemoryHook } from "@trent/core/fleet-memory/index.js";
import { currentBoundApprovals } from "@trent/core/governance/bound-approvals.js";
import { PolicyDispatcher } from "@trent/core/governance/policy-dispatch.js";
import type { PolicyRule } from "@trent/core/governance/policy-rules.js";
import { createModelGateway } from "@trent/core/model-gateway/index.js";
import { readContextWindow } from "@trent/core/model-gateway/local-probe.js";
import { localModelPolicy } from "@trent/core/model-gateway/local-runtime.js";
import { activeProviderAlias, aliasBaseUrl, isLocalAlias } from "@trent/core/model-gateway/providers.js";
import { SEAT_ROLES, type ConversationMessage, type OrcEvent, type OrchestrationTrigger, type Orchestrator } from "@trent/core/orchestrator/index.js";
import { createSoloAuditSink, type SoloAuditWriter } from "@trent/core/solo/audit.js";
import { soloMemoryFromFleetHook } from "@trent/core/solo/fleet-memory-port.js";
import { applyHoldPolicy, type SoloHoldPolicy } from "@trent/core/solo/hold-policy.js";
import { createRunLedgerMeter } from "@trent/core/solo/meter.js";
import { sessionStoreState } from "@trent/core/solo/park.js";
import { createSoloRouter, type SoloConversation, type SoloFrameSink } from "@trent/core/solo/router.js";
import { createSoloRunner } from "@trent/core/solo/runner.js";
import { memorySoloSession, profileSoloSession, savedSoloParks } from "@trent/core/solo/session-store.js";
import type { SoloGateway, SoloParkedCall } from "@trent/core/solo/types.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { currentToolCallContext } from "@trent/core/governance/tool-call-context.js";
import { INBOUND_SEED_CALL, seedInboundTaint } from "@trent/core/webhooks/taint.js";
import { contextLimits } from "../repl/compact.js";
import type { ToolWiringDeps } from "../repl/tools.js";
import type { ReplConfig } from "../repl/types.js";

export type { AgentMode };
export type { SoloHoldPolicy };

/** The runner a launch runs on: its override when it has one, else `agent.mode`, else `fleet`. */
export function resolveAgentMode(config: { readonly agent?: { readonly mode?: AgentMode } }, override?: AgentMode): AgentMode {
  return override ?? agentMode(config);
}

/** The launch override a command's merged options carry: `--solo`, or nothing. */
export function modeOverride(opts: Readonly<Record<string, unknown>>): AgentMode | undefined {
  return opts.solo === true ? "solo" : undefined;
}

/** One run through the port. The fleet reads trigger, history and surface; solo reads the conversation. */
export interface ModeRunInput {
  readonly objective: string;
  readonly signal?: AbortSignal;
  readonly trigger?: OrchestrationTrigger;
  /** Fleet: the surface's earlier turns. Solo owns its conversation and never reads this. */
  readonly history?: readonly ConversationMessage[];
  readonly surface?: string;
  readonly model?: string;
  /** Solo: a profile session id (the REPL's, a gateway thread's); the runner is its only writer. */
  readonly session?: string;
  /** Solo: an in-process conversation key (an A2A context). */
  readonly conversation?: string;
  /** Solo: what a held call does in this conversation, when it opens (`hold-policy.ts`). */
  readonly holds?: SoloHoldPolicy;
}

/** The runner port. `approve`/`reject`/`answer` make it the REPL's and the gateway's approval target. */
export interface ModeRunner {
  readonly mode: AgentMode;
  /** The banner's line: `fleet · 9 seats` or `solo · <model>`. */
  readonly label: string;
  run(input: ModeRunInput): AsyncIterable<OrcEvent>;
  approve(runId: string, stepId: string): Promise<boolean>;
  reject(runId: string, stepId: string): Promise<boolean>;
  answer(runId: string, stepId: string, text: string): Promise<boolean>;
  /** Solo: continue a run a decision released after its stream ended. Fleet streams continue by themselves. */
  readonly resume?: (runId: string, input?: { readonly signal?: AbortSignal }) => AsyncIterable<OrcEvent>;
  /** Solo: told the run id when a decision lands on a run no reader is streaming (the gateway resumes it). */
  readonly onLateDecision?: (listener: (runId: string) => void) => () => void;
  /** Solo: the conversation a live or parked run belongs to. */
  readonly conversationOf?: (runId: string) => SoloConversation | undefined;
  readonly parked?: () => readonly SoloParkedCall[];
  /** Solo: announce the parked runs whose row was decided elsewhere (`trent approvals approve`); returns their ids. */
  readonly sweep?: () => string[];
}

/** Test seams for solo: a scripted model and a recording audit writer. Absent, the real ones. */
export interface SoloSeams {
  readonly gateway?: SoloGateway;
  readonly audit?: SoloAuditWriter;
  /** The model's window, instead of asking the local runtime (`soloWindowTokens`). */
  readonly windowTokens?: number;
}

/** What `createHeadlessRuntime` adds to its deps for the port. */
export interface ModeRuntimeDeps {
  /** A launch override of `agent.mode` (`--solo`, `trent solo`). */
  readonly mode?: AgentMode;
  /** The whole tool build, replaced (tests: a chain over fake adapters wrapped by the runtime's own policy). */
  readonly buildTools?: ToolWiringDeps["buildTools"];
  /** Solo: the hold policy of a session or conversation run that names none. Default `deny`. */
  readonly holds?: SoloHoldPolicy;
  readonly solo?: SoloSeams;
}

/** What a headless run takes for the port, beside the fleet's own options. */
export interface ModeRunOptions {
  readonly session?: string;
  readonly conversation?: string;
  readonly holds?: SoloHoldPolicy;
}

/** What the headless runtime exposes beside `orchestrator`. */
export interface ModeRuntimeView {
  readonly runner: ModeRunner;
  readonly mode: AgentMode;
  /** H3: the fleet or the solo runner whatever this launch's mode (a webhook route names its own), the other built on first use. */
  runnerFor(mode: AgentMode): ModeRunner;
  /** H3: seeds `runId`'s policy ring with one inbound read, on the dispatcher the runtime's tools are wrapped with. */
  seedInbound(runId: string, source: string): Promise<void>;
}

/** The one policy dispatcher the runtime's tools are wrapped with: the shipped rules and `policy.rules`, as `buildTrentTools` would make it. */
export function runtimePolicy(config: ReplConfig): PolicyDispatcher {
  return new PolicyDispatcher(undefined, (config as { policy?: { rules?: readonly PolicyRule[] } }).policy?.rules ?? []);
}

/**
 * H3: seeds waiting for a SOLO run to open its tool-call context. A solo run's ring is its
 * conversation's (S1.1 B1), bound only once the runner starts driving the run, which is after the
 * first frame the webhook engine seeds on; a seed written then would land in a ring nobody reads. So
 * the seed is also kept here and written by the run's first tool access (`seededOnFirstCall`), inside
 * the run's context, into the ring its calls are judged against. A fleet run's ring is the
 * dispatcher's own per run, so the immediate seed is the one it reads.
 */
interface InboundSeeds {
  add(runId: string): void;
  take(runId: string): boolean;
}

function createInboundSeeds(): InboundSeeds {
  const waiting = new Set<string>();
  return {
    add(runId) {
      if (waiting.size >= 256) waiting.delete(waiting.values().next().value as string);
      waiting.add(runId);
    },
    take: (runId) => waiting.delete(runId),
  };
}

/** The adapters with a waiting seed written before their first gate question, call or dry run in a run. */
function seededOnFirstCall(adapters: readonly TrentToolAdapter[], policy: PolicyDispatcher, seeds: InboundSeeds): TrentToolAdapter[] {
  const flush = (): void => {
    const runId = currentToolCallContext()?.runId;
    if (runId !== undefined && seeds.take(runId)) policy.remember(INBOUND_SEED_CALL);
  };
  return adapters.map(
    (adapter) =>
      new Proxy(adapter, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          const fn = value as (...args: unknown[]) => unknown;
          if (property !== "requiresApproval" && property !== "execute" && property !== "dryRun") return fn.bind(target);
          return (...args: unknown[]) => {
            flush();
            return fn.apply(target, args);
          };
        },
      }),
  );
}

/** The pieces of the headless runtime's graph a runner is built from. */
export interface RunnerParts {
  readonly configManager: ConfigManager;
  readonly config: ReplConfig;
  readonly profileDir: string;
  readonly workspace: string;
  readonly companyId: string;
  /** The runtime's surface: a run that names none is charged to it. */
  readonly surface?: string;
  /** The runtime's model pin (`--model`), sent as every solo request's explicit model. */
  readonly pin?: string;
  readonly orchestrator: Pick<Orchestrator, "approve" | "reject" | "answer">;
  /** The fleet run: the orchestrator's stream as the headless runtime has always started it. */
  readonly fleetRun: (objective: string, options: Omit<ModeRunInput, "objective">) => AsyncIterable<OrcEvent>;
  readonly tools: { readonly adapters: readonly TrentToolAdapter[] };
  readonly fleetMemory: FleetMemoryHook;
  readonly checkpoints?: { beginTurn(): unknown };
  readonly ledger?: { dailyTotalCents(date: Date | string): number };
  readonly sinks?: readonly SoloFrameSink[];
  readonly holds?: SoloHoldPolicy;
  readonly solo?: SoloSeams;
  /** Where a failed audit write is reported, once. */
  readonly log?: (line: string) => void;
  /** H3: the dispatcher the tools are wrapped with (`runtimePolicy`), which a webhook run's seed is written to. */
  readonly policy?: PolicyDispatcher;
}

/** The gateway built on the first solo call: after the orchestrator has written the model env it reads. */
function lazyGateway(): SoloGateway {
  let gateway: ReturnType<typeof createModelGateway> | undefined;
  return { complete: async (request) => (await (gateway ??= createModelGateway())).complete(request) };
}

const positive = (value: number | undefined): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined);

/**
 * The model's context window for solo's in-run budget (S1.1 C2): on a LOCAL provider, the runtime's own
 * figure (L0-2's probe, `models.local.context_tokens` when the server cannot be asked), because a local
 * server cuts an over-long prompt silently. Nothing on a hosted provider: it rejects one out loud.
 */
export async function soloWindowTokens(model: string, env: NodeJS.ProcessEnv = process.env, fetchImpl?: Parameters<typeof readContextWindow>[0]["fetchImpl"]): Promise<number | undefined> {
  const alias = activeProviderAlias(env);
  if (alias === undefined || !isLocalAlias(alias)) return undefined;
  const fallbackTokens = localModelPolicy(alias, env).contextTokens;
  const baseUrl = env.OPENAI_BASE_URL?.trim() || aliasBaseUrl(alias, env);
  const window = await readContextWindow({ alias, baseUrl, model, fallbackTokens, ...(fetchImpl === undefined ? {} : { fetchImpl }) }).catch(() => ({ tokens: fallbackTokens }));
  return window.tokens;
}

/** `agent.solo.max_tool_result_chars` (S1.1 C2); the `agent` block is a passthrough, so it is read here, loosely. */
function soloResultCap(config: ReplConfig): number | undefined {
  const solo = (config as { agent?: { solo?: { max_tool_result_chars?: unknown } } }).agent?.solo;
  return positive(typeof solo?.max_tool_result_chars === "number" ? solo.max_tool_result_chars : undefined);
}

function fleetRunner(parts: RunnerParts): ModeRunner {
  const { orchestrator } = parts;
  return {
    mode: "fleet",
    label: `fleet · ${String(SEAT_ROLES.length)} seats`,
    run: ({ objective, ...options }) => parts.fleetRun(objective, options),
    approve: (runId, stepId) => orchestrator.approve(runId, stepId),
    reject: (runId, stepId) => orchestrator.reject(runId, stepId),
    answer: async (runId, stepId, text) => {
      if (orchestrator.answer === undefined) throw new TrentError({ code: EXIT.CONFIG, operation: "runner.answer", message: "this orchestrator cannot take an answer to ask_human" });
      return orchestrator.answer(runId, stepId, text);
    },
  };
}

function soloRunner(parts: RunnerParts, windowTokens: number | undefined, seeds?: InboundSeeds): ModeRunner {
  const { config, companyId, profileDir } = parts;
  const maxToolResultChars = soloResultCap(config);
  const sessions = new SessionManager(parts.configManager);
  const gateway = parts.solo?.gateway ?? lazyGateway();
  const memory = soloMemoryFromFleetHook({ hook: parts.fleetMemory, companyId, profileDir });
  const audit = createSoloAuditSink({ companyId, ...(parts.solo?.audit === undefined ? {} : { write: parts.solo.audit }), ...(parts.log === undefined ? {} : { onError: parts.log }) });
  const seeding = (adapters: TrentToolAdapter[]): TrentToolAdapter[] => (parts.policy === undefined || seeds === undefined ? adapters : seededOnFirstCall(adapters, parts.policy, seeds));
  const perRunCapCents = positive(config.budget?.per_run_cap);
  const dailyCapCents = positive(config.budget?.daily_cap);
  const router = createSoloRouter({
    ...(parts.holds === undefined ? {} : { holds: parts.holds }),
    sinks: [...(parts.sinks ?? []), audit],
    onDecision: audit.decision,
    // After a restart: the parks an earlier process saved beside this profile's transcripts (S1.1).
    saved: () => savedSoloParks(sessions.getStore()),
    pendingApprovals: () => {
      const bindings = currentBoundApprovals();
      return bindings === undefined ? undefined : new Set(bindings.list().map((row) => row.id));
    },
    create: (conversation) => {
      // The chain's own approval rows travel with the adapters (the tool build `buildTrentTools` installed).
      const bindings = currentBoundApprovals();
      const sessionId = conversation.sessionId;
      return createSoloRunner({
        gateway,
        tools: { adapters: seeding(applyHoldPolicy([...parts.tools.adapters, ...parts.fleetMemory.adapters], conversation.holds, conversation.surface ?? parts.surface)), ...(bindings === undefined ? {} : { bindings }) },
        session: sessionId === undefined ? memorySoloSession() : profileSoloSession(sessions, sessionId),
        // A profile session keeps the runner's taint and parks beside its transcript, so a restart continues them.
        ...(sessionId === undefined ? {} : { sessionId, state: sessionStoreState(sessions.getStore(), sessionId) }),
        memory,
        meter: createRunLedgerMeter({
          surface: conversation.surface ?? parts.surface ?? "unknown",
          companyId,
          ...(perRunCapCents === undefined ? {} : { perRunCapCents }),
          ...(dailyCapCents === undefined || parts.ledger === undefined ? {} : { dailyCapCents, ledger: parts.ledger }),
        }),
        ...(parts.checkpoints === undefined ? {} : { checkpoints: { beginTurn: () => void parts.checkpoints?.beginTurn() } }),
        config: {
          ...(parts.pin === undefined ? {} : { model: parts.pin }),
          ceilingChars: contextLimits(config).ceilingChars,
          ...(maxToolResultChars === undefined ? {} : { maxToolResultChars }),
          ...(windowTokens === undefined ? {} : { contextWindowTokens: windowTokens }),
        },
        profileDir,
        workspace: parts.workspace,
        companyId,
      });
    },
  });
  return {
    mode: "solo",
    label: `solo · ${parts.pin ?? config.model}`,
    run: (input) =>
      router.run({
        objective: input.objective,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.session === undefined ? {} : { session: input.session }),
        ...(input.conversation === undefined ? {} : { conversation: input.conversation }),
        ...(input.holds === undefined ? {} : { holds: input.holds }),
        ...(input.surface === undefined ? {} : { surface: input.surface }),
      }),
    approve: (runId, stepId) => router.approve(runId, stepId),
    reject: (runId, stepId) => router.reject(runId, stepId),
    answer: (runId, stepId, text) => router.answer(runId, stepId, text),
    resume: (runId, input) => router.resume(runId, input),
    onLateDecision: (listener) => router.onLateDecision(listener),
    conversationOf: (runId) => router.conversationOf(runId),
    parked: () => router.parked(),
    sweep: () => router.sweep(),
  };
}

export async function createRunnerForMode(parts: RunnerParts, mode: AgentMode, seeds?: InboundSeeds): Promise<ModeRunner> {
  if (mode !== "solo") return fleetRunner(parts);
  return soloRunner(parts, parts.solo?.windowTokens ?? (await soloWindowTokens(parts.pin ?? parts.config.model)), seeds);
}

/** The window without asking the server: the configured local figure, for a solo runner built on demand. */
function soloWindowFallback(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const alias = activeProviderAlias(env);
  return alias === undefined || !isLocalAlias(alias) ? undefined : localModelPolicy(alias, env).contextTokens;
}

/** The launch's runner, (H3) the other mode's, built on first use from the same graph, and the inbound seed both honour. */
export async function createModeRunners(parts: RunnerParts, mode: AgentMode): Promise<Pick<ModeRuntimeView, "runner" | "runnerFor" | "seedInbound">> {
  const seeds = createInboundSeeds();
  const runner = await createRunnerForMode(parts, mode, seeds);
  let other: ModeRunner | undefined;
  return {
    runner,
    runnerFor: (wanted) => (wanted === mode ? runner : (other ??= wanted === "solo" ? soloRunner(parts, parts.solo?.windowTokens ?? soloWindowFallback(), seeds) : fleetRunner(parts))),
    async seedInbound(runId, source) {
      if (parts.policy === undefined) return;
      seeds.add(runId);
      await seedInboundTaint(parts.policy, runId, source);
    },
  };
}

// [P2-1] the per-run model pin (moved from headless.ts, whose `run` still calls it, to keep that file under 500 lines)
/** The refusal for a run naming a model its runtime was not built on. Names models, never secrets. */
export function pinnedElsewhere(requested: string, pin: string | undefined): TrentError {
  const runsOn = pin === undefined ? "the configured models" : `model ${pin}`;
  return new TrentError({
    code: EXIT.CONFIG,
    operation: "run.model",
    message: `this run asks for model ${requested}, and this runtime runs ${runsOn} for the life of its process; a run on another model needs its own process (trent run --model ${requested}). Nothing was run and no model was called`,
    target: requested,
  });
}
