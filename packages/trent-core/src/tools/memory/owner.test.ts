/**
 * [C15] Memory the agent can correct (council C15; Hermes `tools/memory_tool.py` add/replace/remove).
 *
 * In solo there is one writer: the conversation's own agent, whose calls run bound to the
 * conversation (`solo/runner.ts` `bindSessionTaint`). That `owner` may add, replace and remove inside
 * a writable block; a read-only block stays refused, and the fleet keeps C4's rule (a seat appends,
 * the consolidation rewrites). The provenance hold is unchanged: it sits outside the adapter, so a
 * rewrite after a web read is held as a row exactly as an add is.
 *
 * Through the real solo runner, the real fleet-memory hook and the real memory adapter behind the
 * gate the runtime uses (`solo/memory-gate.ts`), over a temp profile. The model is a script.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createFleetMemoryHook } from "../../fleet-memory/orchestrator-hook.js";
import { InMemoryFleetSource } from "../../fleet-memory/source.js";
import { provenanceAdapters } from "../../governance/provenance.js";
import { runWithToolCallContext } from "../../governance/tool-call-context.js";
import { FIXED_NOW, collect, fakeAdapter, fakeMeter, scriptedGateway, sequentialIds, toolCall, toolCallsOf } from "../../solo/fakes.test-helpers.js";
import { memoryFile, tempProfile } from "../../solo/fakes-s3.test-helpers.js";
import { soloMemoryFromFleetHook } from "../../solo/fleet-memory-port.js";
import { gatedMemoryAdapters } from "../../solo/memory-gate.js";
import { createSoloRunner } from "../../solo/runner.js";
import { memorySoloSession } from "../../solo/session-store.js";
import type { OrcEvent } from "../../orchestrator/types.js";
import type { ToolCallRecord } from "../types.js";
import { listHeldMemoryWrites } from "./holds.js";
import { DEFAULT_MEMORY_BLOCKS, createMemoryAdapter, memoryToolSchemas, readEntries, commitOperations, CONSOLIDATION_WRITE_GATE } from "./index.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const COMPANY = "cmp_c15_memory";
const REPLACE = 'memory {"action":"replace","old_text":"Leeds","content":"York"}';
const PAGE = 'web_extract {"url": "https://relocation.example/york"}';

/** A profile whose MEMORY.md already holds two entries, one of them the fact about to change. */
function profileWith(entries: readonly string[]): string {
  const profileDir = tempProfile("trent-c15-memory-");
  temps.push(profileDir);
  const seeded = commitOperations(profileDir, "memory", entries.map((content) => ({ action: "add" as const, content })), {}, CONSOLIDATION_WRITE_GATE);
  expect(seeded.ok).toBe(true);
  return profileDir;
}

/** The shape the runtime builds: the tool build's adapters chain-wrapped, the hook's memory behind the solo gate. */
function soloConversation(profileDir: string, script: string[]) {
  const hook = createFleetMemoryHook({ source: new InMemoryFleetSource(), profileDir, brain: false });
  const web = fakeAdapter({ name: "web", tools: ["web_extract"], result: () => ({ status: "completed", summary: "York is lovely in spring." }) });
  const runner = createSoloRunner({
    gateway: scriptedGateway(script),
    tools: { adapters: [...provenanceAdapters([web]), ...gatedMemoryAdapters(hook.adapters, { profileDir })] },
    session: memorySoloSession(),
    memory: soloMemoryFromFleetHook({ hook, companyId: COMPANY, profileDir }),
    meter: fakeMeter(),
    now: FIXED_NOW,
    newId: sequentialIds(),
    companyId: COMPANY,
  });
  return { runner, hook };
}

/** The run's memory calls, from its last `step_output` (the frames carry the step's cumulative record list). */
async function memoryCallOf(run: Promise<OrcEvent[]>): Promise<ToolCallRecord[]> {
  const last = (await run).filter((event) => event.kind === "step_output").at(-1);
  return toolCallsOf(last).filter((call) => call.adapter === "memory");
}

describe("[C15] in solo, the conversation's own agent corrects its memory", () => {
  it('"I moved to York": memory {"action":"replace","old_text":"Leeds","content":"York"} rewrites that entry in one call', async () => {
    const profileDir = profileWith(["Prefers short replies.", "Lives in Leeds."]);
    const { runner } = soloConversation(profileDir, [toolCall(REPLACE), "Noted: York."]);

    const [call] = await memoryCallOf(collect(runner.run({ objective: "I moved to York" })));

    expect(call).toMatchObject({ adapter: "memory", status: "completed" });
    // `content` is the whole new entry, in the place of the one entry `old_text` matched (Hermes's rule).
    expect(readEntries(profileDir, "memory")).toEqual(["Prefers short replies.", "York"]);
  });

  it("remove deletes the one entry old_text matches, and a batch can make room and add in the same call", async () => {
    const profileDir = profileWith(["Prefers short replies.", "Lives in Leeds.", "Drinks tea."]);
    const batch = 'memory {"operations":[{"action":"remove","old_text":"Leeds"},{"action":"replace","old_text":"tea","content":"Drinks coffee now."},{"action":"add","content":"Lives in York."}]}';
    const { runner } = soloConversation(profileDir, [toolCall('memory {"action":"remove","old_text":"short replies"}'), toolCall(batch), "Done."]);

    const calls = await memoryCallOf(collect(runner.run({ objective: "Forget the reply length; I moved and switched to coffee" })));

    expect(calls.map((call) => call.status)).toEqual(["completed", "completed"]);
    expect(readEntries(profileDir, "memory")).toEqual(["Drinks coffee now.", "Lives in York."]);
  });

  it("after a web read the same replace is held as a pending row and MEMORY.md is byte-identical", async () => {
    const profileDir = profileWith(["Prefers short replies.", "Lives in Leeds."]);
    const before = fs.readFileSync(memoryFile(profileDir));
    const { runner } = soloConversation(profileDir, [toolCall(PAGE), "Read it.", toolCall(REPLACE), "Waiting for your approval."]);

    await collect(runner.run({ objective: "Read about York" }));
    const [call] = await memoryCallOf(collect(runner.run({ objective: "I moved to York" })));

    expect(call).toMatchObject({ adapter: "memory", status: "needs_approval", provenance: "untrusted" });
    expect(fs.readFileSync(memoryFile(profileDir)).equals(before)).toBe(true);
    expect(listHeldMemoryWrites(profileDir).map((row) => [row.status, row.details.action])).toEqual([["pending", REPLACE]]);
  });

  it("a read-only block stays refused to the owner, and the owner's full block says to make room in the same batch", async () => {
    const profileDir = profileWith(["x".repeat(2180)]);
    const { runner } = soloConversation(profileDir, [
      toolCall('memory {"block":"company","action":"add","content":"Closed on Sundays."}'),
      toolCall('memory {"action":"add","content":"Lives in York, since September."}'),
      "Done.",
    ]);

    const [company, full] = await memoryCallOf(collect(runner.run({ objective: "Remember two things" })));

    expect(company).toMatchObject({ status: "blocked" });
    expect(company?.summary).toContain("read-only");
    expect(fs.existsSync(memoryFile(profileDir).replace("MEMORY.md", "COMPANY.md"))).toBe(false);
    expect(full).toMatchObject({ status: "failed" });
    expect(full?.summary).toMatch(/replace or remove/);
    expect(full?.summary).not.toMatch(/consolidation|seat|founder/);
  });
});

describe("[C15] the fleet keeps add-only", () => {
  it("a seat's replace inside a fleet step (no conversation bound) is refused and the file is unchanged", async () => {
    const profileDir = profileWith(["Lives in Leeds."]);
    const memory = createMemoryAdapter({ profileDir });

    const record = await runWithToolCallContext({ runId: "run_fleet", stepId: "step_ceo" }, () => memory.execute(REPLACE, {}));

    expect(record.status).toBe("blocked");
    expect(record.summary).toContain("a seat may only add entries");
    expect(readEntries(profileDir, "memory")).toEqual(["Lives in Leeds."]);
  });
});

describe("[C15] the tool description is per mode", () => {
  it("solo lists add, replace and remove with old_text; the fleet's offers add only", () => {
    const solo = memoryToolSchemas(DEFAULT_MEMORY_BLOCKS, "solo")[0];
    const fleet = memoryToolSchemas(DEFAULT_MEMORY_BLOCKS)[0];
    const actionsOf = (schema: typeof solo): unknown => (schema?.parameters.properties.action as { enum?: string[] } | undefined)?.enum;

    expect(actionsOf(solo)).toEqual(["add", "replace", "remove"]);
    expect(Object.keys(solo?.parameters.properties ?? {})).toContain("old_text");
    expect(solo?.description).not.toMatch(/seat|nightly|consolidation/i);
    expect(actionsOf(fleet)).toEqual(["add"]);

    const adapter = createMemoryAdapter({ profileDir: "/nonexistent-c15" });
    expect(adapter.instructionsFor("solo")).toContain('"replace"');
    expect(adapter.instructionsFor("fleet")).toBe(adapter.instructions);
  });
});
