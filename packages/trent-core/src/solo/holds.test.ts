/**
 * [S1.1] B6: a hold raised again after a yes must not bounce the run forever, filing a row per round.
 * Through the real gate chain (`gateChain`: the class floor, bound approval rows, idempotency):
 *   - the same call approved once in this run is answered from the idempotency store: no second
 *     hold, no second post, no second row;
 *   - a call that differs from the approved one gets exactly one new row, and its hold names the
 *     difference;
 *   - a `needs_approval` that `execute` returns (after a yes, or from a gate inside the adapter) is
 *     that call's result, not a second park, and it counts towards the misuse stop.
 */
import { describe, expect, it } from "vitest";
import type { ApprovalRow } from "../gateway/store/GatewayStore.js";
import { FIXED_NOW, collect, fakeAdapter, fakeMemory, fakeMeter, gateChain, kinds, memorySession, scriptedGateway, sequentialIds, toolCall, toolCallsOf, transcriptOf, type ScriptStep } from "./fakes.test-helpers.js";
import { createSoloRunner } from "./runner.js";
import type { SoloTools } from "./types.js";

const POST = 'social_post {"platform": "bluesky", "text": "New oak tables are in."}';
const POST_EDITED = 'social_post {"platform": "bluesky", "text": "New oak tables are in! 10% off."}';

function runnerOver(tools: SoloTools, script: readonly ScriptStep[]) {
  const gateway = scriptedGateway(script);
  const runner = createSoloRunner({ gateway, tools, session: memorySession(), memory: fakeMemory().memory, meter: fakeMeter(), now: FIXED_NOW, newId: sequentialIds() });
  return { gateway, runner };
}

const rowsOf = (store: { snapshot(): { approvals: Record<string, ApprovalRow> } }): ApprovalRow[] => Object.values(store.snapshot().approvals);

describe("[S1.1] B6: the same call approved once is not asked again", () => {
  it("re-issued after its yes, it is answered from the idempotency store: one post, one row, no second gate", async () => {
    const social = fakeAdapter({ name: "social", tools: ["social_post"] });
    const chain = gateChain([social]);
    const { runner } = runnerOver(chain, [toolCall(POST), toolCall(POST), "Posted once."]);

    const parked = await collect(runner.run({ objective: "Announce the tables." }));
    expect(kinds(parked).at(-1)).toBe("run_awaiting_approval");
    expect(await runner.approve("solo_1", "solo_1-trent")).toBe(true);
    const resumed = await collect(runner.resume("solo_1"));

    expect(kinds(resumed)).toEqual(["step_approved", "step_output", "step_output", "step_output", "step_end", "run_done"]);
    expect(toolCallsOf(resumed[2]).map((r) => r.status)).toEqual(["needs_approval", "completed", "completed"]);
    expect(social.calls).toHaveLength(1);
    expect(rowsOf(chain.rows).map((row) => row.status)).toEqual(["approved"]);
  });
});

describe("[S1.1] B6: a call that differs from the approved one", () => {
  it("gets one new row, whose hold names what changed; raising the gate again files nothing more", async () => {
    const social = fakeAdapter({ name: "social", tools: ["social_post"] });
    const chain = gateChain([social]);
    const { runner } = runnerOver(chain, [toolCall(POST), toolCall(POST_EDITED), "unused"]);

    await collect(runner.run({ objective: "Announce the tables." }));
    const [first] = rowsOf(chain.rows);
    await runner.approve("solo_1", "solo_1-trent");
    const resumed = await collect(runner.resume("solo_1"));
    expect(kinds(resumed).at(-1)).toBe("run_awaiting_approval");

    const detail = resumed.at(-1)?.detail ?? "";
    expect(detail).toContain(`differs from the call approved as ${first?.id ?? "?"}`);
    expect(detail).toContain('text: "New oak tables are in." -> "New oak tables are in! 10% off."');
    expect(rowsOf(chain.rows)).toHaveLength(2);

    expect(kinds(await collect(runner.resume("solo_1")))).toEqual(["step_awaiting_approval", "run_awaiting_approval"]);
    expect(rowsOf(chain.rows)).toHaveLength(2);
    expect(social.calls).toHaveLength(1);
  });
});

describe("[S1.1] B6: a hold that execute returns is the call's result", () => {
  it("after a yes, a second hold from inside the adapter goes back to the model, and the run finishes", async () => {
    const social = fakeAdapter({
      name: "social",
      tools: ["social_post"],
      result: () => ({ status: "needs_approval", summary: "social: the provider's own review holds this post as appr_9_abcdef." }),
    });
    const chain = gateChain([social]);
    const { runner, gateway } = runnerOver(chain, [toolCall(POST), "The post is waiting on the provider's review."]);

    await collect(runner.run({ objective: "Announce the tables." }));
    await runner.approve("solo_1", "solo_1-trent");
    const resumed = await collect(runner.resume("solo_1"));

    expect(kinds(resumed)).toEqual(["step_approved", "step_output", "step_output", "step_end", "run_done"]);
    const told = transcriptOf(gateway.requests[1]).at(-1) ?? "";
    expect(told).toContain('status="needs_approval"');
    expect(told).toContain("appr_9_abcdef");
    expect(told).toContain("trent approvals");
    expect(runner.parked()).toEqual([]);
  });

  it("the same call held by execute three times stops the run on the misuse rule", async () => {
    const memoryTool = fakeAdapter({ name: "memory", tools: ["memory"], result: () => ({ status: "needs_approval", summary: "memory held for approval: Held as appr_1_000001." }) });
    const WRITE = 'memory {"action": "add", "content": "x"}';
    const { runner } = runnerOver({ adapters: [memoryTool] }, [toolCall(WRITE), toolCall(WRITE), toolCall(WRITE), "unused"]);
    const events = await collect(runner.run({ objective: "Remember x" }));
    expect(kinds(events)).toEqual(["run_start", "step_start", "step_output", "step_output", "step_output", "step_end", "run_failed"]);
    expect(events.at(-1)?.detail).toContain("the same tool call was held 3 times: memory");
    expect(memoryTool.calls).toHaveLength(3);
  });
});
