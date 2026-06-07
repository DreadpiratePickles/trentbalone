import { describe, expect, it } from "vitest";
import {
  buildOrchestratorSeatDossier,
  buildSeatContextBundle,
  buildSeatSystemPrompt,
  SEAT_MANIFESTS,
} from "@/lib/seat-manifest";

describe("seat manifests", () => {
  it("defines human-capability-grade contracts for all 9 core seats", () => {
    expect(Object.keys(SEAT_MANIFESTS)).toEqual([
      "ceo",
      "engineer",
      "growth",
      "content",
      "support",
      "finance",
      "analyst",
      "escalation",
      "sales",
    ]);
    expect(SEAT_MANIFESTS.ceo.whenToUse).toContain("routing");
    expect(SEAT_MANIFESTS.growth.whenNotToUse).toContain("Ledger");
    expect(SEAT_MANIFESTS.engineer.tools.some((tool) => tool.name === "run_tests")).toBe(true);
    expect(SEAT_MANIFESTS.finance.outputContract).toContain("reconciliation");
    expect(SEAT_MANIFESTS.sales.whenToUse).toContain("Sales");
  });

  it("builds strong prompts and need-to-know context bundles", () => {
    const prompt = buildSeatSystemPrompt("content");
    expect(prompt).toContain("Methodology.");
    expect(prompt).toContain("Tool-use strategy.");
    expect(prompt).toContain("Anti-patterns.");
    expect(prompt).toContain("Definition of done.");

    const context = buildSeatContextBundle("growth", {
      icp: "founders",
      offer: "AI cofounder",
      budget: 5000,
      ledger: "finance-only",
      repoContext: "engineer-only",
    });
    expect(context).toEqual({ icp: "founders", offer: "AI cofounder", budget: 5000 });
  });

  it("includes detailed Dify-style tool metadata in specialist prompts", () => {
    const prompt = buildSeatSystemPrompt("growth");

    expect(prompt).toContain("Tool details.");
    expect(prompt).toContain("hyperframes_create:");
    expect(prompt).toContain("auth=none");
    expect(prompt).toContain("mode=sandbox");
    expect(prompt).toContain("approval=false");
    expect(prompt).toContain("reversibility=reversible");
    expect(prompt).toContain("actions=read, draft, request_approval");
    expect(prompt).toContain("context=companyBrief, icp, offer");
    expect(prompt).toContain("audit=sandbox/pii:none/artifact:true");
  });

  it("exposes a CEO-readable dossier with exact usage, tools, and context boundaries", () => {
    const dossier = buildOrchestratorSeatDossier();
    const growth = dossier.seats.find((seat) => seat.role === "growth");
    const finance = dossier.seats.find((seat) => seat.role === "finance");

    expect(dossier.routingRule).toContain("need-to-know");
    expect(growth?.whenToUse).toContain("Acquisition");
    expect(growth?.tools.map((tool) => tool.name)).toContain("ads_draft");
    expect(growth?.contextNeeds).not.toContain("ledger");
    expect(finance?.contextNeeds).toContain("ledger");
    expect(finance?.tools.find((tool) => tool.name === "stripe_draft")?.approvalRequired).toBe(true);
  });
});
