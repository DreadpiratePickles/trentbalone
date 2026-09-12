import { describe, expect, it } from "vitest";
import {
  buildSourceCoverage,
  extractSourceNeeds,
  formatSourceCoverage,
  formatSourceDocumentsBlock,
  selectRelevantDocuments,
} from "@/lib/source-coverage";

const doc = (id: string, title: string, content = "", type = "brief") => ({ id, title, content, type });

describe("extractSourceNeeds", () => {
  it("extracts explicit filenames", () => {
    const needs = extractSourceNeeds("Analyze customers.csv, support-tickets.csv, and analytics.json.");
    expect(needs.map((n) => n.label)).toEqual(["customers.csv", "support-tickets.csv", "analytics.json"]);
    expect(needs.every((n) => n.kind === "file")).toBe(true);
  });

  it("extracts doc-noun topics from tester prompts", () => {
    const needs = extractSourceNeeds(
      "Using the ICP, marketing plan, competitive research, and brand voice, draft a 7-day launch campaign.",
    );
    const labels = needs.map((n) => n.label);
    expect(labels).toContain("marketing plan");
    expect(labels).toContain("brand voice");
    expect(labels).toContain("competitive research");
    expect(labels).toContain("icp");
  });

  it("does not duplicate a topic already covered by an explicit file", () => {
    const needs = extractSourceNeeds("Read analytics.json and the analytics dashboard.");
    expect(needs.filter((n) => n.label.includes("analytics"))).toHaveLength(1);
  });

  it("returns empty for source-free objectives", () => {
    expect(extractSourceNeeds("Say hello to the team")).toEqual([]);
  });
});

describe("buildSourceCoverage", () => {
  const docs = [
    doc("d1", "Roadmap Q3", "ship provisioning"),
    doc("d2", "customers.csv", "id,name"),
    doc("d3", "Brand Voice Guide", "we speak plainly"),
  ];

  it("marks available sources as used with document ids", () => {
    const cov = buildSourceCoverage("Use the roadmap and brand voice to plan.", docs);
    expect(cov.missing).toEqual([]);
    expect(cov.used.map((u) => u.documentId).sort()).toEqual(["d1", "d3"]);
  });

  it("reports missing sources instead of silently passing", () => {
    const cov = buildSourceCoverage("Audit the roadmap, analytics, and feature gap list.", docs);
    expect(cov.used.some((u) => u.documentId === "d1")).toBe(true);
    const missingLabels = cov.missing.map((m) => m.label);
    expect(missingLabels).toContain("analytics");
    expect(missingLabels).toContain("feature gap");
  });

  it("matches explicit filenames against upload titles", () => {
    const cov = buildSourceCoverage("Analyze customers.csv for churn.", docs);
    expect(cov.used[0]?.documentId).toBe("d2");
  });
});

describe("formatSourceCoverage", () => {
  it("renders missing sources with a do-not-claim instruction", () => {
    const cov = buildSourceCoverage("Audit the roadmap and analytics.", [doc("d1", "Roadmap")]);
    const text = formatSourceCoverage(cov);
    expect(text).toContain("Available: roadmap (doc d1)");
    expect(text).toContain("Missing: analytics");
    expect(text).toContain("do NOT claim");
  });

  it("returns empty string when nothing is required", () => {
    expect(formatSourceCoverage(buildSourceCoverage("hello", []))).toBe("");
  });
});

describe("selectRelevantDocuments", () => {
  it("ranks docs sharing mission keywords first", () => {
    const docs = [
      doc("a", "Weekly status", "nothing relevant"),
      doc("b", "Launch campaign plan", "campaign channels budget"),
      doc("c", "Brand voice", "tone for campaign copy"),
    ];
    const top = selectRelevantDocuments("draft a launch campaign using brand voice", docs, 2);
    expect(top.map((d) => d.id).sort()).toEqual(["b", "c"]);
  });

  it("caps at k", () => {
    const docs = Array.from({ length: 10 }, (_, i) => doc(`d${i}`, `roadmap ${i}`, "roadmap"));
    expect(selectRelevantDocuments("roadmap", docs, 6)).toHaveLength(6);
  });
});

describe("formatSourceDocumentsBlock", () => {
  it("includes ids, titles, and truncated excerpts", () => {
    const block = formatSourceDocumentsBlock([doc("d9", "Roadmap", "x".repeat(5000))], 100);
    expect(block).toContain("[d9] Roadmap");
    expect(block).toContain("cite by id");
    expect(block.length).toBeLessThan(400);
  });

  it("returns empty string with no documents", () => {
    expect(formatSourceDocumentsBlock([])).toBe("");
  });
});
