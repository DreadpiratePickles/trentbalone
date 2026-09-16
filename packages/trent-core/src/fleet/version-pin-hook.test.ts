/**
 * T4.1 — run pinning: at `run_start` every live agent version is snapshotted into the run, and a
 * promote while the run is in flight changes neither the pinned ids nor the frozen skills view.
 */
import { describe, expect, it } from "vitest";

import { InMemoryImproveStore } from "../improve/memory-store.js";
import type { OrcEvent } from "../orchestrator/types.js";
import type { AgentDefinition } from "../store/StorePort.js";
import { createAgentVersions, type AgentDefinitionSource } from "./AgentVersions.js";
import { createVersionPinHook } from "./version-pin-hook.js";

const COMPANY = "co_pin";

function source(): AgentDefinitionSource & { skills: Record<string, string> } {
  const skills: Record<string, string> = { engineer: "# Ship v1\n\nRun the tests first." };
  return {
    skills,
    async definition(agentId): Promise<AgentDefinition> {
      return {
        prompt: `You are ${agentId}.`,
        model: { provider: "anthropic", model: "claude-sonnet-4-5" },
        toolsets: ["file_ops"],
        skills: [{ slug: "ship", content: skills[agentId] ?? "" }],
      };
    },
  };
}

function runStart(runId: string, at: string): OrcEvent {
  return { kind: "run_start", runId, at, run: { id: runId, companyId: COMPANY, objective: "ship the feature", status: "running", steps: [], startedAt: at, trigger: "manual" } };
}

describe("version pin hook", () => {
  it("pins the live version ids at run_start; a promote during the run leaves the snapshot and the frozen skills on v1", async () => {
    const store = new InMemoryImproveStore();
    const src = source();
    const versions = createAgentVersions({ store, companyId: COMPANY, source: src });
    const v1 = await versions.createCandidate("engineer");
    await versions.promote("engineer", 1, { actor: "human" });

    const hook = createVersionPinHook({ store });
    hook.sink(runStart("run_1", "2026-09-15T10:00:00.000Z"));
    await hook.flush();
    expect(hook.pinnedFor("run_1")).toEqual({ engineer: v1.id });
    expect(hook.frozenSkillsFor("run_1", "engineer")).toEqual([{ slug: "ship", content: "# Ship v1\n\nRun the tests first." }]);

    // The founder promotes v2 while run_1 is still going.
    src.skills.engineer = "# Ship v2\n\nSkip the tests.";
    const v2 = await versions.createCandidate("engineer");
    await versions.promote("engineer", 2, { actor: "human" });
    expect((await versions.liveVersion("engineer"))?.id).toBe(v2.id);

    expect(hook.pinnedFor("run_1")).toEqual({ engineer: v1.id });
    expect(hook.frozenSkillsFor("run_1", "engineer")?.[0]?.content).toContain("v1");
    expect(hook.frozenSkillsFor("run_1", "growth")).toBeUndefined();

    // The next run starts on v2.
    hook.sink(runStart("run_2", "2026-09-15T10:05:00.000Z"));
    await hook.flush();
    expect(hook.pinnedFor("run_2")).toEqual({ engineer: v2.id });
    expect(hook.frozenSkillsFor("run_2", "engineer")?.[0]?.content).toContain("v2");
  });

  it("a run whose event carries no company, or a company with no live versions, pins nothing and never throws", async () => {
    const store = new InMemoryImproveStore();
    const errors: string[] = [];
    const hook = createVersionPinHook({ store, onError: (m) => errors.push(m) });
    hook.sink({ kind: "run_start", runId: "run_x", at: "2026-09-15T10:00:00.000Z" });
    hook.sink(runStart("run_y", "2026-09-15T10:00:00.000Z"));
    hook.sink({ kind: "step_end", runId: "run_y", at: "2026-09-15T10:00:01.000Z" });
    await hook.flush();
    expect(hook.pinnedFor("run_x")).toBeUndefined();
    expect(hook.pinnedFor("run_y")).toEqual({});
    expect(errors).toEqual([]);
  });

  it("reports a failed snapshot through onError and leaves the run unpinned", async () => {
    const store = new InMemoryImproveStore();
    store.listAgentVersions = async () => {
      throw new Error("disk gone");
    };
    const errors: string[] = [];
    const hook = createVersionPinHook({ store, onError: (m) => errors.push(m) });
    hook.sink(runStart("run_z", "2026-09-15T10:00:00.000Z"));
    await hook.flush();
    expect(hook.pinnedFor("run_z")).toBeUndefined();
    expect(errors).toEqual(["version pin for run run_z failed: disk gone"]);
  });
});
