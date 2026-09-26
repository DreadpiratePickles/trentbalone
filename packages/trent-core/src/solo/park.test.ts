/**
 * [S1.1] A parked run outlives the process. The park (run id, session, held approval id, the pending
 * call and the run's own messages) is saved with the session, so after a restart `parked()` lists it
 * and `resume(runId)` after a decision continues it: by `approve` on the new runner, or by the row
 * itself being decided (`trent approvals approve <id>`). When the new runtime cannot rebuild it, the
 * approval row is marked abandoned and the conversation gets one line saying so. Never a silent loss.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../sessions/SessionStore.js";
import { verdictOf } from "../orchestrator/verdict.js";
import { FIXED_NOW, collect, fakeAdapter, fakeMemory, fakeMeter, gateChain, kinds, memorySession, memoryState, scriptedGateway, sequentialIds, toolCall, toolCallsOf, transcriptOf, type MemorySession, type MemoryState, type ScriptStep } from "./fakes.test-helpers.js";
import { sessionStoreState } from "./park.js";
import { createSoloRunner } from "./runner.js";
import type { SoloTools } from "./types.js";

const POST = 'social_post {"platform": "bluesky", "text": "New oak tables are in."}';
const HOLD = `social: ${POST} is held as appr_test until a human approves exactly this call.`;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function processOver(tools: SoloTools, script: readonly ScriptStep[], session: MemorySession, state: MemoryState, abandoned: string[] = []) {
  const gateway = scriptedGateway(script);
  const runner = createSoloRunner({
    gateway,
    tools,
    session,
    memory: fakeMemory().memory,
    meter: fakeMeter(),
    now: FIXED_NOW,
    newId: sequentialIds(),
    sessionId: "sess_park",
    state,
    approvals: { abandon: (id, reason) => (abandoned.push(`${id}: ${reason}`), true) },
  });
  return { gateway, runner };
}

const socialFake = () => fakeAdapter({ name: "social", tools: ["social_post"], approval: (action) => action.startsWith("social_post") });

describe("[S1.1] a parked run is saved with the session", () => {
  it("records the run, the session, the held approval id and the pending call", async () => {
    const session = memorySession();
    const state = memoryState();
    await collect(processOver({ adapters: [socialFake()] }, [toolCall(POST)], session, state).runner.run({ objective: "Announce the tables." }));
    expect(state.saved?.parked).toEqual([
      expect.objectContaining({ runId: "solo_1", stepId: "solo_1-trent", sessionId: "sess_park", approvalId: "appr_test", objective: "Announce the tables.", pending: [{ adapter: "social", action: POST }] }),
    ]);
  });
});

describe("[S1.1] after a restart", () => {
  it("parked() lists the run, and approve + resume continue it: the held call runs once and the model sees the run so far", async () => {
    const session = memorySession();
    const state = memoryState();
    await collect(processOver({ adapters: [socialFake()] }, [toolCall(POST)], session, state).runner.run({ objective: "Announce the tables." }));

    const social = socialFake();
    const { runner, gateway } = processOver({ adapters: [social] }, ["Posted."], session, state);
    expect(runner.parked()).toEqual([{ runId: "solo_1", stepId: "solo_1-trent", adapter: "social", action: POST, summary: HOLD, approvalId: "appr_test" }]);

    expect(await runner.approve("solo_1", "solo_1-trent")).toBe(true);
    const resumed = await collect(runner.resume("solo_1"));
    expect(kinds(resumed)).toEqual(["step_approved", "step_output", "step_output", "step_end", "run_done"]);
    expect(social.calls).toEqual([{ action: POST, payload: {}, context: { runId: "solo_1", stepId: "solo_1-trent" } }]);
    expect(toolCallsOf(resumed[1]).map((r) => r.status)).toEqual(["needs_approval", "completed"]);

    const told = transcriptOf(gateway.requests[0]);
    expect(told[0]).toContain("Announce the tables.");
    expect(told[1]).toBe(`assistant: ${toolCall(POST)}`);
    expect(told[2]).toContain(`social ran ${POST}`);
    expect(runner.parked()).toEqual([]);
    expect(state.saved?.parked).toEqual([]);
  });

  it("a decision made on the row itself (trent approvals approve) is read on resume", async () => {
    const session = memorySession();
    const state = memoryState();
    const social = fakeAdapter({ name: "social", tools: ["social_post"] });
    const first = gateChain([social]);
    await collect(processOver(first, [toolCall(POST)], session, state).runner.run({ objective: "Announce the tables." }));
    const row = first.bindings.list()[0];
    expect(state.saved?.parked[0]?.approvalId).toBe(row?.id);
    first.bindings.decide(row?.id ?? "", "approved", "founder");

    const restarted = gateChain([social], { rows: first.rows, idempotency: first.idempotency });
    const { runner } = processOver(restarted, ["Posted."], session, state);
    const resumed = await collect(runner.resume("solo_1"));
    expect(kinds(resumed).at(-1)).toBe("run_done");
    expect(social.calls).toHaveLength(1);
  });

  it("with no decision yet, resume raises the gate again and the park stays", async () => {
    const session = memorySession();
    const state = memoryState();
    await collect(processOver({ adapters: [socialFake()] }, [toolCall(POST)], session, state).runner.run({ objective: "Announce the tables." }));
    const { runner } = processOver({ adapters: [socialFake()] }, [], session, state);
    expect(kinds(await collect(runner.resume("solo_1")))).toEqual(["step_awaiting_approval", "run_awaiting_approval"]);
    expect(runner.parked()).toHaveLength(1);
  });

  it("when the runtime cannot rebuild it, the row is marked abandoned, the conversation gets one line, and the run ends with a verdict", async () => {
    const session = memorySession();
    const state = memoryState();
    await collect(processOver({ adapters: [socialFake()] }, [toolCall(POST)], session, state).runner.run({ objective: "Announce the tables." }));

    const abandoned: string[] = [];
    const { runner } = processOver({ adapters: [] }, [], session, state, abandoned);
    await runner.approve("solo_1", "solo_1-trent");
    const events = await collect(runner.resume("solo_1"));

    expect(kinds(events)).toEqual(["step_end", "run_failed"]);
    const summary = verdictOf(events.at(-1))?.summary ?? "";
    expect(summary).toContain("could not be rebuilt after a restart");
    expect(summary).toContain('the tool "social" is not in this build');
    expect(abandoned).toEqual([expect.stringMatching(/^appr_test: /)]);
    const line = session.messages.at(-1);
    expect(line).toMatchObject({ role: "tool", runId: "solo_1", record: { adapter: "social", action: POST, status: "blocked" } });
    expect(line?.record?.summary).toMatch(/^not run: .*appr_test.*abandoned/);
    expect(runner.parked()).toEqual([]);
    expect(state.saved?.parked).toEqual([]);
  });

  it("a new run on the session abandons the parked one with the same line, never silently", async () => {
    const session = memorySession();
    const state = memoryState();
    await collect(processOver({ adapters: [socialFake()] }, [toolCall(POST)], session, state).runner.run({ objective: "Announce the tables." }));
    const abandoned: string[] = [];
    const { runner } = processOver({ adapters: [socialFake()] }, ["It is noon."], session, state, abandoned);
    await collect(runner.run({ objective: "Never mind, what time is it?" }));
    expect(abandoned).toEqual([expect.stringMatching(/^appr_test: /)]);
    expect(session.messages.map((m) => [m.role, m.record?.status])).toEqual([
      ["user", undefined],
      ["assistant", undefined],
      ["tool", "needs_approval"],
      ["tool", "blocked"],
      ["user", undefined],
      ["assistant", undefined],
    ]);
    expect(runner.parked()).toEqual([]);
  });
});

describe("[S1.1] the session store keeps the solo state beside the transcript", () => {
  it("round-trips it owner-only, outside the listing, and removes it with the session", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-state-"));
    temps.push(dir);
    const store = new SessionStore(dir);
    const session = store.createNew("trent", "qwen3.5:9b", "openai");
    const state = sessionStoreState(store, session.id);
    expect(state.load()).toBeUndefined();

    state.save({ version: 1, taint: { calls: [], sources: ["web_extract"] }, parked: [] });
    expect(state.load()).toEqual({ version: 1, taint: { calls: [], sources: ["web_extract"] }, parked: [] });
    const file = store.soloStatePath(session.id);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(store.list().map((s) => s.id)).toEqual([session.id]);

    expect(store.delete(session.id)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });
});
