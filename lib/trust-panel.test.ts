import { describe, expect, it } from "vitest";
import type { SeatToolContract } from "@/lib/seat-tool-contracts";
import type { ToolCallRecord } from "@/lib/types";
import { buildTrustPanel } from "@/lib/trust-panel";

function contract(overrides: Partial<SeatToolContract>): SeatToolContract {
  return {
    seat: "growth",
    tool: "Stripe",
    binding: null,
    resolvedAdapter: "Stripe",
    readiness: "connected",
    advertised: true,
    approvalRequired: false,
    writeCapable: false,
    ...overrides,
  };
}

describe("buildTrustPanel", () => {
  const contracts: SeatToolContract[] = [
    contract({ tool: "Stripe", resolvedAdapter: "Stripe", readiness: "connected" }),
    contract({ tool: "Resend", resolvedAdapter: "Resend", readiness: "needs_credentials", approvalRequired: true, writeCapable: true }),
    contract({ tool: "X", resolvedAdapter: "X", readiness: "mocked" }),
  ];

  it("labels each advertised action with its provenance", () => {
    const completedStripe: ToolCallRecord = { adapter: "Stripe", action: "read balance", status: "completed", summary: "ok" };
    const panel = buildTrustPanel({ contracts, toolCalls: [completedStripe], output: null });

    const byTool = Object.fromEntries(panel.actions.map((a) => [a.tool, a.provenance]));
    expect(byTool.Stripe).toBe("real"); // connected + executed this run
    expect(byTool.Resend).toBe("needs_credentials");
    expect(byTool.X).toBe("mock");
    expect(panel.counts.real).toBe(1);
    expect(panel.counts.needs_credentials).toBe(1);
    expect(panel.counts.mock).toBe(1);
  });

  it("blocks a false prose claim from showing as done (anti-false-green)", () => {
    const output = { summary: "I sent the launch announcement email to the founder list." };
    const panel = buildTrustPanel({ contracts, toolCalls: [], output });

    expect(panel.noUnverifiedClaims).toBe(false);
    expect(panel.violations.length).toBeGreaterThan(0);
    expect(panel.violations[0].tool).toBe("Resend");
    expect(panel.violations[0].reason).toBe("not_executed");
  });

  it("shows the no-unverified-claims badge when prose makes no tool claims", () => {
    const output = { summary: "Reviewed internal notes and drafted a plan for next cycle." };
    const panel = buildTrustPanel({ contracts, toolCalls: [], output });

    expect(panel.noUnverifiedClaims).toBe(true);
    expect(panel.violations).toEqual([]);
  });
});
