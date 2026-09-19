import { describe, expect, it } from "vitest";
import {
  buildAgentRoutingContext,
  recommendSeatForObjective,
} from "@/lib/agent-routing-context";
import { SLOT_ENVIRONMENTS } from "@/lib/agent-catalog";
import { getSeatManifest } from "@/lib/seat-manifest";
import { repairOrchestrationPlanRoutes } from "@/lib/orchestrator-runtime";
import type { OrchestrationStep } from "@/lib/orchestrator-runtime";
import type { AgentRole } from "@/lib/types";

const SEAT_OBJECTIVES: ReadonlyArray<{ role: AgentRole; objective: string; tool: string }> = [
  {
    role: "finance",
    objective: "Reconcile the Stripe ledger and report runway against the spend budget.",
    tool: "Stripe",
  },
  {
    role: "analyst",
    objective: "Use Steel to research competitor websites and capture screenshots.",
    tool: "Steel Browser",
  },
  {
    role: "sales",
    objective: "Build a prospect list and draft sales outreach for qualified leads.",
    tool: "prospects:research",
  },
  {
    role: "escalation",
    objective: "Audit this irreversible delete for legal and privacy risk before approval.",
    tool: "audit:create",
  },
  {
    role: "engineer",
    objective: "Create GitHub issues and a PR test plan for the app-solo bug.",
    tool: "Workbench Sandbox",
  },
  {
    role: "growth",
    objective: "Run an SEO campaign and a funnel activation experiment for the new audience.",
    tool: "ads:draft",
  },
  {
    role: "content",
    objective: "Draft landing page copy and the launch email draft in the brand voice.",
    tool: "documents:write",
  },
  {
    role: "support",
    objective: "Escalate this angry customer ticket and draft a safe support reply.",
    tool: "support:inbound_email",
  },
  {
    role: "ceo",
    objective: "Decide what the company should work on next quarter.",
    tool: "tasks:create",
  },
];

function ceoOnlyPlan(objective: string) {
  const steps: OrchestrationStep[] = [
    {
      id: "s1",
      title: "Scope objective",
      rationale: "plan",
      agentRole: "ceo",
      dependsOn: [],
      expectedOutput: "scope",
      riskLevel: "low",
      needsApproval: false,
    },
    {
      id: "s2",
      title: "Consolidate result",
      rationale: "wrap",
      agentRole: "ceo",
      dependsOn: ["s1"],
      expectedOutput: "summary",
      riskLevel: "low",
      needsApproval: false,
    },
  ];
  return { objective, reasoning: "model picked CEO-only steps", blockers: [], successCriteria: ["Objective met"], steps };
}

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

  it.each(SEAT_OBJECTIVES)("routes an objective in the $role remit to $role", ({ role, objective, tool }) => {
    expect(recommendSeatForObjective(objective)).toMatchObject({ role, tool });
  });

  it.each(SEAT_OBJECTIVES)("names a real runtime tool of the $role seat", ({ role, objective }) => {
    const recommendation = recommendSeatForObjective(objective);
    expect(SLOT_ENVIRONMENTS[recommendation.role].tools).toContain(recommendation.tool);
  });

  it.each(SEAT_OBJECTIVES)("carries the $role seat's own manifest remit as the reason", ({ role, objective }) => {
    const recommendation = recommendSeatForObjective(objective);
    const manifest = getSeatManifest(role);

    expect(recommendation.reason).toContain(manifest.whenToUse);
    expect(recommendation.reason).not.toMatch(/shelved/i);
  });

  it.each([
    {
      objective: "Use Fincept Terminal to research market risk and produce a portfolio risk report.",
      role: "finance",
      tool: "Stripe",
      note: "Fincept Terminal is not installed as a verified sandbox app",
    },
    {
      objective: "Review the Ghostfolio holdings and the FIRE portfolio projection.",
      role: "finance",
      tool: "Stripe",
      note: "Ghostfolio is not installed as a verified sandbox app",
    },
    {
      objective: "Create a HyperFrames launch video for the pricing experiment.",
      role: "growth",
      tool: "documents:write",
      note: "HyperFrames is not installed as a verified rendering app",
    },
    {
      objective: "Use Open Generative AI to lip-sync the founder cinema workflow clip.",
      role: "growth",
      tool: "documents:write",
      note: "Open Generative AI is not installed as a verified creative app",
    },
  ] as const)("keeps the uninstalled-app note while routing $objective", ({ objective, role, tool, note }) => {
    const recommendation = recommendSeatForObjective(objective);

    expect(recommendation).toMatchObject({ role, tool });
    expect(recommendation.reason).toContain(note);
  });

  it("never recommends a shelved-seat fallback for any seat's remit", () => {
    for (const { objective } of SEAT_OBJECTIVES) {
      expect(recommendSeatForObjective(objective).reason).not.toMatch(/shelved|folds into|is not a seat/i);
    }
  });
});

// The escalation remit overlaps `isReadOnlyPlanObjective` ("audit ... risk"), which makes
// route repair a no-op, so the repair case uses an action-shaped escalation objective.
const REPAIR_OBJECTIVES: ReadonlyArray<{ role: AgentRole; objective: string }> = [
  ...SEAT_OBJECTIVES.filter(({ role }) => role === "finance" || role === "analyst" || role === "sales")
    .map(({ role, objective }) => ({ role, objective })),
  { role: "escalation", objective: "Merge the release branch and delete the retired legal archive." },
];

describe("route repair through recommendSeatForObjective", () => {
  it.each(REPAIR_OBJECTIVES)("injects a $role step into a CEO-only plan for a $role objective", ({ role, objective }) => {
    const plan = repairOrchestrationPlanRoutes(ceoOnlyPlan(objective));

    expect(plan.steps.map((step) => step.agentRole)).toContain(role);
    expect(plan.steps.some((step) => step.agentRole === "growth")).toBe(false);
    expect(plan.steps.at(-1)?.agentRole).toBe("ceo");
  });
});
