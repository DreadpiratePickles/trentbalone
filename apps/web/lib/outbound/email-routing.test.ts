import { describe, expect, it } from "vitest";
import { chooseEmailProvider, createWarmupPlan } from "./email-routing";

describe("email routing", () => {
  it("routes transactional, marketing, and bulk email by use case", () => {
    expect(chooseEmailProvider({ useCase: "transactional", dedicatedIpWarmed: true }).provider).toBe("postmark");
    expect(chooseEmailProvider({ useCase: "marketing", dedicatedIpWarmed: true }).provider).toBe("resend");
    expect(chooseEmailProvider({ useCase: "bulk", dedicatedIpWarmed: true }).provider).toBe("ses");
  });

  it("requires warmup before high-volume dedicated-IP sending", () => {
    const route = chooseEmailProvider({ useCase: "bulk", dedicatedIpWarmed: false, volume: "high" });
    expect(route.blocked).toBe(true);
    expect(route.reason).toContain("Dedicated IP warmup");
    expect(createWarmupPlan({ startDailyVolume: 50, targetDailyVolume: 800 })).toHaveLength(5);
  });
});
