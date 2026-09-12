import type { PlugDefinition } from "@/lib/plug/schema-v2";

export function isBreakingPlugChange(before: PlugDefinition, after: PlugDefinition) {
  const beforeTools = new Set(before.declaredTools.map((tool) => `${tool.toolId}:${tool.allowedActions.join(",")}`));
  return after.declaredTools.some((tool) => !beforeTools.has(`${tool.toolId}:${tool.allowedActions.join(",")}`));
}

export function pinPlugVersion(plug: PlugDefinition, companyId: string) {
  return { companyId, plugId: plug.id, version: plug.version, pinnedAt: new Date("2026-05-29T00:00:00.000Z").toISOString() };
}
