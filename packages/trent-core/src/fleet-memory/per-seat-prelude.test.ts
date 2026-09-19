/**
 * The prelude in three tiers, per seat.
 *
 * Before this, `orchestrator-hook.ts` memoised the WHOLE prelude with the first seat's scope, so
 * every later seat of a run was handed the first seat's recall and the first seat's skills
 * (`fleet-memory.test.ts`, "the prelude is frozen per run"). The freeze was the right idea for the
 * wrong slice: what has to be byte-stable is the tier a provider could cache, not the tier that
 * answers "what does THIS seat need".
 *
 * So: one STABLE part per run — and byte-identical across runs of the same profile — plus one
 * CONTEXT part per (run, seat), plus a VOLATILE part carrying the transcript and the personality
 * suffix. The source is still frozen for the run, so a seat that calls later does not silently see
 * newer runs than the seat that called first.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryImproveStore } from "../improve/memory-store.js";
import { ORG_TIER_AGENT } from "../improve/org-tier.js";
import type { SkillDraftRow } from "../store/StorePort.js";
import { createMemoryAdapter } from "../tools/memory/index.js";
import { createFleetMemoryHook, type ContextNotice } from "./orchestrator-hook.js";
import { InMemoryFleetSource, type FleetRun } from "./source.js";
import { CONTEXT_BLOCKS } from "./tiers.js";

const COMPANY = "co_tiers";
let profileDir = "";

type Input = { companyId: string; subtask: { id: string; seat: string; objective: string }; dynamicPrompt?: string };

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-tiers-"));
  fs.mkdirSync(path.join(profileDir, "memories"), { recursive: true });
  fs.writeFileSync(path.join(profileDir, "memories", "MEMORY.md"), "The company bills in integer cents.");
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function skill(id: string, agentId: string, taskType: string, content: string): SkillDraftRow {
  return {
    id, companyId: COMPANY, agentId, taskType, kind: "skill", status: "live", content, contentHash: `h_${id}`,
    triggers: [], createdAt: "2026-09-12T09:00:00.000Z", promotedAt: "2026-09-12T09:30:00.000Z",
    lastUsedAt: null, retiredAt: null,
  };
}

function run(id: string, objective: string, role: string, title: string, output: string): FleetRun {
  return {
    id, companyId: COMPANY, objective, status: "completed", summary: null, completedAt: "2026-09-12T10:00:00.000Z",
    steps: [{ id: `${id}-s1`, runId: id, agentRole: role, title, status: "completed", output }],
  };
}

interface HarnessOptions {
  improve?: InMemoryImproveStore;
  personalitySuffix?: string;
  ceilingChars?: number;
  workspaceContext?: string;
  onNotice?: (notice: ContextNotice) => void;
}

function harness(options: HarnessOptions = {}) {
  const source = new InMemoryFleetSource(options.improve ? { improve: options.improve } : {});
  const hook = createFleetMemoryHook({
    source,
    memory: createMemoryAdapter({ profileDir }),
    ...(options.personalitySuffix === undefined ? {} : { personalitySuffix: options.personalitySuffix }),
    ...(options.ceilingChars === undefined ? {} : { ceilingChars: options.ceilingChars }),
    ...(options.workspaceContext === undefined ? {} : { workspaceContext: options.workspaceContext }),
    ...(options.onNotice === undefined ? {} : { onNotice: options.onNotice }),
  });
  const seen: string[] = [];
  const seat = hook.wrapSeatModel(async (input: Input) => {
    seen.push(input.dynamicPrompt ?? "");
    return { output: {}, model: "m", tokens: 0, costCents: 0, fallback: false };
  });
  return { source, hook, seat, seen };
}

describe("the per-seat, three-tier prelude", () => {
  it("gives each seat of one run its OWN recall and its OWN skills index", async () => {
    const improve = new InMemoryImproveStore();
    await improve.createDraft(skill("s_eng", "engineer", "webhooks", "# Verify the Stripe signature before anything else"));
    await improve.createDraft(skill("s_sup", "support", "refunds", "# Refund policy: 30 days, no questions"));
    await improve.createDraft(skill("s_org", ORG_TIER_AGENT, "shared", "# Every seat cites its sources"));
    const { hook, seat, seen } = harness({ improve });

    hook.runStarted({ runId: "r1", companyId: COMPANY, objective: "handle the refund webhook" });
    await seat({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: "handle the refund webhook" } });
    await seat({ companyId: COMPANY, subtask: { id: "s2", seat: "support", objective: "handle the refund webhook" } });

    expect(seen[0]).toContain("webhooks [own]");
    expect(seen[0]).not.toContain("refunds [own]");
    expect(seen[1]).toContain("refunds [own]");
    expect(seen[1]).not.toContain("webhooks [own]");
    // The org tier is shared, so it belongs to the stable tier both seats get byte-identically.
    expect(hook.stablePreludeFor("r1")).toContain("shared [org]");
    expect(seen[0]).toContain("shared [org]");
    expect(seen[1]).toContain("shared [org]");
  });

  it("keeps the stable tier byte-identical across two consecutive runs of the same profile", async () => {
    const { hook, seat } = harness();
    hook.runStarted({ runId: "r1", companyId: COMPANY, objective: "reduce churn in self-serve cohorts" });
    await seat({ companyId: COMPANY, subtask: { id: "s1", seat: "growth", objective: "reduce churn in self-serve cohorts" } });
    hook.runFinished("r1");

    hook.runStarted({ runId: "r2", companyId: COMPANY, objective: "a completely different objective about hiring" });
    await seat({ companyId: COMPANY, subtask: { id: "s2", seat: "ceo", objective: "a completely different objective about hiring" } });
    hook.runFinished("r2");

    expect(hook.stablePreludeFor("r1")).toBe(hook.stablePreludeFor("r2"));
    expect(hook.stablePreludeFor("r1")).toContain("integer cents");
  });

  it("freezes the SOURCE for the run, so a later seat does not see runs the first seat could not", async () => {
    const { source, hook, seat, seen } = harness();
    hook.runStarted({ runId: "r1", companyId: COMPANY, objective: "churn cohorts by signup month" });
    await seat({ companyId: COMPANY, subtask: { id: "a", seat: "growth", objective: "churn cohorts by signup month" } });
    source.addRun(run("run_late", "churn cohorts again", "analyst", "Late churn note", "LATE churn cohorts finding"));
    await seat({ companyId: COMPANY, subtask: { id: "b", seat: "content", objective: "churn cohorts by signup month" } });
    expect(seen[1]).not.toContain("LATE");
  });

  it("appends the personality suffix to the VOLATILE tier, after the prelude, and nowhere when inactive", async () => {
    const suffix = "Tone stance: speak like a seasoned pirate captain.";
    const active = harness({ personalitySuffix: suffix });
    active.hook.runStarted({ runId: "r1", companyId: COMPANY, objective: "ship it" });
    await active.seat({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: "ship it" } });
    const prompt = active.seen[0] ?? "";
    expect(prompt).toContain(suffix);
    expect(prompt.indexOf(suffix)).toBeGreaterThan(prompt.indexOf("integer cents"));
    expect(prompt.trimEnd().endsWith(suffix)).toBe(true);

    const off = harness();
    off.hook.runStarted({ runId: "r2", companyId: COMPANY, objective: "ship it" });
    await off.seat({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: "ship it" } });
    expect(off.seen[0]).not.toContain("Tone stance");
  });

  it("puts the workspace-context seam in the stable tier without loading a single file", async () => {
    const { hook, seat, seen } = harness({ workspaceContext: "AGENTS.md: apps/web is read only." });
    hook.runStarted({ runId: "r1", companyId: COMPANY, objective: "ship it" });
    await seat({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: "ship it" } });
    expect(hook.stablePreludeFor("r1")).toContain("apps/web is read only.");
    expect(seen[0]).toContain("apps/web is read only.");
    expect(hook.contextFor("r1", "engineer")?.kept.map((b) => b.name)).toContain(CONTEXT_BLOCKS.workspace);
  });

  it("trims the context and volatile tiers to the ceiling and never the stable tier", async () => {
    const { hook, seat, seen } = harness({ ceilingChars: 200, personalitySuffix: "Tone stance: be direct." });
    hook.runStarted({
      runId: "r1",
      companyId: COMPANY,
      objective: "ship it",
      history: [{ role: "user", content: "H".repeat(4000) }],
    });
    await seat({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: "ship it" } });
    const assembled = hook.contextFor("r1", "engineer");
    expect(assembled?.dropped).toContain(CONTEXT_BLOCKS.conversation);
    expect(seen[0]).toContain("integer cents");
    expect(seen[0]).not.toContain("H".repeat(4000));
  });

  it("emits ONE context-pressure notice per run once the injection passes 80 percent of the ceiling", async () => {
    const notices: ContextNotice[] = [];
    const { hook, seat } = harness({ ceilingChars: 120, onNotice: (n) => notices.push(n) });
    hook.runStarted({ runId: "r1", companyId: COMPANY, objective: "ship it" });
    await seat({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: "ship it" } });
    await seat({ companyId: COMPANY, subtask: { id: "s2", seat: "support", objective: "ship it" } });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.runId).toBe("r1");
    expect(notices[0]?.kind).toBe("context_pressure");
    expect(notices[0]?.ceilingChars).toBe(120);
    expect(notices[0]?.detail).toContain("120");
  });

  it("stays silent while the injection is under the warning ratio", async () => {
    const notices: ContextNotice[] = [];
    const { hook, seat } = harness({ ceilingChars: 100_000, onNotice: (n) => notices.push(n) });
    hook.runStarted({ runId: "r1", companyId: COMPANY, objective: "ship it" });
    await seat({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: "ship it" } });
    expect(notices).toHaveLength(0);
  });
});
