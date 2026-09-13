/**
 * The fleet-memory contract, offline and deterministic: every seat shares one company memory,
 * recalls what ANY other seat produced, searches the whole company's session history, and sees
 * the org skill tier. No model, no network, no clock.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryImproveStore } from "../improve/memory-store.js";
import { ORG_TIER_AGENT } from "../improve/org-tier.js";
import type { SkillDraftRow } from "../store/StorePort.js";
import { createMemoryAdapter } from "../tools/memory/index.js";
import { DEFAULT_FLEET_MEMORY_CONFIG, type FleetMemoryConfig } from "./config.js";
import { createFleetMemoryHook } from "./orchestrator-hook.js";
import { recallForObjective } from "./recall.js";
import { createFleetSearchAdapter } from "./search.js";
import { listSharedSkills, renderSharedSkillsIndex } from "./shared-skills.js";
import { InMemoryFleetSource, type FleetRun } from "./source.js";

const COMPANY = "co_fleet";

function run(id: string, objective: string, steps: Array<{ role: string; title: string; output: string }>, summary = ""): FleetRun {
  return {
    id,
    companyId: COMPANY,
    objective,
    status: "completed",
    summary: summary || null,
    completedAt: `2026-09-12T10:00:0${id.length % 10}.000Z`,
    steps: steps.map((s, i) => ({
      id: `${id}-s${i + 1}`,
      runId: id,
      agentRole: s.role,
      title: s.title,
      status: "completed",
      output: s.output,
    })),
  };
}

function skill(id: string, agentId: string, taskType: string, content: string, status: SkillDraftRow["status"] = "live"): SkillDraftRow {
  return {
    id, companyId: COMPANY, agentId, taskType, kind: "skill", status, content, contentHash: `h_${id}`,
    triggers: [], createdAt: "2026-09-12T09:00:00.000Z", promotedAt: status === "live" ? "2026-09-12T09:30:00.000Z" : null,
    lastUsedAt: null, retiredAt: null,
  };
}

const CHURN_OUTPUT =
  "Churn cohorts: signup-month cohorts show 12% month-3 churn for self-serve and 4% for sales-led. " +
  "The self-serve drop is concentrated in accounts that never invited a second user.";
const HIRING_OUTPUT = "Q3 hiring plan: two backend engineers and one designer, interviews start in August.";

function seededSource(): InMemoryFleetSource {
  const improve = new InMemoryImproveStore();
  const source = new InMemoryFleetSource({ improve });
  source.addRun(run("run_churn", "analyze churn cohorts by signup month", [{ role: "analyst", title: "Build churn cohort table", output: CHURN_OUTPUT }], "Consolidated: churn is a second-user problem."));
  source.addRun(run("run_hiring", "draft the Q3 hiring plan", [{ role: "ceo", title: "Draft hiring plan", output: HIRING_OUTPUT }], "Consolidated: hiring plan drafted."));
  return source;
}

describe("cross-agent recall (requirement 2)", () => {
  it("a growth run about churn gets the analyst's churn output in its recall block, within budget", async () => {
    const source = seededSource();
    const result = await recallForObjective(source, {
      companyId: COMPANY,
      seat: "growth",
      objective: "design a growth experiment to reduce churn in self-serve cohorts",
    });
    expect(result.block).toContain("analyst");
    expect(result.block).toContain("second user");
    expect(result.block).not.toContain("hiring");
    expect(result.chars).toBeLessThanOrEqual(DEFAULT_FLEET_MEMORY_CONFIG.recallBudgetChars);
    expect(result.items.map((i) => i.agentId)).toContain("analyst");
  });

  it("an unrelated run recalls nothing from the churn work", async () => {
    const source = seededSource();
    const result = await recallForObjective(source, { companyId: COMPANY, seat: "finance", objective: "reconcile the September invoices" });
    expect(result.block).not.toContain("churn");
    expect(result.items).toHaveLength(0);
  });

  it("the budget is a hard character ceiling and is configurable", async () => {
    const source = seededSource();
    for (let i = 0; i < 30; i += 1) {
      source.addRun(run(`run_more_${i}`, `churn cohorts pass ${i}`, [{ role: "analyst", title: `Churn cohorts pass ${i}`, output: `${CHURN_OUTPUT} pass ${i}` }]));
    }
    const config: FleetMemoryConfig = { ...DEFAULT_FLEET_MEMORY_CONFIG, recallBudgetChars: 700 };
    const result = await recallForObjective(source, { companyId: COMPANY, seat: "growth", objective: "reduce churn cohorts", config });
    expect(result.chars).toBeLessThanOrEqual(700);
    expect(result.block.length).toBeLessThanOrEqual(700);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.dropped).toBeGreaterThan(0);
  });

  it("is deterministic: the same inputs render the same block", async () => {
    const source = seededSource();
    const a = await recallForObjective(source, { companyId: COMPANY, seat: "growth", objective: "churn cohorts" });
    const b = await recallForObjective(source, { companyId: COMPANY, seat: "growth", objective: "churn cohorts" });
    expect(a.block).toBe(b.block);
  });
});

describe("fleet-wide session search (requirement 3)", () => {
  it("a query matching another agent's output returns it tagged with the producing agent", async () => {
    const source = seededSource();
    const tool = createFleetSearchAdapter({ source });
    const rec = await tool.execute('fleet_search {"query":"self-serve churn second user","limit":3}', { companyId: COMPANY });
    expect(rec.status).toBe("completed");
    expect(rec.summary).toContain("[analyst]");
    expect(rec.summary).toContain("run_churn");
    expect(rec.summary).toContain("second user");
    expect(rec.summary).not.toContain("hiring");
  });

  it("includes delegated child steps, tagged as such, and consolidated run summaries", async () => {
    const source = seededSource();
    source.addRun(run("run_deleg", "support triage", [{ role: "support", title: "[delegated] summarize refund policy", output: "Refund policy: 30 days, no questions asked." }]));
    const tool = createFleetSearchAdapter({ source });
    const rec = await tool.execute('fleet_search {"query":"refund policy"}', { companyId: COMPANY });
    expect(rec.summary).toContain("[support, delegated]");
    const summary = await tool.execute('fleet_search {"query":"second-user problem"}', { companyId: COMPANY });
    expect(summary.summary).toContain("consolidated");
  });

  it("requires a query and honours the limit", async () => {
    const source = seededSource();
    const tool = createFleetSearchAdapter({ source });
    expect((await tool.execute("fleet_search {}", { companyId: COMPANY })).status).toBe("failed");
    const rec = await tool.execute('fleet_search {"query":"churn","limit":1}', { companyId: COMPANY });
    expect(rec.summary.split("\n").filter((l) => l.startsWith("- ")).length).toBe(1);
  });
});

describe("shared skills visibility (requirement 4)", () => {
  it("a skill promoted to org tier by the engineer is listed for the finance seat", async () => {
    const improve = new InMemoryImproveStore();
    await improve.createDraft(skill("sk_org", ORG_TIER_AGENT, "ship-feature", "# Ship a feature\nOpen a PR with tests first."));
    await improve.createDraft(skill("sk_fin", "finance", "close-books", "# Close the books\nReconcile before reporting."));
    await improve.createDraft(skill("sk_eng_private", "engineer", "triage-bug", "# Triage\nEngineer-only draft.", "quarantine"));
    const listed = await listSharedSkills(improve, COMPANY, "finance");
    expect(listed.map((s) => [s.id, s.tier])).toEqual([["sk_org", "org"], ["sk_fin", "own"]]);
    const index = renderSharedSkillsIndex(listed);
    expect(index).toContain("ship-feature");
    expect(index).toContain("[org]");
    expect(index).not.toContain("triage-bug");
  });

  it("a seat can view an org-tier skill another agent earned through fleet_skill_view", async () => {
    const improve = new InMemoryImproveStore();
    await improve.createDraft(skill("sk_org", ORG_TIER_AGENT, "ship-feature", "# Ship a feature\nOpen a PR with tests first."));
    const source = new InMemoryFleetSource({ improve });
    const tool = createFleetSearchAdapter({ source, seat: () => "finance" });
    const rec = await tool.execute('fleet_skill_view {"skill":"ship-feature"}', { companyId: COMPANY });
    expect(rec.status).toBe("completed");
    expect(rec.summary).toContain("tests first");
    expect((await tool.execute('fleet_skill_view {"skill":"nope"}', { companyId: COMPANY })).status).toBe("failed");
  });
});

describe("the orchestrator hook: one prelude per run, shared by every seat (requirements 1, 2, 5)", () => {
  let profileDir: string;
  beforeEach(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-fleet-"));
  });

  type Input = { companyId: string; subtask: { id: string; seat: string; objective: string; contextBundle?: { overallObjective?: string } }; dynamicPrompt?: string };

  it("a fact the engineer writes in run 1 is in the support seat's prelude in run 2, not in run 1", async () => {
    const source = seededSource();
    const memory = createMemoryAdapter({ profileDir });
    const hook = createFleetMemoryHook({ source, memory });
    const seen: string[] = [];
    const seat = hook.wrapSeatModel(async (input: Input) => {
      seen.push(input.dynamicPrompt ?? "");
      return { output: {}, model: "m", tokens: 0, costCents: 0, fallback: false };
    });

    // Run 1: the engineer writes a fact mid-run.
    hook.runStarted({ runId: "r1", companyId: COMPANY, objective: "ship the billing webhook" });
    await seat({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: "ship the billing webhook" } });
    expect((await memory.execute('memory {"target":"memory","action":"add","content":"Stripe webhooks must be idempotent by event id."}', { companyId: COMPANY })).status).toBe("completed");
    await seat({ companyId: COMPANY, subtask: { id: "s2", seat: "support", objective: "ship the billing webhook" } });
    hook.runFinished("r1");
    // The pipeline persists run 1's step outputs; the source now serves them like any other run.
    source.addRun(run("r1", "ship the billing webhook", [{ role: "engineer", title: "Ship webhook", output: "Webhook handler verifies the Stripe signature and retries on 5xx." }]));

    // Run 2: a different seat, a different objective.
    hook.runStarted({ runId: "r2", companyId: COMPANY, objective: "answer the customer's webhook question" });
    await seat({ companyId: COMPANY, subtask: { id: "s3", seat: "support", objective: "answer the customer's webhook question" }, dynamicPrompt: "Previous step outputs:\nnone" });

    expect(seen[0]).toContain("MEMORY.md");
    expect(seen[0]).not.toContain("idempotent");
    expect(seen[1]).not.toContain("idempotent"); // frozen for the run
    expect(seen[2]).toContain("idempotent");
    expect(seen[2]).toContain("Previous step outputs"); // the pipeline's own dynamic prompt survives
    expect(seen[2]).toContain("Fleet recall");
    expect(seen[2]).toContain("[engineer | Ship webhook");
    expect(seen[2]).toContain("Stripe signature");
  });

  it("a delegated child reads the shared memory but cannot write it", async () => {
    const source = seededSource();
    const memory = createMemoryAdapter({ profileDir });
    const hook = createFleetMemoryHook({ source, memory });
    fs.mkdirSync(path.join(profileDir, "memories"), { recursive: true });
    fs.writeFileSync(path.join(profileDir, "memories", "MEMORY.md"), "Parent fact.");
    let prelude = "";
    const seat = hook.wrapSeatModel(async (input: Input) => {
      prelude = input.dynamicPrompt ?? "";
      return { output: {}, model: "m", tokens: 0, costCents: 0, fallback: false };
    });
    hook.runStarted({ runId: "r1", companyId: COMPANY, objective: "x" });
    await seat({ companyId: COMPANY, subtask: { id: "d1", seat: "support", objective: "[delegated] summarize policy: Handle delegated capability" } });
    expect(prelude).toContain("Parent fact.");
    const rec = await memory.execute('memory {"target":"memory","action":"add","content":"child fact"}', { companyId: COMPANY });
    expect(rec.status).toBe("blocked");
    expect(fs.readFileSync(path.join(profileDir, "memories", "MEMORY.md"), "utf8")).toBe("Parent fact.");
    // The parent's next step can write again.
    await seat({ companyId: COMPANY, subtask: { id: "p1", seat: "engineer", objective: "ship it" } });
    expect((await memory.execute('memory {"target":"memory","action":"add","content":"parent fact 2"}', { companyId: COMPANY })).status).toBe("completed");
  });

  it("the prelude is frozen per run: the same text for every seat call in the run", async () => {
    const source = seededSource();
    const hook = createFleetMemoryHook({ source, memory: createMemoryAdapter({ profileDir }) });
    const seen: string[] = [];
    const seat = hook.wrapSeatModel(async (input: Input) => {
      seen.push(input.dynamicPrompt ?? "");
      return { output: {}, model: "m", tokens: 0, costCents: 0, fallback: false };
    });
    hook.runStarted({ runId: "r1", companyId: COMPANY, objective: "reduce churn in self-serve cohorts" });
    await seat({ companyId: COMPANY, subtask: { id: "a", seat: "growth", objective: "reduce churn in self-serve cohorts" } });
    source.addRun(run("run_late", "churn cohorts again", [{ role: "analyst", title: "Late churn note", output: "LATE churn cohorts finding" }]));
    await seat({ companyId: COMPANY, subtask: { id: "b", seat: "content", objective: "reduce churn in self-serve cohorts" } });
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toContain("second user");
    expect(seen[0]).not.toContain("LATE");
    expect(hook.preludeFor("r1")).toBe(seen[0]);
  });

  it("exposes the memory and fleet_search adapters for seat wiring", () => {
    const hook = createFleetMemoryHook({ source: seededSource(), memory: createMemoryAdapter({ profileDir }) });
    expect(hook.adapters.map((a) => a.name).sort()).toEqual(["fleet_search", "memory"]);
  });
});
