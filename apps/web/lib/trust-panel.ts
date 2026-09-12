import type { SeatToolContract, ToolReadiness } from "@/lib/seat-tool-contracts";
import type { ToolCallRecord } from "@/lib/types";
import { detectClaimViolations, type ClaimViolation } from "@/lib/seat-output-claim-guard";

/**
 * Trust panel projection — turns the seat-tool contracts + tool calls + final output
 * into a provenance view the UI can render: every advertised action labelled
 * real / connected / needs_credentials / mock, plus a "no unverified claims" badge
 * sourced from the same anti-false-green guard that gates the runtime.
 */

export type ActionProvenance = "real" | "connected" | "needs_credentials" | "mock" | "unavailable" | "internal";

export type TrustPanelAction = {
  tool: string;
  provenance: ActionProvenance;
  /** Did a matching tool call complete in this run? */
  executed: boolean;
  approvalRequired: boolean;
  writeCapable: boolean;
};

export type TrustPanel = {
  actions: TrustPanelAction[];
  violations: ClaimViolation[];
  /** True when the final prose made no unverified tool claims. */
  noUnverifiedClaims: boolean;
  /** Counts by provenance for a compact header. */
  counts: Record<ActionProvenance, number>;
};

export function provenanceForReadiness(
  readiness: ToolReadiness,
  executed: boolean,
): ActionProvenance {
  switch (readiness) {
    case "connected":
      // Connected + actually executed in this run reads as "real"; connected-but-idle is "connected".
      return executed ? "real" : "connected";
    case "needs_credentials":
      return "needs_credentials";
    case "mocked":
      return "mock";
    case "unavailable":
      return "unavailable";
    case "internal":
      return "internal";
    default:
      return "unavailable";
  }
}

export function buildTrustPanel(input: {
  contracts: SeatToolContract[];
  toolCalls: ToolCallRecord[];
  output: Record<string, unknown> | null;
}): TrustPanel {
  const actions: TrustPanelAction[] = input.contracts
    .filter((contract) => contract.advertised)
    .map((contract) => {
      const executed = input.toolCalls.some(
        (call) =>
          call.status === "completed" &&
          (call.adapter === contract.resolvedAdapter || call.adapter === contract.tool),
      );
      return {
        tool: contract.tool,
        provenance: provenanceForReadiness(contract.readiness, executed),
        executed,
        approvalRequired: contract.approvalRequired,
        writeCapable: contract.writeCapable,
      };
    });

  const violations = detectClaimViolations({
    output: input.output,
    contracts: input.contracts,
    toolCalls: input.toolCalls,
  });

  const counts: Record<ActionProvenance, number> = {
    real: 0, connected: 0, needs_credentials: 0, mock: 0, unavailable: 0, internal: 0,
  };
  for (const action of actions) counts[action.provenance] += 1;

  return {
    actions,
    violations,
    noUnverifiedClaims: violations.length === 0,
    counts,
  };
}
