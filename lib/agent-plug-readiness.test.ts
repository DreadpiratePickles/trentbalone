import { describe, expect, it } from "vitest";
import { AGENT_CATALOG, AGENT_SLOTS, buildSlotEnvironment } from "@/lib/agent-catalog";
import { buildAgentPlugReadinessReport } from "@/lib/agent-plug-readiness";
import type { AgentRole } from "@/lib/types";

describe("buildAgentPlugReadinessReport", () => {
  it("summarizes catalog skill readiness, eval coverage, and runtime-ready slots", () => {
    const companyId = "co_plug_ready";
    const environments = Object.fromEntries(
      AGENT_SLOTS.map((slot) => [slot.role, buildSlotEnvironment(companyId, slot.role)])
    ) as Record<AgentRole, ReturnType<typeof buildSlotEnvironment>>;

    const report = buildAgentPlugReadinessReport({
      catalog: AGENT_CATALOG,
      slotDefinitions: AGENT_SLOTS,
      environments,
    });

    expect(report.catalog.totalProfiles).toBeGreaterThanOrEqual(160);
    expect(report.catalog.skillReadyProfiles).toBe(report.catalog.totalProfiles);
    expect(report.catalog.verificationReadyProfiles).toBe(report.catalog.totalProfiles);
    expect(report.catalog.evalReadyProfiles).toBeGreaterThan(0);
    expect(report.slots.totalSlots).toBe(9);
    expect(report.slots.runtimeReadySlots).toBe(9);
    expect(report.ready).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("fails closed when a slot environment is missing tools, skills, or output contracts", () => {
    const companyId = "co_plug_gap";
    const environments = Object.fromEntries(
      AGENT_SLOTS.map((slot) => [slot.role, buildSlotEnvironment(companyId, slot.role)])
    ) as Record<AgentRole, ReturnType<typeof buildSlotEnvironment>>;
    environments.engineer = { ...environments.engineer, tools: [], skills: [], outputContract: [] };

    const report = buildAgentPlugReadinessReport({
      catalog: AGENT_CATALOG,
      slotDefinitions: AGENT_SLOTS,
      environments,
    });

    expect(report.ready).toBe(false);
    expect(report.slots.runtimeReadySlots).toBe(8);
    expect(report.issues).toEqual(expect.arrayContaining([
      "engineer slot has no tools",
      "engineer slot has no skills",
      "engineer slot has no output contract",
    ]));
  });
});
