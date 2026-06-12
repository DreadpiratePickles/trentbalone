import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { agentTrustSignals, SeatToolBadges } from "@/components/agent-plug-client";

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

describe("SeatToolBadges", () => {
  it("renders contract readiness verbatim from seat-tool contracts", () => {
    const html = renderToStaticMarkup(
      <SeatToolBadges
        contracts={[
          {
            seat: "engineer",
            tool: "GitHub",
            binding: "adapter_name",
            resolvedAdapter: "GitHub",
            readiness: "needs_credentials",
            advertised: true,
            approvalRequired: true,
            writeCapable: true,
          },
          {
            seat: "engineer",
            tool: "tasks:create",
            binding: "internal_action",
            resolvedAdapter: null,
            readiness: "internal",
            advertised: true,
            approvalRequired: false,
            writeCapable: false,
          },
        ]}
      />,
    );

    expect(html).toContain("GitHub: needs_credentials");
    expect(html).toContain("tasks:create: internal");
    expect(html).toContain("data-testid=\"seat-tool-readiness\"");
  });
});
