/**
 * [CF] C15.1: the memory section of the stable tier is worded per mode.
 *
 * The fleet-memory hook renders the memory blocks for every seat: "## Company memory (shared by every seat; ...)",
 * block descriptions such as "who the founder is ...", "; read-only for seats". A solo prompt carried those words
 * too (C15 measured a fresh profile's stable tier: "seat" 3, "founder" 2). Solo has no seats and no founder, so
 * its section says "your memory" and "who you work for"; the fleet's is byte-identical to what it was (the literal
 * below was printed from the hook BEFORE this change, docs/sessions/2026-09-26-council-followups.md, item C).
 *
 * Through the real hook and the real solo port (`fleet-memory-port.ts`) over a temp profile. No model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFleetMemoryHook } from "../fleet-memory/orchestrator-hook.js";
import { InMemoryFleetSource } from "../fleet-memory/source.js";
import { CONTEXT_BLOCKS } from "../fleet-memory/tiers.js";
import { CONSOLIDATION_WRITE_GATE, commitOperations } from "../tools/memory/index.js";
import { soloMemoryFromFleetHook } from "./fleet-memory-port.js";

const FLEET_SECTION =
  "## Company memory (shared by every seat; writes land next run)\n" +
  "## MEMORY.md (memory: durable facts about the company and how it works; 2200-char cap, 15 chars used)\nLives in Leeds.\n\n" +
  "## USER.md (user: who the founder is and how they want to be worked with; 1375-char cap, 0 chars used)\n(empty)\n\n" +
  "## COMPANY.md (company: shared facts every seat reads; edited by the founder or the heartbeat; 1500-char cap, 0 chars used; read-only for seats)\n(empty)";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function hookOverProfile() {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cf-section-"));
  temps.push(profileDir);
  expect(commitOperations(profileDir, "memory", [{ action: "add", content: "Lives in Leeds." }], {}, CONSOLIDATION_WRITE_GATE).ok).toBe(true);
  return { profileDir, hook: createFleetMemoryHook({ source: new InMemoryFleetSource(), profileDir, brain: false }) };
}

const sectionOf = (blocks: ReadonlyArray<{ readonly name: string; readonly text: string }> | undefined): string => blocks?.find((block) => block.name === CONTEXT_BLOCKS.companyMemory)?.text ?? "";
const count = (text: string, word: string): number => (text.match(new RegExp(word, "gi")) ?? []).length;

describe("[CF] the memory section, per mode", () => {
  it("a fleet seat's section is byte-identical to what it was", async () => {
    const { hook } = hookOverProfile();
    const runId = "run_fleet_cf";
    hook.runStarted({ runId, companyId: "co", objective: "x" });
    await hook.wrapSeatModel(async () => undefined)({ companyId: "co", subtask: { id: `${runId}-ceo`, seat: "ceo", objective: "x", contextBundle: { overallObjective: "x" } }, systemPrompt: "", dynamicPrompt: "" });
    const fleet = sectionOf(hook.contextFor(runId, "ceo")?.kept);
    hook.runFinished(runId);
    expect(fleet).toBe(FLEET_SECTION);
  });

  it('the solo section names no "seat" and no "founder", says whose memory it is, and keeps every block, cap and entry', async () => {
    const { hook, profileDir } = hookOverProfile();
    const tiers = await soloMemoryFromFleetHook({ hook, companyId: "co", profileDir })({ runId: "solo_cf", objective: "x", history: [] });
    const solo = sectionOf(tiers.stable);

    expect({ seat: count(solo, "seat"), founder: count(solo, "founder") }).toEqual({ seat: 0, founder: 0 });
    expect(solo).toMatch(/^## Your memory \(/);
    expect(solo).toContain("who you work for");
    for (const part of ["## MEMORY.md (memory: ", "2200-char cap, 15 chars used", "Lives in Leeds.", "## USER.md (user: ", "## COMPANY.md (company: ", "; read-only)"]) expect(solo).toContain(part);
  });

  it("a block the profile described itself keeps its own words in solo", async () => {
    const { profileDir } = hookOverProfile();
    const custom = createFleetMemoryHook({ source: new InMemoryFleetSource(), profileDir, brain: false, blocks: [{ label: "memory", file: "MEMORY.md", description: "what the shop sells and to whom", limit: 2200, read_only: false }] });
    const tiers = await soloMemoryFromFleetHook({ hook: custom, companyId: "co", profileDir })({ runId: "solo_cf_2", objective: "x", history: [] });
    expect(sectionOf(tiers.stable)).toContain("## MEMORY.md (memory: what the shop sells and to whom; 2200-char cap");
  });
});
