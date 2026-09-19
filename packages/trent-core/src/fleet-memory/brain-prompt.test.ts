/**
 * [C2] What the brain puts in a prompt, and what it must never put there.
 *
 * The stable tier carries `system/` and the file TREE. It does not carry the bodies of `memory/`,
 * `decisions/` or `seats/`: those are signposts a seat follows with `brain_read` or `fleet_search`
 * when the objective needs them. The tier is also asserted byte-stable across two runs of an
 * unchanged profile, because a prefix that moves every run is a prefix no provider can cache.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryAdapter } from "../tools/memory/index.js";
import { createBrain, type BrainExec } from "./brain.js";
import { renderBrainBlock } from "./brain-prompt.js";
import { createFleetMemoryHook } from "./orchestrator-hook.js";
import { InMemoryFleetSource } from "./source.js";
import { CONTEXT_BLOCKS } from "./tiers.js";

let profileDir: string;
const COMPANY = "co_1";
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });

beforeEach(() => {
  profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-brain-prompt-")));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function seeded(): ReturnType<typeof createBrain> {
  const brain = createBrain({ profileDir, exec: noGit, now: () => new Date("2026-09-18T09:00:00.000Z") });
  brain.ensure();
  brain.applyOps("system/identity.md", [{ op: "append", text: "Trent is Bobby's AI cofounder." }], { writer: "human" });
  brain.recordDecision({ title: "Sales is the ninth seat", body: "browser becomes a toolset.", writer: "human" });
  brain.appendNote({ text: "the churn analysis landed", writer: "analyst", runId: "run-1" });
  brain.writeSeatNote({ seat: "finance", text: "invoices are raised monthly", writer: "finance" });
  return brain;
}

describe("the brain block in the stable tier", () => {
  it("carries system content and the tree as paths, never a note body", () => {
    const brain = seeded();
    const text = renderBrainBlock({ brain });

    expect(text).toContain("Trent is Bobby's AI cofounder.");
    expect(text).toContain("decisions/2026-09-18-sales-is-the-ninth-seat.md");
    expect(text).toContain("memory/2026-09-18.md");
    expect(text).toContain("seats/finance/notes.md");
    // Signposts only: no body from memory/, decisions/ or seats/.
    expect(text).not.toContain("the churn analysis landed");
    expect(text).not.toContain("browser becomes a toolset");
    expect(text).not.toContain("invoices are raised monthly");
  });

  it("is byte-identical on a second render when nothing changed, and moves when it does", () => {
    const brain = seeded();
    const first = renderBrainBlock({ brain });
    expect(renderBrainBlock({ brain })).toBe(first);

    brain.applyOps("system/facts.md", [{ op: "append", text: "the fiscal year starts in April" }], { writer: "human" });
    expect(renderBrainBlock({ brain })).not.toBe(first);
  });

  it("leaves out the system files another stable block already carries, and bounds both halves", () => {
    const brain = seeded();
    brain.writeFile("system/memory.md", "the migrated company block", { writer: "human" });
    expect(renderBrainBlock({ brain })).toContain("the migrated company block");
    expect(renderBrainBlock({ brain, excludeSystemFiles: ["memory.md"] })).not.toContain("the migrated company block");

    brain.applyOps("system/facts.md", [{ op: "append", text: "x".repeat(400) }], { writer: "human" });
    const clipped = renderBrainBlock({ brain, systemLimitChars: 100 });
    expect(clipped).not.toContain("x".repeat(200));

    for (let i = 0; i < 40; i += 1) brain.recordDecision({ title: `decision number ${String(i)}`, body: "body", writer: "human" });
    const bounded = renderBrainBlock({ brain, treeMaxEntries: 5 });
    expect(bounded.split("\n").filter((l) => l.startsWith("decisions/")).length).toBeLessThanOrEqual(5);
  });
});

describe("the hook feeds the brain into the stable tier", () => {
  it("renders the brain block once per run and keeps the stable tier byte-stable", async () => {
    const brain = seeded();
    const source = new InMemoryFleetSource();
    const build = (): ReturnType<typeof createFleetMemoryHook> =>
      createFleetMemoryHook({ source, profileDir, memory: createMemoryAdapter({ profileDir }), brain });

    const hook = build();
    const seen: string[] = [];
    const seat = hook.wrapSeatModel(async (input: { subtask: { id: string; seat: string; objective?: string }; dynamicPrompt?: string }) => {
      seen.push(input.dynamicPrompt ?? "");
      return {};
    });
    hook.runStarted({ runId: "r1", companyId: COMPANY, objective: "decide the ninth seat" });
    await seat({ subtask: { id: "s1", seat: "ceo", objective: "decide the ninth seat" } });
    hook.runFinished("r1");

    expect(seen[0]).toContain("Trent is Bobby's AI cofounder.");
    expect(seen[0]).toContain("decisions/2026-09-18-sales-is-the-ninth-seat.md");
    expect(hook.contextFor("r1", "ceo")?.kept.some((b) => b.name === CONTEXT_BLOCKS.brain && b.tier === "stable")).toBe(true);

    const second = build();
    const seat2 = second.wrapSeatModel(async () => ({}));
    second.runStarted({ runId: "r2", companyId: COMPANY, objective: "a different objective entirely" });
    await seat2({ subtask: { id: "s2", seat: "growth", objective: "a different objective entirely" } });
    expect(second.stablePreludeFor("r2")).toBe(hook.stablePreludeFor("r1"));
  });

  it("builds the brain from profileDir on its own, migrates the blocks, and can be turned off", async () => {
    fs.mkdirSync(path.join(profileDir, "memories"), { recursive: true });
    fs.writeFileSync(path.join(profileDir, "memories", "MEMORY.md"), "the fiscal year starts in April", "utf8");
    const source = new InMemoryFleetSource();

    // No `brain` option at all: this is `brain.enabled` defaulting to true on the real wiring path.
    const hook = createFleetMemoryHook({ source, profileDir });
    let prelude = "";
    const seat = hook.wrapSeatModel(async (input: { subtask: { id: string; seat: string; objective?: string }; dynamicPrompt?: string }) => {
      prelude = input.dynamicPrompt ?? "";
      return {};
    });
    hook.runStarted({ runId: "r1", companyId: COMPANY, objective: "plan the quarter" });
    await seat({ subtask: { id: "s1", seat: "ceo", objective: "plan the quarter" } });

    expect(hook.adapters.map((a) => a.name)).toContain("brain_read");
    expect(fs.readFileSync(path.join(profileDir, "brain", "system", "memory.md"), "utf8")).toBe("the fiscal year starts in April");
    expect(prelude).toContain("the fiscal year starts in April");
    // The block is rendered once, by the company-memory block; the brain block does not repeat it.
    expect(prelude.split("the fiscal year starts in April").length - 1).toBe(1);

    // And `brain: false` is the off switch: no directory, no adapter, no block.
    const off = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-brain-off-")));
    try {
      const disabled = createFleetMemoryHook({ source, profileDir: off, brain: false });
      const seatOff = disabled.wrapSeatModel(async () => ({}));
      disabled.runStarted({ runId: "r9", companyId: COMPANY, objective: "plan the quarter" });
      await seatOff({ subtask: { id: "s9", seat: "ceo", objective: "plan the quarter" } });
      expect(disabled.adapters.map((a) => a.name)).not.toContain("brain_read");
      expect(fs.existsSync(path.join(off, "brain"))).toBe(false);
    } finally {
      fs.rmSync(off, { recursive: true, force: true });
    }
  });
});
