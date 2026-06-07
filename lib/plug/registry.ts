import type { PlugDefinition } from "@/lib/plug/schema-v2";

const launchNames = [
  ["saas-launcher", "SaaS Launcher", "operations"],
  ["ecomm-launcher", "E-comm Launcher", "commerce"],
  ["agency-dashboard", "Agency Dashboard", "operations"],
  ["investor-update", "Investor Update", "finance"],
  ["churn-report", "Churn Report", "analytics"],
  ["content-calendar", "Content Calendar", "marketing"],
  ["podcast-launcher", "Podcast Launcher", "content"],
  ["newsletter", "Newsletter", "content"],
  ["course-launcher", "Course Launcher", "education"],
  ["b2b-outbound", "B2B Outbound", "sales"],
  ["customer-research", "Customer Research", "research"],
  ["competitive-monitor", "Competitive Monitor", "research"],
  ["fundraising-prep", "Fundraising Prep", "finance"],
  ["soc2-prep", "SOC 2 Prep", "compliance"],
  ["gdpr-audit", "GDPR Audit", "compliance"],
  ["okr-planning", "OKR Planning", "operations"],
  ["weekly-ops-review", "Weekly Ops Review", "operations"],
  ["daily-standup", "Daily Standup", "operations"],
  ["monthly-board-pack", "Monthly Board Pack", "finance"],
  ["year-end-retrospective", "Year-End Retrospective", "operations"],
] as const;

export function listLaunchPlugs(): PlugDefinition[] {
  return launchNames.map(([slug, name, category], index) => makePlug(slug, name, category, index));
}

export function findPlugBySlug(slug: string, plugs = listLaunchPlugs()) {
  return plugs.find((plug) => plug.slug === slug);
}

export function matchPlugsForIntent(intent: string, plugs = listLaunchPlugs()) {
  const terms = intent.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return plugs
    .map((plug) => ({ plug, score: terms.filter((term) => `${plug.slug} ${plug.name} ${plug.category} ${plug.industry}`.toLowerCase().includes(term)).length }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.plug.capabilityScore - a.plug.capabilityScore)
    .map((item) => item.plug);
}

function makePlug(slug: string, name: string, category: string, index: number): PlugDefinition {
  const score = Math.round((0.72 + (index % 8) * 0.025) * 1000) / 1000;
  return {
    id: `plug_${slug.replace(/-/g, "_")}`,
    slug,
    name,
    category,
    industry: category === "commerce" ? "ecommerce" : "b2b-saas",
    complexityTier: index % 4 === 0 ? "advanced" : "standard",
    version: "1.0.0",
    declaredTools: [{ toolId: "reports", allowedActions: ["create", "read"], approvalRequiredActions: [] }],
    integrations: ["analytics"],
    seats: [{ seat: "analyst", promptTemplate: `${name} for {{company}}`, outputContract: `${slug}.v1`, timeoutMs: 600000, budgetCents: 200, modelTier: "sonnet" }],
    memoryNamespace: `company:{companyId}/plug:${slug}`,
    cycles: [{ cadence: slug.includes("daily") ? "daily" : slug.includes("weekly") ? "weekly" : "on_demand" }],
    evalSet: {
      fixtureRefs: Array.from({ length: 20 }, (_, fixtureIndex) => `${slug}_fixture_${String(fixtureIndex + 1).padStart(2, "0")}`),
      passThreshold: 0.7,
      lastScore: score,
    },
    capabilityScore: score,
    costPerRunCents: 100 + index * 5,
    completionRate: Math.min(0.99, 0.82 + (index % 10) * 0.015),
    pricing: { mode: "free", revenueShareBps: 0 },
    publisher: { id: "trent", verified: true, ownershipHistory: [{ publisherId: "trent", changedAt: "2026-05-29T00:00:00.000Z", reviewed: true }] },
    changelog: [{ version: "1.0.0", notes: "Launch fixture-backed Plug", createdAt: "2026-05-29T00:00:00.000Z" }],
    visibility: { scope: "public" },
  };
}
