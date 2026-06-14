import { describe, expect, it } from "vitest";
import { evaluateAutonomyGate, readinessToPolicy, type AutonomyGateContext } from "@/lib/orchestrator-autonomy-gate";
import { defaultAutonomySettings } from "@/lib/autonomy-settings";
import type { CompanyAutonomyMode } from "@/lib/types";

function ctx(mode: CompanyAutonomyMode, contract: Partial<AutonomyGateContext["contract"]> = {}, over: Partial<AutonomyGateContext> = {}): AutonomyGateContext {
  return {
    settings: over.settings ?? defaultAutonomySettings(mode),
    seat: "growth",
    contract: { tool: "Resend", resolvedAdapter: "Resend", readiness: "connected", writeCapable: false, ...contract },
    ...over,
  };
}

describe("readinessToPolicy", () => {
  it("maps contract readiness onto policy readiness", () => {
    expect(readinessToPolicy("mocked")).toBe("mock");
    expect(readinessToPolicy("connected")).toBe("connected");
    expect(readinessToPolicy("needs_credentials")).toBe("needs_credentials");
    expect(readinessToPolicy("internal")).toBe("internal");
  });
});

describe("evaluateAutonomyGate", () => {
  it("manual mode turns a connected external write into a needs_approval record", () => {
    const r = evaluateAutonomyGate(ctx("manual", { writeCapable: true }), "send");
    expect(r.proceed).toBe(false);
    if (!r.proceed) {
      expect(r.record.status).toBe("needs_approval");
      expect(r.record.summary).toContain("autonomy:manual");
      expect(r.record.summary).toContain("approval required");
    }
  });

  it("supervised mode lets a reversible internal read proceed", () => {
    const r = evaluateAutonomyGate(ctx("supervised", { writeCapable: false, readiness: "internal" }), "read");
    expect(r.proceed).toBe(true);
  });

  it("autonomous mode lets an allowlisted external write proceed", () => {
    const settings = { ...defaultAutonomySettings("autonomous"), allowlistedToolScopes: ["growth:resend"] };
    const r = evaluateAutonomyGate(ctx("autonomous", { writeCapable: true }, { settings }), "send");
    expect(r.proceed).toBe(true);
  });

  it("autonomous mode still gates a non-allowlisted external write", () => {
    const r = evaluateAutonomyGate(ctx("autonomous", { writeCapable: true }), "send");
    expect(r.proceed).toBe(false);
    if (!r.proceed) expect(r.record.status).toBe("needs_approval");
  });

  it("defers a mock tool to the existing contract/adapter layer (which reports it honestly), not a hard boundary block", () => {
    // The pure policy blocks mock (see autonomy-policy.test). At the live boundary
    // we defer readiness honesty to the existing layer rather than preempt it.
    const r = evaluateAutonomyGate(ctx("autonomous", { readiness: "mocked" }), "send");
    expect(r.proceed).toBe(true);
    expect(r.decision.allowed).toBe(false);
  });

  it("blocks an explicitly block-listed scope", () => {
    const settings = { ...defaultAutonomySettings("autonomous"), blockedToolScopes: ["growth:resend"] };
    const r = evaluateAutonomyGate(ctx("autonomous", {}, { settings }), "send");
    expect(r.proceed).toBe(false);
    if (!r.proceed) expect(r.record.status).toBe("blocked");
  });

  it("carries the policy decision alongside the record for audit", () => {
    const r = evaluateAutonomyGate(ctx("manual", { writeCapable: true }), "send");
    expect(r.decision.allowed).toBe(true);
    if (r.decision.allowed && r.decision.approvalRequired) expect(r.decision.approvalKind).toBe("external_write");
  });
});
