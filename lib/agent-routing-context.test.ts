import { describe, expect, it } from "vitest";
import {
  buildAgentRoutingContext,
  recommendSeatForObjective,
} from "@/lib/agent-routing-context";

describe("agent routing context", () => {
  it("renders the full CEO routing dossier with runtime tools, skills, and gates", () => {
    const context = buildAgentRoutingContext("co_routing");

    expect(context).toContain("CEO routing dossier");
    expect(context).toContain("Growth / Marketing");
    expect(context).not.toContain("HyperFrames");
    expect(context).not.toContain("Open Generative AI");
    expect(context).toContain("Finance");
    expect(context).not.toContain("Fincept Terminal");
    expect(context).not.toContain("Ghostfolio");
    expect(context).toContain("Research / Analyst");
    expect(context).toContain("Steel Browser");
    expect(context).toContain("approval gates:");
    expect(context).toContain("skills:");
  });

  it.each([
    {
      // SHRINK: Finance shelved → Operator (ceo) handles finance oversight.
      objective: "Use Fincept Terminal to research market risk and produce a portfolio risk report.",
      role: "ceo",
      tool: "Stripe",
    },
    {
      objective: "Create a HyperFrames launch video for the pricing experiment.",
      role: "growth",
      tool: "documents:write",
    },
    {
      // SHRINK: Analyst shelved → Operator (ceo) coordinates web-evidence/research.
      objective: "Use Steel to research competitor websites and capture screenshots.",
      role: "ceo",
      tool: "Steel Browser",
    },
    {
      // SHRINK: Sales shelved → Growth owns go-to-market.
      objective: "Build a prospect list and draft sales outreach for qualified leads.",
      role: "growth",
      tool: "prospects:research",
    },
    {
      objective: "Escalate this angry customer ticket and draft a safe support reply.",
      role: "support",
      tool: "support:inbound_email",
    },
    {
      objective: "Create GitHub issues and a PR test plan for the app-solo bug.",
      role: "engineer",
      tool: "Workbench Sandbox",
    },
  ] as const)("routes $objective", ({ objective, role, tool }) => {
    expect(recommendSeatForObjective(objective)).toMatchObject({ role, tool });
  });
});
