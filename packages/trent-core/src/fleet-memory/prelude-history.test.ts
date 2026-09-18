/**
 * The conversation transcript rides in the seat prompt AFTER the frozen fleet-memory prelude.
 *
 * The prelude is deliberately byte-stable for the whole run so the provider can cache that prefix
 * (`orchestrator-hook.ts` header). A transcript inserted before it, or interleaved with it, moves
 * the prefix on every turn and destroys that property, so the ordering is the assertion here —
 * not merely that the transcript is present.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemoryAdapter } from "../tools/memory/index.js";
import { createFleetMemoryHook } from "./orchestrator-hook.js";
import { InMemoryFleetSource } from "./source.js";

const COMPANY = "co_history";
let profileDir = "";

type Input = { companyId: string; subtask: { id: string; seat: string; objective: string }; dynamicPrompt?: string };

beforeAll(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-prelude-history-"));
});
afterAll(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function hookWithSeat(): { seat: (input: Input) => Promise<unknown>; seen: string[]; hook: ReturnType<typeof createFleetMemoryHook> } {
  const hook = createFleetMemoryHook({ source: new InMemoryFleetSource(), memory: createMemoryAdapter({ profileDir }) });
  const seen: string[] = [];
  const seat = hook.wrapSeatModel(async (input: Input) => {
    seen.push(input.dynamicPrompt ?? "");
    return { output: {}, model: "m", tokens: 0, costCents: 0, fallback: false };
  });
  return { seat, seen, hook };
}

describe("the conversation transcript in the prelude", () => {
  it("is rendered after the company memory block, never before it", async () => {
    const { seat, seen, hook } = hookWithSeat();
    hook.runStarted({
      runId: "r1",
      companyId: COMPANY,
      objective: "now do the second one",
      history: [
        { role: "user", content: "list the two worst bottlenecks" },
        { role: "assistant", content: "The drain loop and the seat tool history." },
      ],
    });
    await seat({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: "now do the second one" } });

    const prompt = seen[0] ?? "";
    expect(prompt).toContain("## Company memory");
    expect(prompt).toContain("list the two worst bottlenecks");
    expect(prompt).toContain("The drain loop and the seat tool history.");
    expect(prompt.indexOf("list the two worst bottlenecks")).toBeGreaterThan(prompt.indexOf("## Company memory"));
  });

  it("leaves the prelude untouched when there is no history", async () => {
    const { seat, seen, hook } = hookWithSeat();
    hook.runStarted({ runId: "r2", companyId: COMPANY, objective: "first line of the session" });
    await seat({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: "first line of the session" } });
    expect(seen[0]).toContain("## Company memory");
    expect(seen[0]).not.toMatch(/conversation/i);
  });

  it("stays frozen for the rest of the run", async () => {
    const { seat, seen, hook } = hookWithSeat();
    hook.runStarted({
      runId: "r3",
      companyId: COMPANY,
      objective: "now do the second one",
      history: [{ role: "user", content: "an earlier question" }],
    });
    await seat({ companyId: COMPANY, subtask: { id: "s1", seat: "engineer", objective: "now do the second one" } });
    await seat({ companyId: COMPANY, subtask: { id: "s2", seat: "support", objective: "now do the second one" } });
    expect(seen[1]).toBe(seen[0]);
  });
});
