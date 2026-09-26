/**
 * [S1] A held call parks the solo run exactly as a seat's parks: `dryRun` inside the run's
 * tool-call context (so the bound approval row is stamped, `governance/bound-approvals.ts`),
 * `step_awaiting_approval` then `run_awaiting_approval` carrying the held record, and a stream
 * that ends with no terminal frame, which the AgentRunner fold reads as `input-required`. The
 * answer continues the same run: in-stream when it arrives before the next pull (the REPL blocks
 * on the gate event), or through `resume` when it arrives later (the gateway, A2A).
 */
import { describe, expect, it } from "vitest";
import { collectAgentRun } from "../agent-runner/index.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { HumanAnswers, questionFromEvent } from "../tools/human/index.js";
import { FIXED_NOW, collect, fakeAdapter, fakeMemory, fakeMeter, kinds, memorySession, scriptedGateway, sequentialIds, toolCall, toolCallsOf, transcriptOf } from "./fakes.test-helpers.js";
import { createSoloRunner } from "./runner.js";

const POST = 'social_post {"platform": "bluesky", "text": "New oak tables are in."}';
const ANSWER = "Posted the announcement.";

function setup(script: string[], humanAnswers?: HumanAnswers) {
  const social = fakeAdapter({ name: "social", tools: ["social_post"], approval: (action) => action.startsWith("social_post") });
  const gateway = scriptedGateway(script);
  const session = memorySession();
  const meter = fakeMeter({ centsPerCall: 3 });
  const runner = createSoloRunner({
    gateway,
    tools: { adapters: [social] },
    session,
    memory: fakeMemory().memory,
    meter,
    now: FIXED_NOW,
    newId: sequentialIds(),
    ...(humanAnswers ? { humanAnswers } : {}),
  });
  return { social, gateway, session, meter, runner };
}

describe("[S1] a held call parks the run", () => {
  it("runs dryRun (never execute), emits both gate frames with the held record, and ends as input-required", async () => {
    const { runner, social, session, meter, gateway } = setup([toolCall(POST)]);
    const outcome = await collectAgentRun(runner, { objective: "Announce the new tables." });
    expect(outcome).toMatchObject({ status: "input-required", runId: "solo_1" });
    expect(outcome.question).toContain("held as appr_test");

    const events = await collect(setup([toolCall(POST)]).runner.run({ objective: "Announce the new tables." }));
    expect(kinds(events)).toEqual(["run_start", "step_start", "step_output", "step_awaiting_approval", "run_awaiting_approval"]);
    expect(toolCallsOf(events[2])).toEqual([{ adapter: "social", action: POST, status: "needs_approval", summary: `social: ${POST} is held as appr_test until a human approves exactly this call.` }]);
    for (const gate of events.slice(3)) {
      expect(gate.step).toMatchObject({ id: "solo_1-trent", agentRole: "trent", status: "awaiting_approval", needsApproval: true, title: `social ${POST}` });
      expect(gate.detail).toBe(`social: ${POST} is held as appr_test until a human approves exactly this call.`);
      expect(toolCallsOf(gate)).toHaveLength(1);
    }
    expect(events[4]?.run).toMatchObject({ id: "solo_1", status: "awaiting_approval" });

    expect(social.calls).toEqual([]);
    expect(social.dryRuns).toEqual([{ action: POST, payload: {}, context: { runId: "solo_1", stepId: "solo_1-trent" } }]);
    expect(runner.parked()).toEqual([{ runId: "solo_1", stepId: "solo_1-trent", adapter: "social", action: POST, summary: `social: ${POST} is held as appr_test until a human approves exactly this call.`, approvalId: "appr_test" }]);
    // The hold is the call's result for now: the transcript never shows a call with no answer.
    expect(session.messages.map((m) => [m.role, m.record?.status])).toEqual([["user", undefined], ["assistant", undefined], ["tool", "needs_approval"]]);
    // A parked run's spend reaches the ledger now; the scope reopens on resume.
    expect(meter.closed).toEqual(["solo_1"]);
    expect(gateway.requests).toHaveLength(1);
  });

  it("the resumed run continues with the approval: the held call runs once, in the same step, and the run completes", async () => {
    const { runner, social, gateway, session, meter } = setup([toolCall(POST), ANSWER]);
    const parked = await collect(runner.run({ objective: "Announce the new tables." }));
    expect(kinds(parked).at(-1)).toBe("run_awaiting_approval");

    expect(await runner.approve("solo_1", "solo_1-trent")).toBe(true);
    const resumed = await collect(runner.resume("solo_1"));
    expect(kinds(resumed)).toEqual(["step_approved", "step_output", "step_output", "step_end", "run_done"]);
    expect(resumed[0]?.step).toMatchObject({ id: "solo_1-trent", agentRole: "trent", status: "running" });
    expect(toolCallsOf(resumed[1]).map((r) => r.status)).toEqual(["needs_approval", "completed"]);
    expect(resumed[2]?.step?.output).toBe(ANSWER);
    // Both model calls are charged to the one step, across the park.
    expect(resumed[3]?.step).toMatchObject({ status: "completed", costCents: 6, tokens: 240 });
    expect(resumed[4]?.run).toMatchObject({ status: "completed", summary: ANSWER });

    expect(social.calls).toEqual([{ action: POST, payload: {}, context: { runId: "solo_1", stepId: "solo_1-trent" } }]);
    expect(transcriptOf(gateway.requests[1]).at(-1)).toContain(`social ran ${POST}`);
    expect(session.messages.map((m) => [m.role, m.record?.status])).toEqual([
      ["user", undefined],
      ["assistant", undefined],
      ["tool", "needs_approval"],
      ["tool", "completed"],
      ["assistant", undefined],
    ]);
    expect(runner.parked()).toEqual([]);
    expect(meter.opened).toEqual(["solo_1", "solo_1"]);
    expect(meter.closed).toEqual(["solo_1", "solo_1"]);
  });

  it("a decision made while the stream is held (the REPL shape) continues the same stream", async () => {
    const { runner, social } = setup([toolCall(POST), ANSWER]);
    const events: OrcEvent[] = [];
    for await (const event of runner.run({ objective: "Announce the new tables." })) {
      events.push(event);
      if (event.kind === "step_awaiting_approval") await runner.approve(event.runId, event.step?.id ?? "");
    }
    expect(kinds(events)).toEqual([
      "run_start", "step_start", "step_output", "step_awaiting_approval", "run_awaiting_approval",
      "step_approved", "step_output", "step_output", "step_end", "run_done",
    ]);
    expect(social.calls).toHaveLength(1);
  });

  it("a rejection is the call's result: blocked, never executed, and the model answers from it", async () => {
    const { runner, social, gateway } = setup([toolCall(POST), "Understood, nothing was posted."]);
    await collect(runner.run({ objective: "Announce the new tables." }));
    expect(await runner.reject("solo_1", "solo_1-trent")).toBe(true);
    const resumed = await collect(runner.resume("solo_1"));
    expect(kinds(resumed)).toEqual(["step_output", "step_output", "step_end", "run_done"]);
    expect(toolCallsOf(resumed[0]).at(-1)).toMatchObject({ adapter: "social", status: "blocked" });
    expect(toolCallsOf(resumed[0]).at(-1)?.summary).toContain("rejected");
    expect(social.calls).toEqual([]);
    expect(transcriptOf(gateway.requests[1]).at(-1)).toContain('status="blocked"');
  });

  it("an ask_human answer is stored for the replay and releases the call", async () => {
    const answers = new HumanAnswers();
    const human = fakeAdapter({ name: "human", tools: ["ask_human"], approval: () => true });
    const gateway = scriptedGateway([toolCall('ask_human {"question": "Walnut or oak stain?"}'), "Going with walnut."]);
    const runner = createSoloRunner({ gateway, tools: { adapters: [human] }, session: memorySession(), memory: fakeMemory().memory, meter: fakeMeter(), now: FIXED_NOW, newId: sequentialIds(), humanAnswers: answers });
    await collect(runner.run({ objective: "Pick a stain." }));
    expect(await runner.answer("solo_1", "solo_1-trent", "walnut")).toBe(true);
    expect(answers.take("solo_1", "solo_1-trent")).toBe("walnut");
  });

  it("a decision for a run that is not parked is refused, and resume says there is nothing to resume", async () => {
    const { runner } = setup([ANSWER]);
    expect(await runner.approve("solo_9", "solo_9-trent")).toBe(false);
    expect(await runner.reject("solo_9", "solo_9-trent")).toBe(false);
    await expect(collect(runner.resume("solo_9"))).rejects.toThrow(/no parked solo run solo_9/);
  });

  // [S1.1] The abandoned hold is no longer left as the call's last word (review B9): one line says it did not run.
  it("a new run on the session abandons the parked one: its decision is refused and one line says the call did not run", async () => {
    const { runner, social, session } = setup([toolCall(POST), "Something else, answered."]);
    await collect(runner.run({ objective: "Announce the new tables." }));
    const next = await collect(runner.run({ objective: "Never mind, what time is it?" }));
    expect(kinds(next).at(-1)).toBe("run_done");
    expect(runner.parked()).toEqual([]);
    expect(await runner.approve("solo_1", "solo_1-trent")).toBe(false);
    expect(social.calls).toEqual([]);
    expect(session.messages.map((m) => [m.role, m.record?.status])).toEqual([
      ["user", undefined],
      ["assistant", undefined],
      ["tool", "needs_approval"],
      ["tool", "blocked"],
      ["user", undefined],
      ["assistant", undefined],
    ]);
    expect(session.messages[3]?.record?.summary).toMatch(/^not run: a new message started another run/);
  });

  it("resume with no decision yet re-raises the gate and ends again as input-required", async () => {
    const { runner } = setup([toolCall(POST), ANSWER]);
    await collect(runner.run({ objective: "Announce the new tables." }));
    const again = await collect(runner.resume("solo_1"));
    expect(kinds(again)).toEqual(["step_awaiting_approval", "run_awaiting_approval"]);
    expect(runner.parked()).toHaveLength(1);
  });
});

describe("[S1.1] B2: a typed answer never releases a held tool call", () => {
  const ASK = 'ask_human {"question": "Walnut or oak stain?"}';

  function afterAnsweredQuestion() {
    const answers = new HumanAnswers();
    const human = fakeAdapter({ name: "human", tools: ["ask_human"], approval: () => true });
    const social = fakeAdapter({ name: "social", tools: ["social_post"], approval: (action) => action.startsWith("social_post") });
    const gateway = scriptedGateway([toolCall(ASK), toolCall(POST), "unused"]);
    const runner = createSoloRunner({ gateway, tools: { adapters: [human, social] }, session: memorySession(), memory: fakeMemory().memory, meter: fakeMeter(), now: FIXED_NOW, newId: sequentialIds(), humanAnswers: answers });
    return { runner, social };
  }

  it("the gate frames of a later social_post name that call, so no surface shows the answered question as its card", async () => {
    const { runner } = afterAnsweredQuestion();
    await collect(runner.run({ objective: "Pick a stain and announce it." }));
    expect(await runner.answer("solo_1", "solo_1-trent", "walnut")).toBe(true);
    const resumed = await collect(runner.resume("solo_1"));
    const gates = resumed.filter((event) => event.kind === "step_awaiting_approval" || event.kind === "run_awaiting_approval");
    expect(gates).toHaveLength(2);
    for (const gate of gates) {
      // The answered ask_human record is still in the cumulative list; the gate names the held post.
      expect(toolCallsOf(gate).map((r) => [r.adapter, r.status])).toContainEqual(["human", "needs_approval"]);
      expect((gate.step as { seatLoopState?: unknown }).seatLoopState).toEqual({ pendingToolCall: { name: "social", action: POST } });
      expect(questionFromEvent(gate)).toBeUndefined();
    }
  });

  it("answer() on a held post is refused and releases nothing; the gate is raised again on resume", async () => {
    const { runner, social } = afterAnsweredQuestion();
    await collect(runner.run({ objective: "Pick a stain and announce it." }));
    await runner.answer("solo_1", "solo_1-trent", "walnut");
    await collect(runner.resume("solo_1"));

    expect(await runner.answer("solo_1", "solo_1-trent", "yes, post it")).toBe(false);
    expect(kinds(await collect(runner.resume("solo_1")))).toEqual(["step_awaiting_approval", "run_awaiting_approval"]);
    expect(social.calls).toEqual([]);
  });

  it("an ask_human gate still reads as its question", async () => {
    const { runner } = afterAnsweredQuestion();
    const events = await collect(runner.run({ objective: "Pick a stain." }));
    const gate = events.at(-1);
    expect(gate?.kind).toBe("run_awaiting_approval");
    expect(questionFromEvent(gate!)?.question).toBe("Walnut or oak stain?");
  });
});
