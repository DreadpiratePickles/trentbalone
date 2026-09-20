/**
 * U5 — `agent.json` carries the FULL seat record (research 5: it carried neither approval gates,
 * budget, model tier nor eval suite id), a skill's bundle directories travel with it (`scripts/`
 * and `tools/` were dropped), and `fleet import` puts the record back as it was exported.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { InMemoryImproveStore } from "../improve/memory-store.js";
import { writeSkillRecord } from "../skills/skill-store.js";
import type { AgentDefinition } from "../store/StorePort.js";
import { createAgentVersions, type AgentDefinitionSource } from "./AgentVersions.js";
import { exportAgent, importAgent, type AgentBundle } from "./export.js";
import { seatCapability } from "./seat-capabilities.js";

const dirs: string[] = [];
const tmp = (label: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `trent-${label}-`));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function source(): AgentDefinitionSource {
  return {
    async definition(agentId): Promise<AgentDefinition> {
      return {
        prompt: `You are ${agentId}.`,
        model: { provider: "anthropic", model: "claude-sonnet-4-5" },
        toolsets: ["file_ops", "terminal"],
        skills: [{ slug: "repo-audit", content: "# Repository Audit\n> Map the codebase.\n\nRun scripts/audit.sh first." }],
      };
    },
  };
}

describe("agent.json carries the seat record", () => {
  it("writes toolsets, denied, approval gates, budget cents, model tier, eval suite id and the hashes for a seat", async () => {
    const versions = createAgentVersions({ store: new InMemoryImproveStore(), companyId: "co", source: source() });
    const out = tmp("seat-record");
    await exportAgent({ versions, agentId: "engineer", dir: out });
    const bundle = JSON.parse(fs.readFileSync(path.join(out, "agent.json"), "utf8")) as AgentBundle;
    const seat = seatCapability("engineer");
    expect(bundle.seat).toEqual({
      name: seat.name,
      toolsets: [...seat.toolsets],
      denied: [...seat.denied],
      approvalGates: [...seat.approvalGates],
      budgetCents: seat.budgetCents,
      modelTier: seat.modelTier,
      evalSuiteId: seat.evalSuiteId,
    });
    expect(Number.isInteger(bundle.seat?.budgetCents)).toBe(true);
    expect(bundle.promptHash).toMatch(/^[a-f0-9]{16,}$/);
    expect(bundle.skillsHash).toMatch(/^[a-f0-9]{16,}$/);
  });

  it("copies a skill's bundle directories, scripts and tools included, when the profile's skills dir is given", async () => {
    const skillsDir = tmp("skills");
    const file = writeSkillRecord(skillsDir, { name: "repo-audit", description: "Map the codebase.", instructions: "Run scripts/audit.sh first." });
    const skillDir = path.dirname(file);
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "scripts", "audit.sh"), "#!/bin/sh\nls\n");
    fs.mkdirSync(path.join(skillDir, "tools"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "tools", "count.py"), "print(1)\n");
    fs.mkdirSync(path.join(skillDir, "references"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "references", "notes.md"), "notes\n");

    const versions = createAgentVersions({ store: new InMemoryImproveStore(), companyId: "co", source: source() });
    const out = tmp("bundle-dirs");
    const result = await exportAgent({ versions, agentId: "engineer", dir: out, skillsDir });
    for (const relative of ["skills/repo-audit/SKILL.md", "skills/repo-audit/scripts/audit.sh", "skills/repo-audit/tools/count.py", "skills/repo-audit/references/notes.md"]) {
      expect(fs.existsSync(path.join(out, relative)), relative).toBe(true);
    }
    expect(result.files.map((f) => path.relative(out, f))).toContain("skills/repo-audit/scripts/audit.sh");
    // The SKILL.md is still the version's content, so the bundle hashes do not move.
    expect(fs.readFileSync(path.join(out, "skills/repo-audit/SKILL.md"), "utf8")).toContain("Run scripts/audit.sh first.");
  });

  it("import restores the record from the bundle: seat block and the cap in integer cents", async () => {
    const versions = createAgentVersions({ store: new InMemoryImproveStore(), companyId: "co", source: source() });
    const out = tmp("round-trip");
    await exportAgent({ versions, agentId: "engineer", dir: out });
    const bundle = JSON.parse(fs.readFileSync(path.join(out, "agent.json"), "utf8")) as AgentBundle;

    const root = tmp("fresh");
    const fresh = createAgentVersions({ store: new InMemoryImproveStore(), companyId: "co_fresh", source: source() });
    const imported = await importAgent({ versions: fresh, dir: out, profile: { agentsDir: path.join(root, "agents"), skillsDir: path.join(root, "skills") } });
    const record = JSON.parse(fs.readFileSync(imported.recordFile, "utf8")) as { seat?: unknown; budget_cap_per_run_cents: number; tools: Array<{ name: string }> };
    expect(record.seat).toEqual(bundle.seat);
    expect(record.budget_cap_per_run_cents).toBe(bundle.seat?.budgetCents);
    expect(record.tools.map((t) => t.name)).toEqual(bundle.toolsets);
  });

  it("still imports a bundle written before the seat block existed", async () => {
    const dir = tmp("old-bundle");
    fs.writeFileSync(
      path.join(dir, "agent.json"),
      JSON.stringify({ schema: "trent.agent/1", agentId: "growth", version: 1, prompt: "Plan an experiment.", model: { provider: "anthropic", model: "m" }, toolsets: ["file_ops"], skills: [], promptHash: "x", skillsHash: "y" }),
    );
    const root = tmp("fresh-old");
    const fresh = createAgentVersions({ store: new InMemoryImproveStore(), companyId: "co_fresh", source: source() });
    const imported = await importAgent({ versions: fresh, dir, profile: { agentsDir: path.join(root, "agents"), skillsDir: path.join(root, "skills"), budgetCapCents: 250 } });
    const record = JSON.parse(fs.readFileSync(imported.recordFile, "utf8")) as { seat?: unknown; budget_cap_per_run_cents: number };
    expect(record.seat).toBeUndefined();
    expect(record.budget_cap_per_run_cents).toBe(250);
  });
});
