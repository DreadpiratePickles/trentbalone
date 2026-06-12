import type { AgentEnvironmentConfig, AgentRole } from "@/lib/types";
import type { ToolAdapter } from "@/lib/tools";

export type ToolBinding =
  | "adapter_name"
  | "adapter_scope"
  | "internal_action"
  | "mcp_dynamic"
  | "alias"
  | "unavailable_marker";

export type ToolReadiness =
  | "connected"
  | "needs_credentials"
  | "mocked"
  | "unavailable"
  | "internal";

export type SeatToolContract = {
  seat: AgentRole;
  tool: string;
  binding: ToolBinding;
  resolvedAdapter: string | null;
  readiness: ToolReadiness;
  advertised: boolean;
  approvalRequired: boolean;
  writeCapable: boolean;
  notes?: string;
};

export function buildSeatToolContracts(_deps: {
  slotEnvironments: Record<AgentRole, AgentEnvironmentConfig>;
  adapters: ToolAdapter[];
  internalActions: ReadonlySet<string>;
  mcpToolNames: ReadonlySet<string>;
  healthByAdapter: Map<string, ToolReadiness>;
}): SeatToolContract[] {
  return [];
}

export function contractsForSeat(all: SeatToolContract[], seat: AgentRole): SeatToolContract[] {
  return all.filter((contract) => contract.seat === seat);
}

export function orphans(_all: SeatToolContract[]): SeatToolContract[] {
  return [];
}

export function phantoms(all: SeatToolContract[]): SeatToolContract[] {
  return all.filter((contract) => !contract.advertised);
}

export function buildAdvertisedToolSet(contracts: SeatToolContract[], seat: AgentRole): Set<string> {
  return new Set(contractsForSeat(contracts, seat).filter((contract) => contract.advertised).map((contract) => contract.tool));
}
