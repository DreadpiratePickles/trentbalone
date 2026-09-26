/**
 * [S2] The solo router: one runner per conversation (council A2), every frame teed to the runtime's
 * sinks (A12, B4), decisions dispatched by run id, a late decision announced so a driver can resume
 * the run (the gateway), and the hold policy of the surface (B8). Every model reply is scripted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../config/ConfigManager.js";
import { SessionManager } from "../sessions/SessionManager.js";
import { collectAgentRun } from "../agent-runner/index.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { FIXED_NOW, collect, fakeAdapter, fakeMemory, fakeMeter, gateChain, kinds, memorySession, scriptedGateway, sequentialIds, toolCall, toolCallsOf, type GateChain, type ScriptStep } from "./fakes.test-helpers.js";
import { sessionStoreState } from "./park.js";
import { profileSoloSession, savedSoloParks } from "./session-store.js";
import { NO_HUMAN_ATTACHED, applyHoldPolicy, type SoloHoldPolicy } from "./hold-policy.js";
import { createSoloRouter, type SoloConversation, type SoloRouteInput, type SoloRouter } from "./router.js";
import { createSoloRunner } from "./runner.js";

/** The AgentRunner fold over one routed run: `collectAgentRun` with the router's own input shape. */
const settle = (router: SoloRouter, input: SoloRouteInput) => collectAgentRun(router, input);

const POST = 'social_post {"platform": "bluesky", "text": "New oak tables are in."}';
const ASK = 'ask_human {"question": "Which colour?"}';

function setup(scripts: Record<string, string[]>, options: { holds?: SoloHoldPolicy } = {}) {
  const social = fakeAdapter({ name: "social", tools: ["social_post"], approval: (action) => action.startsWith("social_post") });
  const human = fakeAdapter({ name: "human", tools: ["ask_human"], approval: () => true });
  const frames: OrcEvent[] = [];
  const flushed: number[] = [];
  const created: SoloConversation[] = [];
  const ids = sequentialIds();
  const oneOffs = { n: 0 };
  const router = createSoloRouter({
    ...(options.holds === undefined ? {} : { holds: options.holds }),
    sinks: [{ sink: (event) => void frames.push(event), flush: async () => void flushed.push(frames.length) }],
    create: (conversation) => {
      created.push(conversation);
      const script = scripts[conversation.key] ?? scripts[conversation.key.startsWith("once:") ? `once:${String(++oneOffs.n)}` : ""] ?? [];
      return createSoloRunner({
        gateway: scriptedGateway(script),
        tools: { adapters: applyHoldPolicy([social, human], conversation.holds, conversation.surface) },
        session: memorySession(),
        memory: fakeMemory().memory,
        meter: fakeMeter(),
        now: FIXED_NOW,
        newId: ids,
      });
    },
  });
  return { router, social, human, frames, flushed, created };
}

describe("[S2] one runner per conversation (A2)", () => {
  it("builds one runner per session, reuses it for the next run, and keeps two threads apart", async () => {
    const { router, created } = setup({ "session:thread-a": ["Hello A.", "Again A."], "session:thread-b": ["Hello B."] }, { holds: "park" });
    await collect(router.run({ objective: "hi", session: "thread-a" }));
    await collect(router.run({ objective: "hi", session: "thread-b" }));
    await collect(router.run({ objective: "again", session: "thread-a" }));
    expect(created.map((c) => [c.key, c.sessionId, c.holds])).toEqual([
      ["session:thread-a", "thread-a", "park"],
      ["session:thread-b", "thread-b", "park"],
    ]);
  });

  it("a message on thread B neither cancels nor resumes thread A's held call; A's decision resumes A only", async () => {
    const { router, social } = setup({ "session:thread-a": [toolCall(POST), "Posted."], "session:thread-b": ["Nothing to post here."] }, { holds: "park" });
    const parkedA = await settle(router, { objective: "announce", session: "thread-a" });
    expect(parkedA.status).toBe("input-required");
    const b = await settle(router, { objective: "hello", session: "thread-b" });
    expect(b).toMatchObject({ status: "completed", output: "Nothing to post here." });
    expect(router.parked()).toEqual([expect.objectContaining({ runId: parkedA.runId, adapter: "social" })]);

    const late: string[] = [];
    router.onLateDecision((runId) => void late.push(runId));
    expect(await router.approve(parkedA.runId!, `${parkedA.runId!}-trent`)).toBe(true);
    expect(late).toEqual([parkedA.runId]);
    const resumed = await collect(router.resume(parkedA.runId!));
    expect(kinds(resumed)).toEqual(["step_approved", "step_output", "step_output", "step_end", "run_done"]);
    expect(social.calls.map((c) => c.action)).toEqual([POST]);
    expect(router.parked()).toEqual([]);
    expect(router.conversationOf(parkedA.runId!)).toBeUndefined();
  });

  it("an in-stream decision (the REPL shape) continues the same stream and is not announced as late", async () => {
    const { router, social } = setup({ "session:repl": [toolCall(POST), "Posted."] }, { holds: "park" });
    const late: string[] = [];
    router.onLateDecision((runId) => void late.push(runId));
    const seen: OrcEvent[] = [];
    for await (const event of router.run({ objective: "announce", session: "repl" })) {
      seen.push(event);
      if (event.kind === "step_awaiting_approval") expect(await router.approve(event.runId, event.step!.id!)).toBe(true);
    }
    expect(kinds(seen).slice(-4)).toEqual(["step_output", "step_output", "step_end", "run_done"]);
    expect(social.calls).toHaveLength(1);
    expect(late).toEqual([]);
  });

  it("refuses a decision or a resume for a run it does not own", async () => {
    const { router } = setup({});
    expect(await router.approve("solo_404", "solo_404-trent")).toBe(false);
    expect(await router.reject("solo_404", "solo_404-trent")).toBe(false);
    await expect(collect(router.resume("solo_404"))).rejects.toThrow(/no parked solo run solo_404/);
  });
});

describe("[S2] every frame reaches the runtime's sinks (A12, B4)", () => {
  it("tees each frame in order, flushes once per stream, and names the run's conversation while it lives", async () => {
    const { router, frames, flushed } = setup({ "conversation:ctx-1": [toolCall(POST)] }, { holds: "park" });
    const events = await collect(router.run({ objective: "announce", conversation: "ctx-1", surface: "a2a" }));
    expect(frames).toEqual(events);
    expect(flushed).toEqual([events.length]);
    expect(router.conversationOf(events[0]!.runId)).toMatchObject({ key: "conversation:ctx-1", surface: "a2a" });
  });
});

describe("[S2] the hold policy of the surface (B8)", () => {
  it("a one-off run refuses a held call without filing a row, and the model answers from the refusal", async () => {
    const { router, social, created } = setup({ "once:1": [toolCall(POST), "I could not post: nobody is here to approve it."] }, { holds: "park" });
    const events = await collect(router.run({ objective: "announce" }));
    expect(created[0]?.holds).toBe("deny");
    expect(kinds(events)).toEqual(["run_start", "step_start", "step_output", "step_output", "step_end", "run_done"]);
    const [refused] = toolCallsOf(events[2]);
    expect(refused).toMatchObject({ adapter: "social", action: POST, status: "blocked" });
    expect(refused?.summary).toContain(NO_HUMAN_ATTACHED);
    expect(social.dryRuns).toEqual([]);
    expect(social.calls).toEqual([]);
    expect(router.parked()).toEqual([]);
  });

  it("questions: an ask_human question parks, a side-effect hold on the same conversation is refused", async () => {
    const { router, human, social } = setup({ "conversation:ctx-q": [toolCall(ASK), toolCall(POST), "Asked, and did not post."] }, { holds: "questions" });
    const first = await settle(router, { objective: "ask first", conversation: "ctx-q" });
    expect(first.status).toBe("input-required");
    expect(human.dryRuns).toHaveLength(1);
    expect(await router.answer(first.runId!, `${first.runId!}-trent`, "walnut")).toBe(true);
    const resumed = await collect(router.resume(first.runId!));
    expect(kinds(resumed).at(-1)).toBe("run_done");
    expect(social.dryRuns).toEqual([]);
    expect(toolCallsOf(resumed.at(-3)).find((call) => call.adapter === "social")?.status).toBe("blocked");
  });

  it("a conversation takes the router's policy, and a run may name its own", async () => {
    const { router, created } = setup({ "session:s1": ["a"], "session:s2": ["b"] }, { holds: "park" });
    await collect(router.run({ objective: "x", session: "s1" }));
    await collect(router.run({ objective: "y", session: "s2", holds: "deny" }));
    expect(created.map((c) => c.holds)).toEqual(["park", "deny"]);
  });
});

describe("[S2] after a restart: the parks an earlier process saved (S1.1's sidecar)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** One process: a router over the profile's sessions, its runners saving their state beside each transcript. */
  function processOn(sessions: SessionManager, chain: GateChain, script: ScriptStep[], ids = sequentialIds()) {
    const gateway = scriptedGateway(script);
    const router = createSoloRouter({
      holds: "park",
      saved: () => savedSoloParks(sessions.getStore()),
      pendingApprovals: () => new Set(chain.bindings.list().map((row) => row.id)),
      create: (conversation) =>
        createSoloRunner({
          gateway,
          tools: { adapters: chain.adapters, bindings: chain.bindings },
          session: conversation.sessionId === undefined ? memorySession() : profileSoloSession(sessions, conversation.sessionId),
          memory: fakeMemory().memory,
          meter: fakeMeter(),
          now: FIXED_NOW,
          newId: ids,
          ...(conversation.sessionId === undefined ? {} : { sessionId: conversation.sessionId, state: sessionStoreState(sessions.getStore(), conversation.sessionId) }),
        }),
    });
    return { router, gateway };
  }

  function profile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-router-restart-"));
    dirs.push(dir);
    const sessions = new SessionManager(new ConfigManager({ baseDir: dir }));
    return { sessions, id: sessions.startSession("trent", "gemini-test", "google").id };
  }

  it("a new process lists the saved park, and a row decided by `trent approvals approve` is swept to a late decision and resumed", async () => {
    const { sessions, id } = profile();
    const social = fakeAdapter({ name: "social", tools: ["social_post"] });
    const first = gateChain([social]);
    const before = processOn(sessions, first, [toolCall(POST)]);
    const parked = await collect(before.router.run({ objective: "announce", session: id }));
    expect(kinds(parked).at(-1)).toBe("run_awaiting_approval");
    const runId = parked[0]!.runId;
    const rowId = first.bindings.list()[0]!.id;

    // The process ends. A new one (fresh router, fresh runners) is built over the same profile.
    const chain = gateChain([social], { rows: first.rows, idempotency: first.idempotency });
    const after = processOn(sessions, chain, ["Posted."]);
    expect(after.router.parked()).toEqual([expect.objectContaining({ runId, approvalId: rowId })]);
    expect(after.router.conversationOf(runId)).toMatchObject({ key: `session:${id}`, sessionId: id });
    const late: string[] = [];
    after.router.onLateDecision((decided) => void late.push(decided));
    expect(after.router.sweep()).toEqual([]);

    first.bindings.decide(rowId, "approved", "trent approvals");
    expect(after.router.sweep()).toEqual([runId]);
    expect(after.router.sweep()).toEqual([]);
    expect(late).toEqual([runId]);
    const resumed = await collect(after.router.resume(runId));
    expect(kinds(resumed).at(-1)).toBe("run_done");
    expect(social.calls).toHaveLength(1);
    expect(after.router.parked()).toEqual([]);
  });

  it("an approve that arrives in the new process finds the saved park by its run id", async () => {
    const { sessions, id } = profile();
    const social = fakeAdapter({ name: "social", tools: ["social_post"] });
    const first = gateChain([social]);
    const parked = await collect(processOn(sessions, first, [toolCall(POST)]).router.run({ objective: "announce", session: id }));
    const runId = parked[0]!.runId;
    const after = processOn(sessions, gateChain([social], { rows: first.rows, idempotency: first.idempotency }), ["Posted."]);
    const late: string[] = [];
    after.router.onLateDecision((decided) => void late.push(decided));
    expect(await after.router.approve(runId, `${runId}-trent`)).toBe(true);
    expect(late).toEqual([runId]);
    expect(kinds(await collect(after.router.resume(runId))).at(-1)).toBe("run_done");
    expect(social.calls).toHaveLength(1);
  });
});
