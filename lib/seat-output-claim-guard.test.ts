import { describe, expect, it } from "vitest";
import {
  detectClaimViolations,
  guardSeatOutputClaims,
} from "@/lib/seat-output-claim-guard";
import type { SeatToolContract } from "@/lib/seat-tool-contracts";
import type { ToolCallRecord } from "@/lib/types";

function contract(partial: Partial<SeatToolContract> & Pick<SeatToolContract, "tool" | "readiness">): SeatToolContract {
  return {
    seat: "growth",
    binding: "adapter_name",
    resolvedAdapter: partial.resolvedAdapter ?? partial.tool,
    advertised: true,
    approvalRequired: false,
    writeCapable: false,
    ...partial,
  } as SeatToolContract;
}

describe("seat output claim guard", () => {
  it("flags a prose claim of using an uncredentialed tool that never executed", () => {
    const contracts = [contract({ tool: "Email", resolvedAdapter: "Email", readiness: "needs_credentials" })];
    const output = { summary: "I sent the launch email to every signup and confirmed delivery." };

    const violations = detectClaimViolations({ output, contracts, toolCalls: [] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ tool: "Email", reason: "not_executed" });
  });

  it("neutralizes the false claim in the rewritten output", () => {
    const contracts = [contract({ tool: "Stripe", resolvedAdapter: "Stripe", readiness: "needs_credentials" })];
    const output = { summary: "Pulled the Stripe MRR and it is $42k.", whatIDidNotDo: [] as string[] };

    const result = guardSeatOutputClaims({ output, contracts, toolCalls: [] });
    expect(result.violations).toHaveLength(1);
    expect(String(result.output?.summary)).toMatch(/UNVERIFIED TOOL CLAIM/);
    expect(result.output?.whatIDidNotDo as string[]).toContainEqual(
      expect.stringContaining("Did not actually use Stripe"),
    );
  });

  it("allows the claim when a matching tool call actually completed", () => {
    const contracts = [contract({ tool: "Sentry", resolvedAdapter: "Sentry", readiness: "needs_credentials" })];
    const toolCalls: ToolCallRecord[] = [
      { adapter: "Sentry", action: "list issues", status: "completed", summary: "12 unresolved issues" },
    ];
    const output = { summary: "Fetched the Sentry error feed and triaged the top crash." };

    expect(detectClaimViolations({ output, contracts, toolCalls })).toEqual([]);
  });

  it("flags connected external tools when prose claims work but no tool call ran", () => {
    const contracts = [contract({ tool: "Stripe", resolvedAdapter: "Stripe", readiness: "connected" })];
    const output = { summary: "Pulled the Stripe balance and confirmed cash runway." };

    const violations = detectClaimViolations({ output, contracts, toolCalls: [] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ tool: "Stripe", reason: "not_executed" });
  });

  it("allows connected external tools when the matching tool call completed", () => {
    const contracts = [contract({ tool: "Stripe", resolvedAdapter: "Stripe", readiness: "connected" })];
    const toolCalls: ToolCallRecord[] = [
      { adapter: "Stripe", action: "read balance", status: "completed", summary: "balance ok" },
    ];
    const output = { summary: "Pulled the Stripe balance and confirmed cash runway." };

    expect(detectClaimViolations({ output, contracts, toolCalls })).toEqual([]);
  });

  it("treats a mock-only tool call as not a real execution", () => {
    const contracts = [contract({ tool: "PostHog", resolvedAdapter: "PostHog", readiness: "mocked" })];
    const toolCalls: ToolCallRecord[] = [
      { adapter: "PostHog", action: "read funnel", status: "mocked", summary: "mock funnel" },
    ];
    const output = { summary: "Queried PostHog and the funnel retention improved 10%." };

    const violations = detectClaimViolations({ output, contracts, toolCalls });
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("mock_only");
  });

  it("does not flag internal tools", () => {
    const contracts = [
      contract({ tool: "tasks:create", binding: "internal_action", resolvedAdapter: null, readiness: "internal" }),
    ];
    const output = { summary: "Created the follow-up tasks." };

    expect(detectClaimViolations({ output, contracts, toolCalls: [] })).toEqual([]);
  });

  it("does not flag a mention without a completed-action verb", () => {
    const contracts = [contract({ tool: "Email", resolvedAdapter: "Email", readiness: "needs_credentials" })];
    const output = { summary: "Email is not configured yet, so I drafted the copy for later approval." };

    expect(detectClaimViolations({ output, contracts, toolCalls: [] })).toEqual([]);
  });
});
