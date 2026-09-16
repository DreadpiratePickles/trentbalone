/**
 * T4.1 — versioned agent definitions: candidate -> live with the previous live archived, a ledger
 * iteration per promote so `rollback` flips the labels back, and immutability of an archived row.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { contentHash } from "../improve/ledger.js";
import { InMemoryImproveStore } from "../improve/memory-store.js";
import { rollback } from "../improve/lifecycle.js";
import type { AgentDefinition } from "../store/StorePort.js";
import { createAgentVersions, type AgentDefinitionSource } from "./AgentVersions.js";
import { createProfileDefinitionSource } from "./agent-definition.js";

const COMPANY = "co_versions";

function definitionSource(prompts: Record<string, string>): AgentDefinitionSource & { prompts: Record<string, string> } {
  return {
    prompts,
    async definition(agentId): Promise<AgentDefinition> {
      return {
        prompt: prompts[agentId] ?? `You are ${agentId}.`,
        model: { provider: "anthropic", model: "claude-sonnet-4-5" },
        toolsets: ["file_ops", "terminal"],
        skills: [{ slug: "repo-audit", content: "# Repository Audit\n> Map the codebase.\n\nList every package." }],
      };
    },
  };
}

describe("AgentVersions", () => {
  it("createCandidate snapshots the definition with monotonic versions; promote makes it live and archives the prior", async () => {
    const store = new InMemoryImproveStore();
    const source = definitionSource({ engineer: "You are the engineer, v1." });
    const versions = createAgentVersions({ store, companyId: COMPANY, source, now: () => "2026-09-15T10:00:00.000Z" });

    const v1 = await versions.createCandidate("engineer");
    expect(v1.version).toBe(1);
    expect(v1.label).toBe("candidate");
    expect(v1.toolsets).toEqual(["file_ops", "terminal"]);
    expect(v1.promptHash).toHaveLength(64);
    expect(await versions.liveVersion("engineer")).toBeUndefined();

    const promoted = await versions.promote("engineer", 1, { actor: "human" });
    expect(promoted.version.label).toBe("live");
    expect((await versions.liveVersion("engineer"))?.id).toBe(v1.id);

    source.prompts.engineer = "You are the engineer, v2.";
    const v2 = await versions.createCandidate("engineer");
    expect(v2.version).toBe(2);
    expect(v2.promptHash).not.toBe(v1.promptHash);
    const second = await versions.promote("engineer", 2, { actor: "human" });
    expect((await versions.liveVersion("engineer"))?.id).toBe(v2.id);
    expect((await store.getAgentVersion(v1.id))?.label).toBe("archived");

    // The ledger carries the flip as version ids, and the iteration is kind "agent".
    const iteration = await store.getIteration(second.iterationId);
    expect(iteration?.candidateKind).toBe("agent");
    expect(iteration?.candidateId).toBe(v2.id);
    const [row] = await store.listLedger(COMPANY, { iterationId: second.iterationId });
    expect(row?.action).toBe("fix");
    expect(row?.before).toBe(v1.id);
    expect(row?.after).toBe(v2.id);

    const listed = await versions.list("engineer");
    expect(listed.map((v) => [v.version, v.label])).toEqual([
      [2, "live"],
      [1, "archived"],
    ]);
  });

  it("rollback(iterationId) restores the previous live version and archives the promoted one", async () => {
    const store = new InMemoryImproveStore();
    const source = definitionSource({ engineer: "v1" });
    const versions = createAgentVersions({ store, companyId: COMPANY, source });
    const v1 = await versions.createCandidate("engineer");
    await versions.promote("engineer", 1, { actor: "human" });
    source.prompts.engineer = "v2";
    const v2 = await versions.createCandidate("engineer");
    const { iterationId } = await versions.promote("engineer", 2, { actor: "human" });

    const report = await rollback(store, iterationId, "human");
    expect(report.restored).toEqual([{ artifactId: v1.id, taskType: "definition" }]);
    expect((await versions.liveVersion("engineer"))?.id).toBe(v1.id);
    expect((await store.getAgentVersion(v2.id))?.label).toBe("archived");
    // No draft row was invented for an agent version.
    expect(await store.listDrafts(COMPANY)).toEqual([]);
    const actions = (await store.listLedger(COMPANY, { iterationId })).map((r) => r.action);
    expect(actions).toEqual(["fix", "rollback"]);
  });

  it("rollback(agentId) finds the latest promotion of that agent on its own", async () => {
    const store = new InMemoryImproveStore();
    const source = definitionSource({ growth: "g1" });
    const versions = createAgentVersions({ store, companyId: COMPANY, source });
    await versions.createCandidate("growth");
    await versions.promote("growth", 1, { actor: "human" });
    source.prompts.growth = "g2";
    await versions.createCandidate("growth");
    await versions.promote("growth", 2, { actor: "human" });

    const report = await versions.rollback("growth", { actor: "human" });
    expect(report.restored).toHaveLength(1);
    expect((await versions.liveVersion("growth"))?.version).toBe(1);
    await expect(versions.rollback("growth", { actor: "human" })).rejects.toThrow(/nothing to roll back/);
  });

  it("versions are immutable: an archived version is refused, a live one is a no-op, an unknown one is an error, and only a human promotes", async () => {
    const store = new InMemoryImproveStore();
    const source = definitionSource({ engineer: "v1" });
    const versions = createAgentVersions({ store, companyId: COMPANY, source });
    await versions.createCandidate("engineer");
    await versions.promote("engineer", 1, { actor: "human" });
    source.prompts.engineer = "v2";
    await versions.createCandidate("engineer");
    await versions.promote("engineer", 2, { actor: "human" });

    await expect(versions.promote("engineer", 1, { actor: "human" })).rejects.toThrow(/archived/);
    const again = await versions.promote("engineer", 2, { actor: "human" });
    expect(again.version.label).toBe("live");
    expect(again.iterationId).toBe("");
    await expect(versions.promote("engineer", 9, { actor: "human" })).rejects.toThrow(/no version 9/);
    await expect(versions.promote("engineer", 2, { actor: "sweep" })).rejects.toThrow(/human/);
    expect((await versions.list("engineer")).map((v) => v.label)).toEqual(["live", "archived"]);
  });
});

describe("profile definition source", () => {
  it("reads toolsets and installed skill files from the record, adds the agent's live improve skills, and refuses an unknown agent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-profile-"));
    try {
      const agentsDir = path.join(root, "agents");
      const skillsDir = path.join(root, "skills");
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.mkdirSync(skillsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, "eng-ai-engineer.json"), JSON.stringify({ id: "eng-ai-engineer", tools: [{ name: "GitHub", purpose: "" }, { name: "terminal", purpose: "" }], installed_skills: ["repo-audit", "missing"] }));
      fs.writeFileSync(path.join(skillsDir, "repo-audit.md"), "# Repository Audit\n> Map it.\n\nList packages.");
      const store = new InMemoryImproveStore();
      await store.createDraft({
        id: "d_live",
        companyId: COMPANY,
        agentId: "eng-ai-engineer",
        taskType: "ship-feature",
        kind: "skill",
        status: "live",
        content: "# ship-feature\nRun tests first.",
        contentHash: contentHash("# ship-feature\nRun tests first."),
        triggers: [],
        createdAt: "2026-09-15T00:00:00.000Z",
        promotedAt: "2026-09-15T00:00:00.000Z",
        lastUsedAt: null,
        retiredAt: null,
      });
      const source = createProfileDefinitionSource({
        agentsDir,
        skillsDir,
        store,
        companyId: COMPANY,
        model: { provider: "anthropic", model: "claude-sonnet-4-5" },
        prompt: async (agentId) => `prompt for ${agentId}`,
      });
      const definition = await source.definition("eng-ai-engineer");
      expect(definition.prompt).toBe("prompt for eng-ai-engineer");
      expect(definition.toolsets).toEqual(["GitHub", "terminal"]);
      expect(definition.skills.map((s) => s.slug)).toEqual(["repo-audit", "ship-feature"]);
      expect(definition.skills[0]?.content).toContain("List packages");

      // A core seat needs no record; an unknown id is refused.
      expect((await source.definition("engineer")).toolsets).toEqual(["file_ops", "terminal"]);
      await expect(source.definition("nobody")).rejects.toThrow(/not installed/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
