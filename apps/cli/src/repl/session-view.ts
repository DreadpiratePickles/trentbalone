/**
 * What a command sees when it runs, and what the session still owes the user.
 *
 * The engine owns input, the stream and the gates; this module owns the two things a command
 * needs that are neither: the `ReplContext` a command reads (the engine's live budget, approvals
 * and run ids, plus the ports `index.ts` wired) and the notice board that makes sure a line the
 * session owes — a hook that did not run, a session hook that failed — is shown once and not once
 * per turn. Both are pure, so they are asserted without a terminal.
 */

import type { BudgetLedger } from "./budget.js";
import type { ApprovalGate } from "./approvals.js";
import type {
  ContextInspector,
  ContextRunSeats,
  ReplConfig,
  ReplContext,
  ReplEgressStatus,
  ReplFleetPort,
  ReplPersonalityPort,
  ReplSandbox,
  ReplSessionControl,
  ReplSessionsPort,
  ReplSkillsPort,
  ReplStore,
  ReplToolListing,
  ReplTraceStore,
} from "./types.js";
import type { Theme } from "../ui/index.js";

/** The live managers the commands merged out of `apps/cli/src/slash/` read, as one dependency. */
export interface ReplSessionPorts {
  fleet?: ReplFleetPort;
  skills?: ReplSkillsPort;
  personalities?: ReplPersonalityPort;
  sessions?: ReplSessionsPort;
  /** `/exit`: ends this session, or says a run is in flight. */
  session?: ReplSessionControl;
  /** [S3] `/compact`, `/resume` and the rollback note (`solo-commands.ts`). */
  compactSession?: ReplContext["compactSession"];
  parkedRuns?: ReplContext["parkedRuns"];
  onRollback?: ReplContext["onRollback"];
}

/** The half of the context that is configuration and ports, as the engine was constructed with. */
export interface SessionViewDeps {
  theme: Theme;
  config: ReplConfig;
  store: ReplStore;
  companyId: string;
  degraded?: boolean;
  traces?: ReplTraceStore;
  tools?: readonly ReplToolListing[];
  sandbox?: ReplSandbox;
  egress?: ReplEgressStatus;
  contextInspector?: ContextInspector;
  compactions?: () => number;
  ports?: ReplSessionPorts;
}

/** The half that only the running engine knows. */
export interface SessionViewState {
  budget: BudgetLedger;
  approvals: ApprovalGate;
  runIds: readonly string[];
  contextRuns: readonly ContextRunSeats[];
}

const EMPTY_TRACES: ReplTraceStore = { query: async () => [], byRun: async () => [] };

export function buildReplContext(deps: SessionViewDeps, state: SessionViewState): ReplContext {
  return {
    theme: deps.theme,
    config: deps.config,
    store: deps.store,
    companyId: deps.companyId,
    traces: deps.traces ?? EMPTY_TRACES,
    budget: state.budget,
    approvals: state.approvals,
    degraded: deps.degraded ?? false,
    runIds: [...state.runIds],
    tools: deps.tools,
    sandbox: deps.sandbox,
    egress: deps.egress,
    contextInspector: deps.contextInspector,
    contextRuns: state.contextRuns,
    compactions: deps.compactions?.() ?? 0,
    ...deps.ports,
  };
}

/**
 * The notices in `lines` that have not been shown yet, marking them shown. A notice source repeats
 * itself every time it is read — `hookNotices` is a live view of one runner — so the memory of what
 * is already on screen has to live outside it.
 */
export function unseenNotices(lines: readonly string[], shown: Set<string>): string[] {
  const fresh: string[] = [];
  for (const line of lines) {
    if (shown.has(line)) continue;
    shown.add(line);
    fresh.push(line);
  }
  return fresh;
}
