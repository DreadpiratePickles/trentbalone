import { describe, it, expect, vi } from "vitest";
import {
  buildSkillFrontmatter,
  buildFallbackSkill,
  buildDistillPrompt,
  parseDistillResponse,
  distillSkillFromTraces,
  InMemorySkillDraftStore,
  type SkillDraft,
} from "@/lib/skill-foundry";
import type { TraceRecord } from "@/lib/trace-store";

function trace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    id: "t1",
    companyId: "c1",
    runId: "r1",
    taskType: "churn_analysis",
    agentRole: "analyst",
    stepTitle: "Analyze churn cohorts",
    status: "completed",
    toolCalls: ["sql_query", "chart"],
    toolCallCount: 2,
    costCents: 12,
    humanCorrected: false,
    createdAt: "2026-06-02T00:00:00.000Z",
    ...overrides,
  };
}

const FIXED_NOW = "2026-06-02T12:00:00.000Z";

describe("buildSkillFrontmatter", () => {
  it("produces valid frontmatter block", () => {
    const fm = buildSkillFrontmatter("churn_analysis", "c1", "Analyze churn", ["analyst"], FIXED_NOW);
    expect(fm).toContain("name: churn_analysis");
    expect(fm).toContain("description: Analyze churn");
    expect(fm).toContain("version: 1.0.0");
    expect(fm).toContain("taskType: churn_analysis");
    expect(fm).toContain("companyId: c1");
    expect(fm.startsWith("---")).toBe(true);
    expect(fm.endsWith("---")).toBe(true);
  });

  it("slugifies task type names with spaces", () => {
    const fm = buildSkillFrontmatter("churn analysis deep dive", "c1", "Desc", [], FIXED_NOW);
    expect(fm).toContain("name: churn-analysis-deep-dive");
  });
});

describe("buildFallbackSkill", () => {
  it("includes step titles and tool calls from traces", () => {
    const traces = [
      trace({ stepTitle: "Pull cohorts", toolCalls: ["sql_query"] }),
      trace({ id: "t2", stepTitle: "Plot retention", toolCalls: ["chart"] }),
    ];
    const skill = buildFallbackSkill("churn_analysis", "c1", traces, FIXED_NOW);
    expect(skill).toContain("Pull cohorts");
    expect(skill).toContain("Plot retention");
    expect(skill).toContain("sql_query");
    expect(skill).toContain("chart");
  });

  it("includes recovery notes from retry steps with improvements", () => {
    const traces = [
      trace({ critiqueVerdict: "retry", improvement: "pull retention before MRR" }),
      trace({ id: "t2", critiqueVerdict: "pass" }),
    ];
    const skill = buildFallbackSkill("churn_analysis", "c1", traces, FIXED_NOW);
    expect(skill).toContain("pull retention before MRR");
  });

  it("produces valid agentskills.io frontmatter", () => {
    const skill = buildFallbackSkill("churn_analysis", "c1", [trace()], FIXED_NOW);
    expect(skill).toMatch(/^---\n/);
    expect(skill).toContain("version: 1.0.0");
  });
});

describe("buildDistillPrompt", () => {
  it("produces a create-mode prompt when no existing content", () => {
    const prompt = buildDistillPrompt([trace()], "churn_analysis");
    expect(prompt).toContain("churn_analysis");
    expect(prompt).toContain("action");
    expect(prompt).toContain("create");
    expect(prompt).not.toContain("patch");
  });

  it("produces a patch-mode prompt when existing content is provided", () => {
    const prompt = buildDistillPrompt([trace()], "churn_analysis", "## Existing Skill\n...");
    expect(prompt).toContain("patch");
    expect(prompt).toContain("Existing skill:");
    expect(prompt).toContain("## Existing Skill");
  });

  it("includes step title and tool calls in the run trace section", () => {
    const traces = [trace({ toolCalls: ["sql_query", "chart"] })];
    const prompt = buildDistillPrompt(traces, "churn_analysis");
    expect(prompt).toContain("Analyze churn cohorts");
    expect(prompt).toContain("sql_query");
    expect(prompt).toContain("chart");
  });

  it("includes the improvement note from retried steps", () => {
    const traces = [trace({ critiqueVerdict: "retry", improvement: "pull retention first" })];
    const prompt = buildDistillPrompt(traces, "churn_analysis");
    expect(prompt).toContain("pull retention first");
  });
});

describe("parseDistillResponse", () => {
  it("parses a valid create response", () => {
    const raw = JSON.stringify({ action: "create", content: "---\nname: test\n---\n## Steps" });
    const r = parseDistillResponse(raw);
    expect(r.action).toBe("create");
    expect(r.content).toContain("## Steps");
  });

  it("parses a valid patch response", () => {
    const raw = JSON.stringify({ action: "patch", old_string: "Step 1: old", new_string: "Step 1: new" });
    const r = parseDistillResponse(raw);
    expect(r.action).toBe("patch");
    expect(r.old_string).toBe("Step 1: old");
    expect(r.new_string).toBe("Step 1: new");
  });

  it("falls back to create with raw content on malformed JSON", () => {
    const raw = "---\nname: fallback\n---\n## Steps\n1. do something";
    const r = parseDistillResponse(raw);
    expect(r.action).toBe("create");
    expect(r.content).toBe(raw);
  });

  it("extracts JSON from surrounding prose", () => {
    const raw = 'Here is the skill:\n{"action":"create","content":"---\\nname:x\\n---"}';
    const r = parseDistillResponse(raw);
    expect(r.action).toBe("create");
  });

  it("handles empty string gracefully", () => {
    const r = parseDistillResponse("");
    expect(r.action).toBe("create");
    expect(r.content).toBeUndefined();
  });
});

describe("distillSkillFromTraces", () => {
  const baseOpts = (store: InMemorySkillDraftStore) => ({
    companyId: "c1",
    draftStore: store,
    skipLLM: true,
    auditLog: vi.fn().mockResolvedValue(undefined),
    id: "draft-fixed",
    now: FIXED_NOW,
  });

  it("returns null when the trigger check does not fire", async () => {
    const store = new InMemorySkillDraftStore();
    const traces = [trace({ toolCallCount: 1, evalScore: 0.3 })];
    const result = await distillSkillFromTraces(traces, "churn_analysis", baseOpts(store));
    expect(result).toBeNull();
  });

  it("produces a quarantine draft when trigger fires (tool_call_threshold)", async () => {
    const store = new InMemorySkillDraftStore();
    const traces = [
      trace({ toolCallCount: 3 }),
      trace({ id: "t2", toolCallCount: 2 }),
    ];
    const draft = await distillSkillFromTraces(traces, "churn_analysis", baseOpts(store));
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe("quarantine");
    expect(draft!.taskType).toBe("churn_analysis");
    expect(draft!.triggeredBy).toContain("tool_call_threshold");
    expect(draft!.id).toBe("draft-fixed");
  });

  it("persists the draft to the quarantine store", async () => {
    const store = new InMemorySkillDraftStore();
    const traces = [trace({ toolCallCount: 5 })];
    await distillSkillFromTraces(traces, "churn_analysis", baseOpts(store));
    const stored = await store.readQuarantine("c1", "churn_analysis");
    expect(stored).toBeDefined();
    expect(stored).toContain("churn_analysis");
  });

  it("writes an audit log entry", async () => {
    const auditLog = vi.fn().mockResolvedValue(undefined);
    const store = new InMemorySkillDraftStore();
    const traces = [trace({ toolCallCount: 5 })];
    await distillSkillFromTraces(traces, "churn_analysis", { ...baseOpts(store), auditLog });
    expect(auditLog).toHaveBeenCalledWith(
      "c1",
      "agent",
      "skill.distilled",
      "skill_draft",
      "draft-fixed",
      expect.stringContaining("churn_analysis"),
    );
  });

  it("uses 'edit' action when a quarantine draft already exists", async () => {
    const store = new InMemorySkillDraftStore();
    await store.writeQuarantine("c1", "churn_analysis", "---\nname: existing\n---\n## Steps\n1. old step");
    const traces = [trace({ toolCallCount: 5 })];
    const draft = await distillSkillFromTraces(traces, "churn_analysis", baseOpts(store));
    expect(draft!.action).toBe("edit");
  });

  it("uses 'create' action for a new task type", async () => {
    const store = new InMemorySkillDraftStore();
    const traces = [trace({ toolCallCount: 5, taskType: "new_task" })];
    const draft = await distillSkillFromTraces(traces, "new_task", baseOpts(store));
    expect(draft!.action).toBe("create");
  });

  it("supports InMemorySkillDraftStore promote()", async () => {
    const store = new InMemorySkillDraftStore();
    const traces = [trace({ toolCallCount: 5 })];
    await distillSkillFromTraces(traces, "churn_analysis", baseOpts(store));
    await store.promote("c1", "churn_analysis");
    const live = await store.readLive("c1", "churn_analysis");
    expect(live).toBeDefined();
  });
});
