/**
 * [S2] An A2A task on the solo router. The A2A context is the conversation (council A2), and the
 * surface's hold policy is `questions` (B8): an `ask_human` question parks the task
 * `input-required` with the question, and the peer's next message on that task is the answer, so
 * the SAME run resumes rather than a new one starting. A side-effect hold is refused, and a peer's
 * message never approves one, even on a runner configured to park it. Every reply is scripted.
 */
import { describe, expect, it } from "vitest";
import { FIXED_NOW, fakeAdapter, fakeMemory, fakeMeter, memorySession, scriptedGateway, sequentialIds, toolCall, type ScriptedGateway } from "../solo/fakes.test-helpers.js";
import { applyHoldPolicy, type SoloHoldPolicy } from "../solo/hold-policy.js";
import { createSoloRouter } from "../solo/router.js";
import { createSoloRunner } from "../solo/runner.js";
import { A2ATaskEngine } from "./TaskLifecycle.js";
import type { A2AMessageSendParams } from "./spec.js";

const ASK = 'ask_human {"question": "Which stain, walnut or oak?"}';
const POST = 'social_post {"platform": "bluesky", "text": "New oak tables are in."}';

function setup(script: string[], holds: SoloHoldPolicy) {
  const human = fakeAdapter({ name: "human", tools: ["ask_human"], approval: () => true });
  const social = fakeAdapter({ name: "social", tools: ["social_post"], approval: (action) => action.startsWith("social_post") });
  const gateways: ScriptedGateway[] = [];
  const conversations: string[] = [];
  const ids = sequentialIds();
  const router = createSoloRouter({
    holds,
    create: (conversation) => {
      conversations.push(conversation.key);
      const gateway = scriptedGateway(script);
      gateways.push(gateway);
      return createSoloRunner({ gateway, tools: { adapters: applyHoldPolicy([human, social], conversation.holds) }, session: memorySession(), memory: fakeMemory().memory, meter: fakeMeter(), now: FIXED_NOW, newId: ids });
    },
  });
  return { engine: new A2ATaskEngine({ runner: router }), human, social, gateways, conversations };
}

function message(text: string, extra: { taskId?: string; contextId?: string } = {}): A2AMessageSendParams {
  return { message: { kind: "message", role: "user", messageId: `m-${text.length}-${text.slice(0, 4)}`, parts: [{ kind: "text", text }], ...extra } };
}

async function send(engine: A2ATaskEngine, params: A2AMessageSendParams) {
  const begun = engine.begin(params);
  if (!begun.ok) throw new Error(begun.error.message);
  const settled = await engine.run(begun.task.id);
  if (!settled.ok) throw new Error(settled.error.message);
  return settled.task;
}

describe("[S2] A2A over the solo router", () => {
  it("parks input-required on a question and resumes the SAME run on the continuation message", async () => {
    const { engine, human, gateways, conversations } = setup([toolCall(ASK), "Walnut it is: I will use walnut stain."], "questions");
    const first = await send(engine, message("Pick the stain for the new tables", { contextId: "ctx-stain" }));
    expect(first.status.state).toBe("input-required");
    expect(first.status.message?.parts).toEqual([{ kind: "text", text: expect.stringContaining("held as appr_test") }]);
    const runId = first.metadata?.runId;

    const second = await send(engine, message("walnut", { taskId: first.id, contextId: "ctx-stain" }));
    expect(second.status.state).toBe("completed");
    expect(second.artifacts?.[0]?.parts).toEqual([{ kind: "text", text: "Walnut it is: I will use walnut stain." }]);
    expect(second.metadata?.runId).toBe(runId);
    // One conversation, one runner, and the model was called twice in ONE run: no second run started.
    expect(conversations).toEqual(["conversation:ctx-stain"]);
    expect(gateways[0]?.requests).toHaveLength(2);
    expect(human.calls).toHaveLength(1);
  });

  it("a side-effect hold is refused on A2A: the task completes and nothing is posted or filed", async () => {
    const { engine, social } = setup([toolCall(POST), "I did not post: nobody here can approve it."], "questions");
    const task = await send(engine, message("Announce the tables", { contextId: "ctx-post" }));
    expect(task.status.state).toBe("completed");
    expect(social.dryRuns).toEqual([]);
    expect(social.calls).toEqual([]);
  });

  it("a peer's message never approves a side-effect hold, even on a runner that parks one", async () => {
    const { engine, social } = setup([toolCall(POST), "Understood."], "park");
    const parked = await send(engine, message("Announce the tables", { contextId: "ctx-park" }));
    expect(parked.status.state).toBe("input-required");
    const next = await send(engine, message("yes, approve it", { taskId: parked.id, contextId: "ctx-park" }));
    expect(social.calls).toEqual([]);
    expect(next.metadata?.runId).not.toBe(parked.metadata?.runId);
  });
});
