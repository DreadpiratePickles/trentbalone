import { describe, expect, it } from "vitest";
import {
  anonymizeAndAggregate,
  renderCrossCompanyLearningBlock,
  selectCrossCompanyLearnings,
} from "./cross-company-learning";
import type { CompanyPlaybookEntry } from "./company-playbook";

function entry(p: Partial<CompanyPlaybookEntry> & { companyId: string; text: string }): CompanyPlaybookEntry {
  return {
    id: Math.random().toString(36).slice(2),
    kind: "add",
    topic: p.topic ?? "growth.tactics",
    status: "active",
    createdAt: new Date().toISOString(),
    sourceRunId: "run_x",
    ...p,
  };
}

describe("cross-company-learning", () => {
  it("anonymizes — never leaks companyId/id/sourceRunId", () => {
    const out = anonymizeAndAggregate([entry({ companyId: "co_secret", text: "Annual pricing lifts conversion" })]);
    expect(out).toHaveLength(1);
    expect(JSON.stringify(out[0])).not.toContain("co_secret");
    expect(out[0]).toEqual({ kind: "add", topic: "growth.tactics", text: "Annual pricing lifts conversion", corroborations: 1 });
  });

  it("collapses identical learnings across companies and counts corroborations", () => {
    const out = anonymizeAndAggregate([
      entry({ companyId: "co_a", text: "Cold email at 8am beats 2pm" }),
      entry({ companyId: "co_b", text: "cold email at 8am beats 2pm" }), // case/space variant
      entry({ companyId: "co_c", text: "Cold email at  8am beats 2pm " }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].corroborations).toBe(3);
  });

  it("excludes the current company and deprecated entries", () => {
    const out = anonymizeAndAggregate(
      [
        entry({ companyId: "co_self", text: "self learning" }),
        entry({ companyId: "co_other", text: "other learning" }),
        entry({ companyId: "co_x", text: "dead learning", status: "deprecated" }),
      ],
      { excludeCompanyId: "co_self" },
    );
    const texts = out.map((l) => l.text);
    expect(texts).toEqual(["other learning"]);
  });

  it("relevance-ranks learnings to the objective and excludes the current company", () => {
    const entries = [
      entry({ companyId: "co_self", topic: "pricing", text: "Our own pricing note" }),
      entry({ companyId: "co_a", topic: "pricing.experiments", text: "Annual pricing tiers lifted conversion 18%" }),
      entry({ companyId: "co_b", topic: "office", text: "Restock the office snacks weekly" }),
    ];
    const picked = selectCrossCompanyLearnings("design a pricing experiment to lift conversion", entries, 1, {
      excludeCompanyId: "co_self",
    });
    expect(picked).toHaveLength(1);
    expect(picked[0].text).toContain("Annual pricing tiers");
  });

  it("renders an anonymized, clearly-labeled prior block", () => {
    const block = renderCrossCompanyLearningBlock([
      { kind: "add", topic: "outreach", text: "8am beats 2pm", corroborations: 4 },
      { kind: "add", topic: "pricing", text: "annual lifts conversion", corroborations: 1 },
    ]);
    expect(block).toContain("CROSS-COMPANY LEARNINGS");
    expect(block).toContain("anonymized");
    expect(block).toContain("[outreach] 8am beats 2pm (corroborated by 4 companies)");
    expect(block).toContain("[pricing] annual lifts conversion");
    expect(block).not.toContain("corroborated by 1");
  });

  it("renders nothing for an empty set", () => {
    expect(renderCrossCompanyLearningBlock([])).toBe("");
  });
});
