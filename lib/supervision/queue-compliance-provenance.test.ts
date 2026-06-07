import { describe, expect, it } from "vitest";
import { buildQueuedAction } from "./action-queue";
import { enforceComplianceModes } from "./compliance";
import { createDecisionProvenance } from "./provenance";
import { evaluateQuietHours } from "./quiet-hours";

describe("quiet hours, cooling off, compliance, and provenance", () => {
  it("defers non-emergency actions until quiet hours end", () => {
    const result = evaluateQuietHours({
      now: "2026-05-29T02:15:00.000Z",
      timezone: "UTC",
      quietHours: { startHour: 22, endHour: 7 },
      emergency: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.deferUntil).toBe("2026-05-29T07:00:00.000Z");
  });

  it("adds a cooling-off delay for risky actions", () => {
    const queued = buildQueuedAction({
      action: "github.pr.merge",
      riskClass: "costly",
      requestedAt: "2026-05-29T18:00:00.000Z",
      defaultCoolingOffMinutes: 5,
    });

    expect(queued.status).toBe("cooling_off");
    expect(queued.eligibleAt).toBe("2026-05-29T18:05:00.000Z");
  });

  it("applies compliance controls automatically", () => {
    const controls = enforceComplianceModes(["hipaa", "gdpr_strict", "sox"]);

    expect(controls.requiredApprovals).toContain("phi_external_share");
    expect(controls.requiredApprovals).toContain("financial_record_change");
    expect(controls.requiredRedactions).toContain("personal_data");
    expect(controls.auditRetentionYears).toBeGreaterThanOrEqual(7);
  });

  it("creates provenance for every memory write", () => {
    const provenance = createDecisionProvenance({
      companyId: "co_1",
      memoryKey: "brand.voice",
      sourceActionId: "act_1",
      sourceSummary: "Approved voice policy update",
      actorId: "user_1",
    });

    expect(provenance.memoryKey).toBe("brand.voice");
    expect(provenance.sourceActionId).toBe("act_1");
    expect(provenance.trace).toContain("act_1");
  });
});
