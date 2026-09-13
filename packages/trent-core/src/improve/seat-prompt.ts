/**
 * The seat's real prompt, for GEPA reflection and for the gate's baseline run.
 *
 * A seat's base prompt is the app's `agentSystemPrompt(role)`; a specialist's is its catalog
 * `specialistPrompt` layered on the seat it is plugged into (the same composition
 * `lib/agent-runtime.ts` performs). A human-promoted GEPA proposal, when one exists, replaces
 * the base (`readSeatPrompt`). Nothing here is ever written back.
 */

import { getCatalogAgent } from "../agents/index.js";
import type { ImproveStorePort } from "../store/StorePort.js";
import { readSeatPrompt } from "./protected-prompt.js";
import { SEAT_ROLES } from "./trace-writer.js";

export type SeatPromptProvider = (agentId: string) => Promise<string>;

/** The seat role an agent id runs under: itself for a seat, its catalog seat for a specialist. */
export function seatRoleFor(agentId: string, roleHint?: string): string {
  if (SEAT_ROLES.includes(agentId)) return agentId;
  return roleHint ?? "engineer";
}

async function basePrompt(agentId: string, role: string): Promise<string> {
  const { agentSystemPrompt } = await import("@/lib/agents");
  const seat = agentSystemPrompt(role as Parameters<typeof agentSystemPrompt>[0]);
  if (SEAT_ROLES.includes(agentId)) return seat;
  const specialist = getCatalogAgent(agentId)?.specialistPrompt;
  return specialist ? `${seat}\n\n${specialist}` : seat;
}

/**
 * Default provider: the app's seat prompt (plus specialist prompt), overridden by a promoted
 * proposal. `roleFor` supplies the seat a specialist is plugged into, from its traces.
 */
export function defaultSeatPromptProvider(store: ImproveStorePort, companyId: string, roleFor: (agentId: string) => string | undefined): SeatPromptProvider {
  return async (agentId) => {
    const base = await basePrompt(agentId, seatRoleFor(agentId, roleFor(agentId)));
    return readSeatPrompt(store, companyId, agentId, base);
  };
}
