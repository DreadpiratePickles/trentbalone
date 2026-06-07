import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AutoresearchClient } from "@/components/autoresearch-client";
import type { AutoresearchView } from "@/lib/self-improvement/autoresearch-read";

const view: AutoresearchView = {
  pending: [
    {
      approvalId: "a1",
      taskType: "draft-email",
      candidateKind: "skill",
      reason: "Candidate improves reply quality by 8%",
      previewContent: "- old line\n+ new line",
      createdAt: new Date().toISOString(),
    },
  ],
  iterations: [
    {
      id: "iter1",
      companyId: "c1",
      taskType: "draft-email",
      candidateId: "cand1",
      candidateKind: "skill",
      score: 0.91,
      delta: 0.08,
      decision: "promoted",
      triggers: ["failure-cluster", "low-score"],
      createdAt: new Date().toISOString(),
    },
  ],
};

describe("AutoresearchClient", () => {
  it("renders the header, a pending item, and an iteration row", () => {
    const html = renderToStaticMarkup(<AutoresearchClient companyId="c1" initial={view} />);
    expect(html).toContain("Autoresearch");
    expect(html).toContain("Pending review");
    // pending item content
    expect(html).toContain("Candidate improves reply quality by 8%");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    // iteration timeline content
    expect(html).toContain("Iteration history");
    expect(html).toContain("promoted");
    expect(html).toContain("failure-cluster");
    expect(html).toContain("0.91");
  });
});
