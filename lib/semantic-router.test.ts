import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { store } from "@/lib/store";
import {
  capabilityToRoleRegex,
  recallRelevantMemory,
  resetSemanticRouterForTests,
  routeCapabilityToRole,
  routeToolsForStep,
  setSemanticRouterEmbedderForTests,
} from "@/lib/semantic-router";
import type { AgentRole } from "@/lib/types";

/** Deterministic unit vectors so cosine routing is predictable in CI. */
function mockEmbedder(anchors: Record<string, Partial<Record<AgentRole | string, number>>>) {
  const dims = 8;
  const roleVec: Record<AgentRole, number[]> = {
    ceo: unit([1, 0, 0, 0, 0, 0, 0, 0]),
    engineer: unit([0, 1, 0, 0, 0, 0, 0, 0]),
    growth: unit([0, 0, 1, 0, 0, 0, 0, 0]),
    content: unit([0, 0, 0, 1, 0, 0, 0, 0]),
    support: unit([0, 0, 0, 0, 1, 0, 0, 0]),
    analyst: unit([0, 0, 0, 0, 0, 1, 0, 0]),
    finance: unit([0, 0, 0, 0, 0, 0, 1, 0]),
    sales: unit([0, 0, 0, 0, 0, 0, 0, 1]),
    escalation: unit([1, 1, 0, 0, 0, 0, 0, 0]),
  };

  return async (texts: string[]) =>
    texts.map((text) => {
      const rolePrefix = (Object.keys(roleVec) as AgentRole[]).find(
        (role) => text.startsWith(`${role}\n`) || text.startsWith(`${role} `),
      );
      if (rolePrefix) return roleVec[rolePrefix];

      const key = Object.keys(anchors).find((k) => text.toLowerCase().includes(k.toLowerCase()));
      const weights = key ? anchors[key]! : {};
      const vec = new Array(dims).fill(0);
      for (const [label, w] of Object.entries(weights)) {
        const base = roleVec[label as AgentRole] ?? toolVec(label);
        for (let i = 0; i < dims; i++) vec[i] += (base[i] ?? 0) * (w ?? 1);
      }
      if (vec.every((v) => v === 0)) return unit([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]);
      return unit(vec);
    });
}

function toolVec(name: string): number[] {
  const h = name.split("").reduce((s, c) => s + c.charCodeAt(0), 0);
  const vec = new Array(8).fill(0).map((_, i) => ((h * (i + 3)) % 17) / 17);
  return unit(vec);
}

function unit(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

describe("routeCapabilityToRole", () => {
  beforeEach(() => {
    resetSemanticRouterForTests();
  });

  afterEach(() => {
    setSemanticRouterEmbedderForTests(null);
    resetSemanticRouterForTests();
  });

  it("routes analyze churn cohorts to analyst without regex keyword overlap", async () => {
    setSemanticRouterEmbedderForTests(
      mockEmbedder({
        churn: { analyst: 1 },
        analyst: { analyst: 1 },
      }),
    );
    resetSemanticRouterForTests();

    expect(capabilityToRoleRegex("analyze churn cohorts")).toBeNull();
    expect(await routeCapabilityToRole("analyze churn cohorts")).toBe("analyst");
  });

  it("routes draft launch email to content without relying on the email keyword regex alone", async () => {
    setSemanticRouterEmbedderForTests(
      mockEmbedder({
        "drip sequence": { content: 1 },
        nurture: { content: 1 },
      }),
    );
    resetSemanticRouterForTests();

    expect(capabilityToRoleRegex("draft nurture drip sequence")).toBeNull();
    expect(await routeCapabilityToRole("draft nurture drip sequence")).toBe("content");
  });

  it("falls back to regex when semantic score is below threshold", async () => {
    const flat = unit([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]);
    setSemanticRouterEmbedderForTests(async (texts) => texts.map(() => flat));
    resetSemanticRouterForTests();

    expect(await routeCapabilityToRole("write code and open a pull request")).toBe("engineer");
  });

  it("golden routing set beats regex-only baseline on unroutable phrases", async () => {
    const golden: Array<{ phrase: string; role: AgentRole }> = [
      { phrase: "break down retention curves by signup week", role: "analyst" },
      { phrase: "compose onboarding drip sequence", role: "content" },
      { phrase: "qualify enterprise champions for expansion", role: "sales" },
    ];

    setSemanticRouterEmbedderForTests(
      mockEmbedder({
        retention: { analyst: 1 },
        onboarding: { content: 1 },
        pipeline: { sales: 1 },
        champions: { sales: 1 },
      }),
    );
    resetSemanticRouterForTests();

    let regexHits = 0;
    let semanticHits = 0;
    for (const { phrase, role } of golden) {
      if (capabilityToRoleRegex(phrase) === role) regexHits += 1;
      if ((await routeCapabilityToRole(phrase)) === role) semanticHits += 1;
    }
    expect(regexHits).toBeLessThan(semanticHits);
    expect(semanticHits).toBe(golden.length);
  });
});

describe("routeToolsForStep", () => {
  beforeEach(() => {
    resetSemanticRouterForTests();
  });

  afterEach(() => {
    setSemanticRouterEmbedderForTests(null);
    resetSemanticRouterForTests();
  });

  it("returns top-k allowed tools ranked by semantic similarity", async () => {
    setSemanticRouterEmbedderForTests(
      async (texts) =>
        texts.map((text) => {
          if (text.startsWith("Steel Browser")) return unit([0, 0, 0, 0, 0, 1, 0, 0]);
          if (text.startsWith("GitHub")) return unit([0, 1, 0, 0, 0, 0, 0, 0]);
          if (text.toLowerCase().includes("scrape") || text.toLowerCase().includes("research")) {
            return unit([0, 0, 0, 0, 0, 1, 0, 0]);
          }
          return unit([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]);
        }),
    );
    resetSemanticRouterForTests();

    const ranked = await routeToolsForStep(
      "research competitor pricing pages and scrape summaries",
      { tools: ["GitHub", "Steel Browser"] },
      2,
    );
    expect(ranked.map((t) => t.name)).toEqual(["Steel Browser", "GitHub"]);
  });

  it("falls back to substring match when semantic confidence is low", async () => {
    setSemanticRouterEmbedderForTests(mockEmbedder({}));
    resetSemanticRouterForTests();

    const ranked = await routeToolsForStep("create GitHub issue for the bug", { tools: ["GitHub", "Slack"] }, 3);
    expect(ranked[0]?.name).toBe("GitHub");
  });

  it("treats adapter scopes as allowed tool aliases", async () => {
    setSemanticRouterEmbedderForTests(
      async (texts) =>
        texts.map((text) => {
          if (text.startsWith("Workbench Sandbox")) return unit([0, 1, 0, 0, 0, 0, 0, 0]);
          if (text.toLowerCase().includes("sandbox") || text.toLowerCase().includes("tests")) {
            return unit([0, 1, 0, 0, 0, 0, 0, 0]);
          }
          return unit([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]);
        }),
    );
    resetSemanticRouterForTests();

    const ranked = await routeToolsForStep("run tests in the sandbox", { tools: ["sandbox:exec"] }, 1);

    expect(ranked[0]?.name).toBe("Workbench Sandbox");
  });

  it("avoids a degraded tool when a healthy alternative matches", async () => {
    // Both tools match the step; Steel Browser would rank first, but it is
    // degraded, so the healthy GitHub is returned instead.
    setSemanticRouterEmbedderForTests(
      async (texts) =>
        texts.map((text) => {
          if (text.startsWith("Steel Browser")) return unit([0, 0, 0, 0, 0, 1, 0, 0]);
          if (text.startsWith("GitHub")) return unit([0, 0, 0, 0, 0, 1, 0, 0]);
          if (text.toLowerCase().includes("scrape") || text.toLowerCase().includes("research")) {
            return unit([0, 0, 0, 0, 0, 1, 0, 0]);
          }
          return unit([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]);
        }),
    );
    resetSemanticRouterForTests();

    const ranked = await routeToolsForStep(
      "research competitor pricing pages and scrape summaries",
      { tools: ["GitHub", "Steel Browser"] },
      2,
      { degradedTools: new Set(["Steel Browser"]) },
    );
    expect(ranked.map((t) => t.name)).toEqual(["GitHub"]);
  });

  it("still uses a degraded tool when it is the only option (never strands a step)", async () => {
    setSemanticRouterEmbedderForTests(
      async (texts) =>
        texts.map((text) => {
          if (text.startsWith("GitHub")) return unit([0, 1, 0, 0, 0, 0, 0, 0]);
          if (text.toLowerCase().includes("issue")) return unit([0, 1, 0, 0, 0, 0, 0, 0]);
          return unit([0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01]);
        }),
    );
    resetSemanticRouterForTests();

    const ranked = await routeToolsForStep(
      "create GitHub issue for the bug",
      { tools: ["GitHub"] },
      3,
      { degradedTools: new Set(["GitHub"]) },
    );
    expect(ranked[0]?.name).toBe("GitHub");
  });
});

describe("recallRelevantMemory", () => {
  beforeEach(() => {
    resetSemanticRouterForTests();
  });

  afterEach(() => {
    setSemanticRouterEmbedderForTests(null);
    resetSemanticRouterForTests();
  });

  it("includes topically relevant docs and excludes unrelated recent ones under token budget", async () => {
    const company = await store.createCompany({
      name: "Memory Recall Co",
      brief: { vision: "Reduce churn" },
    });

    await store.createDocument({
      companyId: company.id,
      type: "weekly_report",
      title: "Office snack inventory",
      content: "Ordered kale chips and sparkling water for the break room.",
      source: "ops:snacks",
    });
    await store.createDocument({
      companyId: company.id,
      type: "agent_note",
      title: "Enterprise churn post-mortem",
      content: "Enterprise cohort churn spiked 4.2% after the pricing change. Root cause: annual contracts.",
      source: "cycle:churn",
      memoryTier: "episodic",
    });

    setSemanticRouterEmbedderForTests(
      mockEmbedder({
        churn: { analyst: 1 },
        enterprise: { analyst: 0.8 },
        snack: { content: 1 },
        kale: { content: 1 },
      }),
    );
    resetSemanticRouterForTests();

    const recalled = await recallRelevantMemory(company.id, "Reduce enterprise SaaS churn", {
      k: 1,
      tokenBudget: 400,
    });

    expect(recalled.text).toContain("Enterprise churn post-mortem");
    expect(recalled.text).not.toContain("kale chips");
    expect(recalled.estimatedTokens).toBeLessThanOrEqual(400);
    expect(recalled.items[0]?.title).toContain("Enterprise churn");
  });
});
