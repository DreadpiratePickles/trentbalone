/**
 * [C5] Propagation: a promoted skill reaches EVERY seat, as an index entry whose body is fetched
 * on demand.
 *
 * The research is specific about both halves (`agent-harness-sota-2026-09.md` section 4): one
 * agent's earned skill "should reach other agents as an index entry whose body is fetched on
 * demand", and the cost of inlining bodies instead is quoted in tokens per skill per prompt.
 * The index entry is name plus one line; `fleet_skill_view` / `skill_view` is the only way to the
 * body. This suite is the assertion that both hold — including through recall, which ranks skills
 * as candidates and could otherwise put a body in the prelude by the back door.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CORE_ROLE_IDS } from "../fleet/AgentInstaller.js";
import { InMemoryImproveStore } from "../improve/memory-store.js";
import { ORG_TIER_AGENT } from "../improve/org-tier.js";
import type { SkillDraftRow } from "../store/StorePort.js";
import { createFleetMemoryHook, type FleetSeatInput } from "./orchestrator-hook.js";
import { recallForObjective } from "./recall.js";
import { listSharedSkills, renderSharedSkillsIndex } from "./shared-skills.js";
import { InMemoryFleetSource } from "./source.js";

const COMPANY = "co_propagation";
const HEADING = "Ship a feature behind a flag";
const BODY_LINE = "Open the pull request with the failing test first, then the flag, then the code.";
const OBJECTIVE = "ship a feature behind a flag this week";

function skill(id: string, agentId: string, taskType: string, content: string): SkillDraftRow {
  return {
    id,
    companyId: COMPANY,
    agentId,
    taskType,
    kind: "skill",
    status: "live",
    content,
    contentHash: `h_${id}`,
    triggers: [],
    createdAt: "2026-09-12T09:00:00.000Z",
    promotedAt: "2026-09-12T09:30:00.000Z",
    lastUsedAt: null,
    retiredAt: null,
  };
}

async function orgStore(): Promise<InMemoryImproveStore> {
  const improve = new InMemoryImproveStore();
  await improve.createDraft(skill("sk_org", ORG_TIER_AGENT, "ship-feature", `# ${HEADING}\n${BODY_LINE}`));
  return improve;
}

let profileDir = "";
beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-propagation-"));
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

describe("a promoted org-tier skill", () => {
  it("is one index line for every seat, and the line is the name plus the heading, never the body", async () => {
    const improve = await orgStore();
    expect(CORE_ROLE_IDS.length).toBeGreaterThan(0);
    for (const seat of [...CORE_ROLE_IDS, "eng-ai-engineer"]) {
      const listed = await listSharedSkills(improve, COMPANY, seat);
      expect(listed.map((s) => s.tier)).toEqual(["org"]);
      const index = renderSharedSkillsIndex(listed);
      expect(index.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1);
      expect(index).toContain("ship-feature");
      expect(index).toContain(HEADING);
      expect(index).not.toContain(BODY_LINE);
    }
  });

  it("is never inlined by recall, which ranks the skill but renders its index line", async () => {
    const improve = await orgStore();
    const source = new InMemoryFleetSource({ improve });
    const result = await recallForObjective(source, { companyId: COMPANY, seat: "engineer", objective: OBJECTIVE });
    const skillItem = result.items.find((item) => item.kind === "skill");
    expect(skillItem).toBeDefined();
    expect(result.block).toContain("ship-feature");
    expect(result.block).not.toContain(BODY_LINE);
  });

  it("reaches two different seats' preludes as the same index line, with no body in either", async () => {
    const improve = await orgStore();
    const source = new InMemoryFleetSource({ improve });
    const hook = createFleetMemoryHook({ source, profileDir, brain: false });
    hook.runStarted({ runId: "run-1", companyId: COMPANY, objective: OBJECTIVE });
    const preludes: Record<string, string> = {};
    for (const seat of ["engineer", "finance"]) {
      const input: FleetSeatInput = { companyId: COMPANY, subtask: { id: `t-${seat}`, seat, objective: OBJECTIVE } };
      await hook.wrapSeatModel(async (i: FleetSeatInput) => i)(input);
      preludes[seat] = hook.preludeFor("run-1", seat) ?? "";
    }
    for (const seat of ["engineer", "finance"]) {
      expect(preludes[seat]).toContain("ship-feature");
      expect(preludes[seat]).toContain(HEADING);
      expect(preludes[seat]).not.toContain(BODY_LINE);
    }
    // The org tier is the STABLE tier, so the bytes carrying the skill are identical for both.
    expect(hook.stablePreludeFor("run-1")).toContain("ship-feature");
  });
});
