import { describe, expect, it } from "vitest";
import {
  MISSION_SEAT_CONTRACTS,
  REQUIRED_MISSION_SEATS,
  getMissionSeatContract,
  findExternalWriteToolsMissingApproval,
  MISSION_APPROVAL_POLICY,
} from "@/lib/agent-mission-contracts";

describe("mission seat contracts", () => {
  it("defines a contract for every required mission seat", () => {
    for (const role of REQUIRED_MISSION_SEATS) {
      const contract = getMissionSeatContract(role);
      expect(contract, `missing contract for ${role}`).toBeTruthy();
      expect(contract.role).toBe(role);
      expect(contract.allowedTools.length).toBeGreaterThan(0);
      expect(contract.outputFields.length).toBeGreaterThan(0);
    }
  });

  it("requires the analyst to return research output fields", () => {
    const analyst = getMissionSeatContract("analyst");
    expect(analyst.outputFields).toEqual(
      expect.arrayContaining([
        "trendSignals",
        "viralFormats",
        "competitorFindings",
        "audienceInsights",
        "recommendedAngles",
      ]),
    );
  });

  it("requires the CEO to return the approval packet and final decision", () => {
    const ceo = getMissionSeatContract("ceo");
    expect(ceo.outputFields).toEqual(
      expect.arrayContaining(["missionSummary", "approvalPacket", "finalDecision", "nextActions"]),
    );
  });

  it("validates a well-formed analyst output against its schema", () => {
    const analyst = getMissionSeatContract("analyst");
    const parsed = analyst.outputSchema.safeParse({
      trendSignals: ["short-form spikes"],
      viralFormats: ["talking head"],
      competitorFindings: ["competitor X posts daily"],
      audienceInsights: ["founders 25-40"],
      recommendedAngles: ["build in public"],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an analyst output missing a required field", () => {
    const analyst = getMissionSeatContract("analyst");
    const parsed = analyst.outputSchema.safeParse({ trendSignals: ["x"] });
    expect(parsed.success).toBe(false);
  });

  it("has no external-write tool that lacks approval metadata", () => {
    expect(findExternalWriteToolsMissingApproval()).toEqual([]);
  });

  it("requires approval for publish and paid spend in the approval policy", () => {
    expect(MISSION_APPROVAL_POLICY.public_publish).toBe("required");
    expect(MISSION_APPROVAL_POLICY.paid_spend_or_boost).toBe("required");
    expect(MISSION_APPROVAL_POLICY.email_or_sales_send).toBe("required");
  });

  it("gives every seat a positive budget and time cap", () => {
    for (const contract of Object.values(MISSION_SEAT_CONTRACTS)) {
      expect(contract.budgetCapCents).toBeGreaterThan(0);
      expect(contract.timeCapMs).toBeGreaterThan(0);
    }
  });
});
