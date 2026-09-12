import { describe, expect, it } from "vitest";
import { evaluateAutonomyPolicy, type AutonomyDecision, type AutonomyPolicyInput } from "@/lib/autonomy-policy";
import { defaultAutonomySettings } from "@/lib/autonomy-settings";
import type { CompanyAutonomyMode } from "@/lib/types";

/** Type-safe: did this decision require approval? (false for blocked/allowed-clean). */
function needsApproval(d: AutonomyDecision): boolean {
  return d.allowed === true && d.approvalRequired === true;
}

function input(mode: CompanyAutonomyMode, over: Partial<AutonomyPolicyInput> = {}): AutonomyPolicyInput {
  return {
    settings: defaultAutonomySettings(mode),
    toolScope: "growth:email:send",
    readiness: "connected",
    risk: "low",
    reversible: true,
    externalWrite: false,
    ...over,
    ...(over.settings ? { settings: over.settings } : {}),
  };
}

describe("evaluateAutonomyPolicy — universal blocks", () => {
  it("blocks an explicitly block-listed scope in every mode", () => {
    for (const mode of ["manual", "supervised", "autonomous"] as const) {
      const settings = { ...defaultAutonomySettings(mode), blockedToolScopes: ["growth:email"] };
      const d = evaluateAutonomyPolicy(input(mode, { settings, toolScope: "growth:email:send" }));
      expect(d.allowed).toBe(false);
    }
  });

  it("blocks a mock / test-only tool so it can never be reported as done", () => {
    const mock = evaluateAutonomyPolicy(input("autonomous", { readiness: "mock" }));
    expect(mock).toEqual({ allowed: false, reason: expect.stringContaining("cannot produce a real result") });
    const test = evaluateAutonomyPolicy(input("supervised", { readiness: "test_only" }));
    expect(test.allowed).toBe(false);
  });

  it("blocks an unavailable / needs-credentials provider honestly", () => {
    expect(evaluateAutonomyPolicy(input("autonomous", { readiness: "needs_credentials" })).allowed).toBe(false);
    expect(evaluateAutonomyPolicy(input("autonomous", { readiness: "unavailable" })).allowed).toBe(false);
  });
});

describe("evaluateAutonomyPolicy — spend", () => {
  it("requires approval when spend exceeds the daily cap (any mode)", () => {
    const settings = { ...defaultAutonomySettings("autonomous"), dailySpendLimitCents: 100, approvalRequiredForSpend: false, allowlistedToolScopes: ["growth:email:send"] };
    const d = evaluateAutonomyPolicy(input("autonomous", { settings, spendEstimateCents: 150, spentTodayCents: 0 }));
    expect(d).toMatchObject({ allowed: true, approvalRequired: true, approvalKind: "spend" });
  });

  it("requires approval for any spend when approvalRequiredForSpend is set", () => {
    const d = evaluateAutonomyPolicy(input("autonomous", { spendEstimateCents: 50, settings: { ...defaultAutonomySettings("autonomous"), allowlistedToolScopes: ["growth:email:send"] } }));
    expect(d).toMatchObject({ approvalRequired: true, approvalKind: "spend" });
  });
});

describe("evaluateAutonomyPolicy — manual mode", () => {
  it("permits reversible internal research without approval", () => {
    const d = evaluateAutonomyPolicy(input("manual", { externalWrite: false, reversible: true, risk: "low" }));
    expect(d).toEqual({ allowed: true, approvalRequired: false, reason: expect.any(String) });
  });

  it("turns an external write into an approval request", () => {
    const d = evaluateAutonomyPolicy(input("manual", { externalWrite: true }));
    expect(d).toMatchObject({ allowed: true, approvalRequired: true, approvalKind: "external_write" });
  });

  it("gates irreversible / high-risk internal actions", () => {
    expect(needsApproval(evaluateAutonomyPolicy(input("manual", { reversible: false })))).toBe(true);
    expect(needsApproval(evaluateAutonomyPolicy(input("manual", { risk: "high" })))).toBe(true);
  });
});

describe("evaluateAutonomyPolicy — supervised mode (default)", () => {
  it("permits a reversible internal connected tool", () => {
    const d = evaluateAutonomyPolicy(input("supervised", { externalWrite: false, reversible: true, risk: "low" }));
    expect(d).toMatchObject({ allowed: true, approvalRequired: false });
  });

  it("gates external writes and high-risk / irreversible actions", () => {
    expect(needsApproval(evaluateAutonomyPolicy(input("supervised", { externalWrite: true })))).toBe(true);
    expect(needsApproval(evaluateAutonomyPolicy(input("supervised", { risk: "high" })))).toBe(true);
    expect(needsApproval(evaluateAutonomyPolicy(input("supervised", { reversible: false })))).toBe(true);
  });
});

describe("evaluateAutonomyPolicy — autonomous mode", () => {
  it("permits an allowlisted reversible connected tool without approval", () => {
    const settings = { ...defaultAutonomySettings("autonomous"), allowlistedToolScopes: ["growth:social:publish"] };
    const d = evaluateAutonomyPolicy(input("autonomous", { settings, toolScope: "growth:social:publish", externalWrite: true }));
    expect(d).toMatchObject({ allowed: true, approvalRequired: false });
  });

  it("permits a reversible low-risk connected tool without approval", () => {
    const d = evaluateAutonomyPolicy(input("autonomous", { reversible: true, risk: "low", externalWrite: false }));
    expect(d).toMatchObject({ allowed: true, approvalRequired: false });
  });

  it("still gates risky deploy/delete and irreversible actions", () => {
    expect(evaluateAutonomyPolicy(input("autonomous", { toolScope: "engineer:deploy", risk: "high" }))).toMatchObject({ approvalRequired: true, approvalKind: "risk" });
    expect(evaluateAutonomyPolicy(input("autonomous", { reversible: false }))).toMatchObject({ approvalRequired: true });
  });

  it("still gates external writes unless allowlisted", () => {
    expect(evaluateAutonomyPolicy(input("autonomous", { externalWrite: true }))).toMatchObject({ approvalRequired: true, approvalKind: "external_write" });
  });

  it("gates an experimental seat and does NOT auto-upgrade a missing capability label", () => {
    expect(evaluateAutonomyPolicy(input("autonomous", { capabilityLabel: "experimental" }))).toMatchObject({ approvalRequired: true });
    // Missing label: low-risk reversible baseline still allowed, but it is not treated as "proven autonomous".
    const missing = evaluateAutonomyPolicy(input("autonomous", { capabilityLabel: undefined, reversible: true, risk: "low" }));
    expect(missing).toMatchObject({ allowed: true, approvalRequired: false });
  });

  it("requires approval once the per-run auto-run cap is reached", () => {
    const settings = { ...defaultAutonomySettings("autonomous"), maxAutonomousToolCallsPerRun: 2 };
    expect(evaluateAutonomyPolicy(input("autonomous", { settings, autonomousToolCallsSoFar: 2 }))).toMatchObject({ approvalRequired: true, approvalKind: "tool" });
    expect(needsApproval(evaluateAutonomyPolicy(input("autonomous", { settings, autonomousToolCallsSoFar: 1 })))).toBe(false);
  });
});
