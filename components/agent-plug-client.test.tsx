import { describe, expect, it } from "vitest";
import { agentTrustSignals } from "@/components/agent-plug-client";

describe("agentTrustSignals", () => {
  it("surfaces capability and skill trust signals for Plug cards", () => {
    expect(
      agentTrustSignals({
        capability: { score: 92, qualityLabel: "supervised" },
        skills: [
          "verification-before-completion",
          "test-driven-development",
          "systematic-debugging",
          "frontend-design",
        ],
      })
    ).toEqual([
      "supervised 92",
      "verification-before-completion",
      "test-driven-development",
      "systematic-debugging",
    ]);
  });
});
