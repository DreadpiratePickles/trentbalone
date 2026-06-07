import type { PlugDefinition } from "@/lib/plug/schema-v2";

export function forkPlug(plug: PlugDefinition, input: { newId: string; ownerCompanyId: string }): PlugDefinition {
  return {
    ...plug,
    id: input.newId,
    slug: `${plug.slug}-fork`,
    capabilityScore: plug.capabilityScore,
    publisher: { id: input.ownerCompanyId, verified: false, ownershipHistory: [{ publisherId: input.ownerCompanyId, changedAt: "2026-05-29T00:00:00.000Z", reviewed: false }] },
    visibility: { scope: "private", companyId: input.ownerCompanyId },
  };
}
