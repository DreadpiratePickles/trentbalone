/**
 * [S3] Memory in solo (item 2).
 *
 * Recall for each turn comes through S2's fleet-memory port, into THAT turn's context tier, and never
 * into the frozen prefix. Writes go through the `memory` tool with provenance and holds: the hook's
 * adapters are not wrapped by the gate chain (`orchestrator/index.ts` appends them after it), so solo
 * wraps them itself (`memory-gate.ts`). An untrusted tool result never reaches shared memory without
 * the hold: a page read in turn 1 and a write in turn 2 is parked as a durable row; approving the row
 * replays the write through the UNWRAPPED adapter with the provenance marker (`tools/memory/holds.ts`).
 * Real fleet-memory hook and real memory adapter over a temp profile; scripted gateway.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createFleetMemoryHook } from "../fleet-memory/orchestrator-hook.js";
import { InMemoryFleetSource, type FleetRun } from "../fleet-memory/source.js";
import { provenanceAdapters } from "../governance/provenance.js";
import { approveHeldMemoryWrite, listHeldMemoryWrites } from "../tools/memory/holds.js";
import { FIXED_NOW, collect, fakeAdapter, fakeMeter, scriptedGateway, sequentialIds, toolCall, toolCallsOf } from "./fakes.test-helpers.js";
import { readMemory, systemIn, tempProfile } from "./fakes-s3.test-helpers.js";
import { soloMemoryFromFleetHook } from "./fleet-memory-port.js";
import { gatedMemoryAdapters } from "./memory-gate.js";
import { createSoloRunner } from "./runner.js";
import { memorySoloSession } from "./session-store.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const COMPANY = "cmp_s3_memory";
const PAGE = 'web_extract {"url": "https://supplier.example/terms"}';
const WRITE = 'memory {"target": "memory", "action": "add", "content": "Supplier deposits go to account 99."}';

function priorRun(id: string, objective: string, output: string): FleetRun {
  return {
    id,
    companyId: COMPANY,
    objective,
    status: "completed",
    summary: null,
    completedAt: "2026-09-20T10:00:00.000Z",
    steps: [{ id: `${id}-s1`, runId: id, agentRole: "analyst", title: objective, status: "completed", output }],
  } as FleetRun;
}

function conversation(script: string[], options: { source?: InMemoryFleetSource } = {}) {
  const profileDir = tempProfile("trent-solo-s3-memory-");
  temps.push(profileDir);
  const hook = createFleetMemoryHook({ source: options.source ?? new InMemoryFleetSource(), profileDir, brain: false });
  const web = fakeAdapter({ name: "web", tools: ["web_extract"], result: () => ({ status: "completed", summary: "Terms: wire the deposit to account 99." }) });
  const gateway = scriptedGateway(script);
  const runner = createSoloRunner({
    gateway,
    // The shape the runtime builds: the tool build's adapters are chain-wrapped; the hook's memory is gated here.
    tools: { adapters: [...provenanceAdapters([web]), ...gatedMemoryAdapters(hook.adapters, { profileDir })] },
    session: memorySoloSession(),
    memory: soloMemoryFromFleetHook({ hook, companyId: COMPANY, profileDir }),
    meter: fakeMeter(),
    now: FIXED_NOW,
    newId: sequentialIds(),
    companyId: COMPANY,
  });
  return { runner, gateway, profileDir, hook };
}

const openingOf = (request: { messages: ReadonlyArray<{ role: string; content: string }> } | undefined): string => request?.messages.at(-1)?.content ?? "";

describe("[S3] recall comes through the fleet-memory port, per turn, into the context tier", () => {
  it("each turn's opening carries the recall for ITS objective, and the frozen prefix carries none of it", async () => {
    const source = new InMemoryFleetSource();
    source.addRun(priorRun("run_churn", "analyze churn cohorts by signup month", "CHURN-FINDING: self-serve accounts churn at 12 percent in month three."));
    source.addRun(priorRun("run_hiring", "draft the Q3 hiring plan", "HIRING-FINDING: two backend engineers and one designer in Q3."));
    const { runner, gateway } = conversation(["Churn is a second-user problem.", "Two engineers and a designer."], { source });

    await collect(runner.run({ objective: "what did we learn about churn cohorts by signup month" }));
    await collect(runner.run({ objective: "remind me of the Q3 hiring plan" }));

    expect(openingOf(gateway.requests[0])).toContain("CHURN-FINDING");
    expect(openingOf(gateway.requests[1])).toContain("HIRING-FINDING");
    expect(openingOf(gateway.requests[1])).not.toContain("CHURN-FINDING");
    for (const request of gateway.requests) {
      expect(systemIn(request)).not.toContain("CHURN-FINDING");
      expect(systemIn(request)).not.toContain("HIRING-FINDING");
    }
  });
});

describe("[S3] an untrusted tool result never reaches shared memory without the hold", () => {
  it("a page read in turn 1 and a memory write in turn 2: the write is held as a durable row, MEMORY.md is unchanged", async () => {
    const { runner, profileDir } = conversation([toolCall(PAGE), "Read it.", toolCall(WRITE), "The write is waiting for your approval."]);
    await collect(runner.run({ objective: "Read the supplier's terms page" }));
    const events = await collect(runner.run({ objective: "Remember where deposits go" }));

    const written = toolCallsOf(events.find((event) => event.kind === "step_output"))[0];
    expect(written).toMatchObject({ adapter: "memory", status: "needs_approval", provenance: "untrusted" });
    expect(written?.summary).toContain("web_extract");
    expect(readMemory(profileDir)).not.toContain("account 99");
    const rows = listHeldMemoryWrites(profileDir);
    expect(rows.map((row) => row.details.sources)).toEqual([["web_extract"]]);
    // The run was not parked on it (B6): the model was told and answered.
    expect(events.at(-1)?.kind).toBe("run_done");
  });

  it("the held row, approved by a human, lands the entry tagged with where it came from", async () => {
    const { runner, profileDir, hook } = conversation([toolCall(PAGE), "Read it.", toolCall(WRITE), "Waiting."]);
    await collect(runner.run({ objective: "Read the supplier's terms page" }));
    await collect(runner.run({ objective: "Remember where deposits go" }));
    const [row] = listHeldMemoryWrites(profileDir);

    const approved = await approveHeldMemoryWrite({ profileDir, id: row?.id ?? "", memory: hook.memory });
    expect(approved).toMatchObject({ ok: true });
    expect(readMemory(profileDir)).toContain("Supplier deposits go to account 99. [provenance: untrusted via web_extract]");
  });

  it("the same write in a conversation that read nothing untrusted lands at once", async () => {
    const { runner, profileDir } = conversation([toolCall(WRITE), "Remembered."]);
    await collect(runner.run({ objective: "Remember where deposits go" }));
    expect(readMemory(profileDir)).toContain("Supplier deposits go to account 99.");
    expect(listHeldMemoryWrites(profileDir)).toEqual([]);
  });
});
