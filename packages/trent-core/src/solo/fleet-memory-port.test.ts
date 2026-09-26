/**
 * [S2] The solo memory port over the fleet's own tier builders (`fleet-memory/orchestrator-hook.ts`):
 * stable = company memory, the brain, the workspace; context = recall for this objective. The brain
 * block renders `brain/system/` in full, and `solo.md` is the persona the runner already puts at the
 * head of the system prompt, so the port renders the brain block without it (S1 follow-up 1): the
 * persona's bytes are paid for once.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFleetMemoryHook } from "../fleet-memory/orchestrator-hook.js";
import { InMemoryFleetSource } from "../fleet-memory/source.js";
import { CONTEXT_BLOCKS } from "../fleet-memory/tiers.js";
import { FIXED_NOW, collect, fakeMeter, memorySession, scriptedGateway, sequentialIds } from "./fakes.test-helpers.js";
import { soloMemoryFromFleetHook } from "./fleet-memory-port.js";
import { soloPersonaPath } from "./prompt.js";
import { createSoloRunner } from "./runner.js";

const PERSONA = "You are Trent-for-Ada: terse, exact, never cheerful. PERSONA-MARKER-7Q.";
const MEMORY = "the fiscal year starts in April";

let profileDir: string;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-memory-"));
  fs.mkdirSync(path.join(profileDir, "memories"), { recursive: true });
  fs.writeFileSync(path.join(profileDir, "memories", "MEMORY.md"), MEMORY, "utf8");
  fs.mkdirSync(path.dirname(soloPersonaPath(profileDir)), { recursive: true });
  fs.writeFileSync(soloPersonaPath(profileDir), PERSONA, "utf8");
});
afterEach(() => fs.rmSync(profileDir, { recursive: true, force: true }));

describe("[S2] soloMemoryFromFleetHook", () => {
  it("hands the fleet's stable tier to solo with the brain block rendered without solo.md", async () => {
    const hook = createFleetMemoryHook({ source: new InMemoryFleetSource(), profileDir });
    const memory = soloMemoryFromFleetHook({ hook, companyId: "cmp_solo", profileDir });
    const tiers = await memory({ runId: "solo_1", objective: "plan the quarter", history: [] });

    const names = tiers.stable.map((block) => block.name);
    expect(names).toContain(CONTEXT_BLOCKS.companyMemory);
    expect(names).toContain(CONTEXT_BLOCKS.brain);
    const stable = tiers.stable.map((block) => block.text).join("\n\n");
    expect(stable).toContain(MEMORY);
    expect(stable).not.toContain("PERSONA-MARKER-7Q");
    // The persona is still a file the tree names; only its body stays out of the brain block.
    expect(stable).toContain("system/solo.md");
    expect(tiers.stable.every((block) => block.tier === "stable")).toBe(true);
    expect(tiers.context.every((block) => block.tier !== "stable" && block.name !== CONTEXT_BLOCKS.stableVersion)).toBe(true);
  });

  it("puts the persona in the system prompt exactly once when a solo runner uses it", async () => {
    const hook = createFleetMemoryHook({ source: new InMemoryFleetSource(), profileDir });
    const gateway = scriptedGateway(["Noted."]);
    const runner = createSoloRunner({
      gateway,
      tools: { adapters: [] },
      session: memorySession(),
      memory: soloMemoryFromFleetHook({ hook, companyId: "cmp_solo", profileDir }),
      meter: fakeMeter(),
      profileDir,
      now: FIXED_NOW,
      newId: sequentialIds(),
    });
    await collect(runner.run({ objective: "plan the quarter" }));
    const system = gateway.requests[0]?.messages.find((m) => m.role === "system")?.content ?? "";
    expect(system.split("PERSONA-MARKER-7Q").length - 1).toBe(1);
    expect(system).toContain(MEMORY);
  });
});
