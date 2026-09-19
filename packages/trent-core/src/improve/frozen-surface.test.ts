/**
 * [D0] gate 1 — the frozen surface.
 *
 * The loop may not rewrite what grades it. One test per frozen class: the bundled suites, the
 * goldens, the judge prompt, the gate code, a read-only memory block, and a block the judge's
 * inputs derive from. A draft that would touch one is refused with the path named and lands in
 * the ledger as a refusal, so the decision is visible in `trent improve history`.
 */
import path from "node:path";

import { describe, expect, it } from "vitest";

import { BUNDLED_SKILLS_DIR } from "../fleet/SkillProvisioner.js";
import { DEFAULT_MEMORY_BLOCKS } from "../tools/memory/blocks.js";
import type { SkillDraftRow } from "../store/StorePort.js";
import {
  FROZEN_REFUSAL_ACTOR,
  GATE_CODE_DIRS,
  JUDGE_PROMPT_FILES,
  createFrozenSurface,
  draftTargets,
  frozenRefusalMessage,
  refuseFrozenDraft,
} from "./frozen-surface.js";
import { InMemoryImproveStore } from "./memory-store.js";

const PROFILE = "/tmp/trent-profile-d0";

function surface() {
  return createFrozenSurface({
    profileDir: PROFILE,
    blocks: DEFAULT_MEMORY_BLOCKS,
    skillWriteRoot: BUNDLED_SKILLS_DIR,
  });
}

describe("[D0] frozen surface — one refusal per class", () => {
  const s = surface();

  it("refuses a write into the bundled suites directory", () => {
    const v = s.violationFor({ path: path.join(BUNDLED_SKILLS_DIR, "ads", "evals", "evals.json") });
    expect(v?.frozenClass).toBe("suite");
    expect(v?.path).toContain(path.join("ads", "evals"));
  });

  it("refuses a write into the goldens directory", () => {
    const v = s.violationFor({ path: path.join(PROFILE, "goldens", "golden_1.json") });
    expect(v?.frozenClass).toBe("golden");
  });

  it("refuses a write to the judge prompt", () => {
    const v = s.violationFor({ path: JUDGE_PROMPT_FILES[0]! });
    expect(v?.frozenClass).toBe("judge_prompt");
  });

  it("refuses a write to the gate code", () => {
    const v = s.violationFor({ path: path.join(GATE_CODE_DIRS[0]!, "gate-score.ts") });
    expect(v?.frozenClass).toBe("gate_code");
  });

  it("refuses a write to a read_only memory block, by label and by file", () => {
    expect(s.violationFor({ memoryBlock: "company" })?.frozenClass).toBe("read_only_memory");
    expect(s.violationFor({ path: path.join(PROFILE, "memories", "COMPANY.md") })?.frozenClass).toBe("read_only_memory");
  });

  it("refuses a write to a block the judge's inputs derive from", () => {
    expect(s.violationFor({ memoryBlock: "memory" })?.frozenClass).toBe("judge_input_memory");
    expect(s.violationFor({ memoryBlock: "user" })?.frozenClass).toBe("judge_input_memory");
  });

  it("lets an ordinary skill file through when the write root is not frozen", () => {
    const open = createFrozenSurface({ profileDir: PROFILE, blocks: DEFAULT_MEMORY_BLOCKS, skillWriteRoot: path.join(PROFILE, "skills") });
    expect(open.violationFor({ path: path.join(PROFILE, "skills", "ship-feature", "SKILL.md") })).toBeUndefined();
  });

  it("names every extra path the profile froze", () => {
    const extra = createFrozenSurface({ profileDir: PROFILE, blocks: DEFAULT_MEMORY_BLOCKS, extraPaths: [path.join(PROFILE, "sealed")] });
    expect(extra.violationFor({ path: path.join(PROFILE, "sealed", "x.md") })?.frozenClass).toBe("configured");
  });
});

function draft(over: Partial<SkillDraftRow> = {}): SkillDraftRow {
  return {
    id: "skill_frozen_1",
    companyId: "co_d0",
    agentId: "engineer",
    taskType: "ship-feature",
    kind: "skill",
    status: "quarantine",
    content: "## skill\nbody",
    contentHash: "hash",
    triggers: [],
    createdAt: "2026-09-18T10:00:00.000Z",
    promotedAt: null,
    lastUsedAt: null,
    retiredAt: null,
    ...over,
  };
}

describe("[D0] a draft on a frozen path is refused and ledgered", () => {
  it("rejects the draft, names the path in the message, and writes one refusal ledger row", async () => {
    const store = new InMemoryImproveStore();
    const row = draft();
    await store.createDraft(row);
    const violations = draftTargets(row, surface()).flatMap((t) => {
      const v = surface().violationFor(t);
      return v ? [v] : [];
    });
    expect(violations.length).toBeGreaterThan(0);

    const message = frozenRefusalMessage(violations);
    expect(message).toContain(BUNDLED_SKILLS_DIR);
    expect(message).toContain("suite");

    await refuseFrozenDraft(store, row, violations, "2026-09-18T10:01:00.000Z");
    expect((await store.getDraft(row.id))?.status).toBe("rejected");
    const ledger = await store.listLedger(row.companyId, { artifactId: row.id });
    expect(ledger.map((l) => l.action)).toEqual(["reject"]);
    expect(ledger[0]?.actor).toBe(FROZEN_REFUSAL_ACTOR);
  });

  it("a memory draft targets the blocks the judge's inputs derive from, so it is refused", () => {
    const payload = JSON.stringify({ profileDir: PROFILE, memory: "a", user: "b", dropped: [] });
    const targets = draftTargets(draft({ kind: "memory", taskType: "memory_consolidation", content: payload }), surface());
    const classes = targets.flatMap((t) => {
      const v = surface().violationFor(t);
      return v ? [v.frozenClass] : [];
    });
    expect(classes).toContain("judge_input_memory");
  });
});
