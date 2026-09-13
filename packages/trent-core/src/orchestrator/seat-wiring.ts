/**
 * Seat wiring: makes `config.toolsets` real for the seats.
 *
 * Three things, in order (build spec §"Seat wiring"):
 *   1. the toolset adapters enter the live registry through `registerExternalAdapters`, which also
 *      drops the semantic router's catalog so the next `routeToolsForStep` sees them;
 *   2. every slot role's environment for the company is upserted with the adapter names AND scopes
 *      (`resolveAdapter` matches either) plus the approval floors, so `getAgentRuntime` — which takes
 *      `assignment.environment` over the template — advertises them and the capability gate leaves
 *      `tools` intact;
 *   3. the adapters' usage text is collected for the seat guard to inject into the prompt.
 */
import type { TrentToolAdapter } from "../tools/types.js";
import type { Libs, SeatEnvironment } from "./libs.js";

/** The nine slot roles the planner assigns steps to (`seat-agent-loop.ts` AGENT_ROLES). */
export const SEAT_ROLES = ["ceo", "engineer", "growth", "content", "support", "analyst", "finance", "escalation", "sales"] as const;

/** Gates the seat contract layer reads (`gateMatchesTool` compares on the provider prefix). */
export const TOOLSET_APPROVAL_GATES: Readonly<Record<string, string>> = {
  file_ops: "file_ops.write",
  terminal: "terminal.dangerous",
  web: "web.egress",
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** What the seat's environment must carry for a set of adapters. */
export function toolsetEnvironment(base: SeatEnvironment, adapters: readonly TrentToolAdapter[]): Pick<SeatEnvironment, "tools" | "approvalRequiredFor"> {
  const tools = unique([...base.tools, ...adapters.flatMap((adapter) => [adapter.name, ...adapter.scopes])]);
  const gates = adapters.map((adapter) => TOOLSET_APPROVAL_GATES[adapter.name]).filter((gate): gate is string => gate !== undefined);
  return { tools, approvalRequiredFor: unique([...base.approvalRequiredFor, ...gates]) };
}

export function toolInstructions(adapters: readonly TrentToolAdapter[]): ReadonlyMap<string, string> {
  return new Map(adapters.map((adapter) => [adapter.name, adapter.instructions]));
}

/** Registers the adapters (idempotent by name) and upserts every slot role's environment for the company. */
export async function wireSeatTools(libs: Libs, companyId: string, adapters: readonly TrentToolAdapter[]): Promise<void> {
  if (adapters.length === 0) return;
  libs.tools.registerExternalAdapters([...adapters]);
  for (const role of SEAT_ROLES) {
    const existing = await libs.store.getAgentPlugAssignment(companyId, role);
    const base = existing?.environment ?? libs.catalog.buildSlotEnvironment(companyId, role);
    const wanted = toolsetEnvironment(base, adapters);
    const unchanged =
      existing !== null && existing !== undefined &&
      wanted.tools.every((tool) => existing.environment.tools.includes(tool)) &&
      wanted.approvalRequiredFor.every((gate) => existing.environment.approvalRequiredFor.includes(gate));
    if (unchanged) continue;
    await libs.store.upsertAgentPlugAssignment({
      companyId,
      role,
      // An unknown profile id keeps the slot's default prompt, exactly as no assignment does.
      profileId: existing?.profileId ?? `trent-slot:${role}`,
      environment: { ...base, ...wanted },
    });
  }
}
