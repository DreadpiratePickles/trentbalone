/**
 * lib/orchestrator-autonomy-gate.ts — server-side enforcement of the Autonomy
 * Control Plane at the seat tool-execution boundary.
 *
 * Maps a seat tool contract onto the autonomy policy and returns either "proceed"
 * or a ToolCallRecord that stands in for the tool (needs_approval / blocked) so the
 * EXISTING orchestrator approval + critic machinery handles it — we do not invent a
 * parallel approval path. The policy reason rides in the record summary, which is
 * the run's evidence/audit trail. A pure function: no I/O, fully unit-tested.
 */
import type { SeatToolContract, ToolReadiness } from "@/lib/seat-tool-contracts";
import type { AgentRole, CompanyAutonomySettings, ToolCallRecord } from "@/lib/types";
import {
  evaluateAutonomyPolicy,
  scopeMatches,
  type AutonomyDecision,
  type AutonomyPolicyInput,
  type AutonomyRisk,
  type AutonomyToolReadiness,
} from "@/lib/autonomy-policy";

export type AutonomyGateContext = {
  settings: CompanyAutonomySettings;
  seat: AgentRole;
  contract: Pick<SeatToolContract, "tool" | "resolvedAdapter" | "readiness" | "writeCapable">;
  /** Step risk if known; defaults from write-capability when absent. */
  risk?: AutonomyRisk;
  runContext?: "scheduled" | "manual" | "debug";
  spendEstimateCents?: number;
  spentTodayCents?: number;
  autonomousToolCallsSoFar?: number;
  capabilityLabel?: "experimental" | "supervised" | "autonomous";
};

export type AutonomyGateResult =
  | { proceed: true; decision: AutonomyDecision }
  | { proceed: false; record: ToolCallRecord; decision: AutonomyDecision };

export function readinessToPolicy(readiness: ToolReadiness): AutonomyToolReadiness {
  switch (readiness) {
    case "connected": return "connected";
    case "internal": return "internal";
    case "mocked": return "mock";
    case "needs_credentials": return "needs_credentials";
    case "unavailable": return "unavailable";
    default: return "unavailable";
  }
}

export function buildPolicyInput(ctx: AutonomyGateContext): AutonomyPolicyInput {
  const writeCapable = ctx.contract.writeCapable;
  const scope = `${ctx.seat}:${ctx.contract.tool}`.toLowerCase();
  return {
    settings: ctx.settings,
    toolScope: scope,
    readiness: readinessToPolicy(ctx.contract.readiness),
    // Heuristic when no explicit risk is supplied: write-capable external actions
    // are medium risk and not reversible; reads/internal are low risk and reversible.
    risk: ctx.risk ?? (writeCapable ? "medium" : "low"),
    reversible: ctx.risk ? !writeCapable : !writeCapable,
    externalWrite: writeCapable,
    capabilityLabel: ctx.capabilityLabel,
    runContext: ctx.runContext,
    spendEstimateCents: ctx.spendEstimateCents,
    spentTodayCents: ctx.spentTodayCents,
    autonomousToolCallsSoFar: ctx.autonomousToolCallsSoFar,
  };
}

/**
 * Pure gate decision. Returns proceed=true to let the tool run, or a substitute
 * ToolCallRecord (needs_approval / blocked) carrying the policy reason.
 */
export function evaluateAutonomyGate(ctx: AutonomyGateContext, action: string): AutonomyGateResult {
  const decision = evaluateAutonomyPolicy(buildPolicyInput(ctx));
  const adapter = ctx.contract.resolvedAdapter ?? ctx.contract.tool;

  if (decision.allowed && !decision.approvalRequired) {
    return { proceed: true, decision };
  }
  if (decision.allowed && decision.approvalRequired) {
    return {
      proceed: false,
      decision,
      record: {
        adapter,
        action,
        status: "needs_approval",
        summary: `[autonomy:${ctx.settings.mode}] approval required (${decision.approvalKind}) — ${decision.reason}`,
      },
    };
  }

  // decision.allowed === false. At the live boundary we only HARD-block an
  // explicit founder block-list entry. Readiness blocks (mock / needs_credentials
  // / unavailable) are deferred to the existing contract + adapter layer, which
  // already reports those honestly (mocked status / needs-credentials failure) —
  // re-blocking here would preempt the established mid-loop approval + honesty
  // path. The policy still encodes those rules (unit-tested) for non-boundary use.
  const scope = `${ctx.seat}:${ctx.contract.tool}`.toLowerCase();
  if (scopeMatches(scope, ctx.settings.blockedToolScopes)) {
    return {
      proceed: false,
      decision,
      record: {
        adapter,
        action,
        status: "blocked",
        summary: `[autonomy:${ctx.settings.mode}] blocked — ${decision.reason}`,
      },
    };
  }
  return { proceed: true, decision };
}
