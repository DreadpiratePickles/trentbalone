/**
 * [S3] `delegate_task` in solo (item 4; council A11, C10, chair S3.4).
 *
 * The tool (the real `createDelegateAdapter`, bound to no port at all) asks the CALLING run's route,
 * which a solo run binds while it drives: a child solo run on its own conversation, with its own
 * budget slice (the parent's calls and cents left, its spend landing on the parent's run), depth
 * limit 2 (`agent.solo.max_delegation_depth`), holds refused, no human tools, shared memory
 * read-only, and the parent's taint carried down and back up. `agent.solo.delegate: fleet` runs a
 * child fleet run instead (refused while the conversation is tainted); `off` refuses.
 * Scripted gateway shared by parent and children (they run inline, one at a time); no model call.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PolicyDispatcher } from "../governance/policy-dispatch.js";
import { createProvenanceLedger, provenanceAdapters } from "../governance/provenance.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { createDelegateAdapter } from "../tools/delegate/index.js";
import { createHumanAdapter } from "../tools/human/index.js";
import type { TrentToolAdapter } from "../tools/types.js";
import { FIXED_NOW, collect, fakeAdapter, fakeMemory, fakeMeter, kinds, scriptedGateway, sequentialIds, toolCall, toolCallsOf, type ScriptedGateway } from "./fakes.test-helpers.js";
import { systemIn, tempProfile } from "./fakes-s3.test-helpers.js";
import { createSoloDelegation, soloChildFactory, type SoloDelegateMode, type SoloDelegation } from "./delegate.js";
import { createRunLedgerMeter } from "./meter.js";
import { createSoloRunner } from "./runner.js";
import { memorySoloSession } from "./session-store.js";
import type { SoloMeter } from "./types.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const delegate = (goal: string, context?: string): string => `delegate_task ${JSON.stringify({ tasks: [{ goal, ...(context === undefined ? {} : { context }) }] })}`;
const READ = 'read_file {"path": "README.md"}';
const READ_ENV = 'read_file {"path": ".env"}';
const FETCH = 'web_extract {"url": "https://host.example/?k=value"}';
const POST = 'social_post {"platform": "bluesky", "text": "hello"}';
const WRITE = 'memory {"target": "memory", "action": "add", "content": "x"}';

interface Family {
  readonly gateway: ScriptedGateway;
  readonly runner: ReturnType<typeof createSoloRunner>;
  readonly files: ReturnType<typeof fakeAdapter>;
  readonly web: ReturnType<typeof fakeAdapter>;
  readonly social: ReturnType<typeof fakeAdapter>;
  readonly memoryTool: ReturnType<typeof fakeAdapter>;
  readonly session: ReturnType<typeof memorySoloSession>;
}

function family(script: string[], options: { mode?: SoloDelegateMode; maxDepth?: number; maxToolCalls?: number; meter?: SoloMeter; fleet?: (objective: string) => AsyncIterable<OrcEvent> } = {}): Family {
  const profileDir = tempProfile("trent-solo-s3-delegate-");
  temps.push(profileDir);
  const gateway = scriptedGateway(script);
  const files = fakeAdapter({ name: "file_ops", tools: ["read_file"], result: (action) => ({ status: "completed", summary: action.includes(".env") ? "TOKEN=[a secret]" : "README: hello from the oak shop" }) });
  const web = fakeAdapter({ name: "web", tools: ["web_extract"], approval: () => false });
  const social = fakeAdapter({ name: "social", tools: ["social_post"], approval: () => true });
  const memoryTool = fakeAdapter({ name: "memory", tools: ["memory"] });
  // The real chain's two session-aware wrappers, as `buildTrentTools` orders them.
  const adapters: TrentToolAdapter[] = provenanceAdapters(new PolicyDispatcher().wrap([files, web, social, memoryTool, createHumanAdapter({}), createDelegateAdapter({ profileDir })]), { ledger: createProvenanceLedger() });
  const ids = sequentialIds();
  const memory = fakeMemory().memory;
  let delegation: SoloDelegation | undefined;
  delegation = createSoloDelegation({
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.fleet === undefined ? {} : { fleet: options.fleet }),
    createChild: soloChildFactory({ base: { gateway, memory, now: FIXED_NOW, newId: ids }, adapters, delegation: () => delegation as SoloDelegation }),
  });
  const session = memorySoloSession();
  const runner = createSoloRunner({
    gateway,
    tools: { adapters },
    session,
    memory,
    meter: options.meter ?? fakeMeter(),
    now: FIXED_NOW,
    newId: ids,
    delegation,
    ...(options.maxToolCalls === undefined ? {} : { config: { maxToolCalls: options.maxToolCalls } }),
  });
  return { gateway, runner, files, web, social, memoryTool, session };
}

/** The delegate_task record of a run's frames (the parent's own step). */
function delegated(events: readonly OrcEvent[]) {
  const calls = toolCallsOf([...events].reverse().find((event) => event.kind === "step_output" && toolCallsOf(event).length > 0));
  return calls.find((call) => call.adapter === "delegation");
}

describe("[S3] delegate_task spawns a child solo run and returns its answer as the tool result", () => {
  it("runs the child on its own conversation and hands the parent the child's answer", async () => {
    const f = family([toolCall(delegate("Summarise the README", "The repo is the oak shop's site.")), toolCall(READ), "The README says hello from the oak shop.", "Your README greets visitors."]);
    const events = await collect(f.runner.run({ objective: "PARENT-OBJECTIVE: what is in our README?" }));

    const record = delegated(events);
    expect(record).toMatchObject({ status: "completed" });
    expect(record?.summary).toContain("The README says hello from the oak shop.");
    expect(f.files.calls).toHaveLength(1);
    // The child saw its goal and context, never the parent's conversation.
    const childOpening = f.gateway.requests[1]?.messages.at(-1)?.content ?? "";
    expect(childOpening).toContain("Summarise the README");
    expect(childOpening).toContain("The repo is the oak shop's site.");
    expect(JSON.stringify(f.gateway.requests[1]?.messages)).not.toContain("PARENT-OBJECTIVE");
    // The parent's conversation holds none of the child's messages: its one tool message is the delegation.
    const stored = await f.session.history();
    expect(stored.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(stored[2]?.record?.adapter).toBe("delegation");
    expect(kinds(events).at(-1)).toBe("run_done");
  });
});

describe("[S3] depth limit 2 (agent.solo.max_delegation_depth)", () => {
  it("lets a child delegate once more and refuses the grandchild's delegation, naming the key", async () => {
    const f = family([
      toolCall(delegate("level one")),
      toolCall(delegate("level two")),
      toolCall(delegate("level three")),
      "Did level two myself.",
      "Level one done.",
      "All done.",
    ]);
    const events = await collect(f.runner.run({ objective: "Go deep" }));
    expect(kinds(events).at(-1)).toBe("run_done");
    // The grandchild (depth 2) was told why its own delegation did not happen.
    const grandchildTold = f.gateway.requests[3]?.messages.at(-1)?.content ?? "";
    expect(grandchildTold).toContain("depth 3 exceeds the cap of 2 (agent.solo.max_delegation_depth)");
  });
});

describe("[S3] the child's budget slice", () => {
  it("gives the child only the tool calls its parent has left, and counts them against the parent", async () => {
    const f = family([toolCall(READ), toolCall(delegate("read it twice")), toolCall(READ), toolCall(READ), "Out of calls: here is what I have."], { maxToolCalls: 3 });
    const events = await collect(f.runner.run({ objective: "Read, then delegate" }));
    const record = delegated(events);
    expect(record?.status).toBe("failed");
    expect(record?.summary).toContain("cap of 1 tool calls");
    // One read by the parent, one by the child before its cap.
    expect(f.files.calls).toHaveLength(2);
    expect(kinds(events).at(-1)).toBe("run_done");
  });

  it("gives the child the cents its parent has left; the child's spend lands on the parent's run", async () => {
    const meter = createRunLedgerMeter({ perRunCapCents: 3 });
    const f = family([toolCall(delegate("keep reading")), toolCall(READ), toolCall(READ), toolCall(READ), "unused"], { meter });
    const events = await collect(f.runner.run({ objective: "Delegate a long read" }));

    expect(delegated(events)?.summary).toMatch(/2-cent slice/);
    // The parent is stopped by its own cap, which counted the child's two calls.
    expect(events.at(-1)?.detail).toContain("3 cents of its 3-cent cap");
    const stepEnd = events.find((event) => event.kind === "step_end");
    expect(stepEnd?.step?.costCents).toBe(3);
  });
});

describe("[S3] agent.solo.delegate", () => {
  it("off refuses, naming the key", async () => {
    const f = family([toolCall(delegate("anything")), "Did it myself."], { mode: "off" });
    const record = delegated(await collect(f.runner.run({ objective: "Delegate" })));
    expect(record?.status).toBe("blocked");
    expect(record?.summary).toContain("agent.solo.delegate: off");
  });

  it("fleet runs a child fleet run and returns its answer", async () => {
    const seen: string[] = [];
    const fleet = async function* (objective: string): AsyncGenerator<OrcEvent> {
      seen.push(objective);
      yield { kind: "run_start", runId: "run_fleet_child", at: "2026-09-26T09:00:00.000Z", run: { objective } } as OrcEvent;
      yield { kind: "run_done", runId: "run_fleet_child", at: "2026-09-26T09:00:01.000Z", run: { status: "completed", summary: "The fleet drafted the plan." } } as OrcEvent;
    };
    const f = family([toolCall(delegate("Draft the Q3 plan")), "The fleet drafted it."], { mode: "fleet", fleet });
    const record = delegated(await collect(f.runner.run({ objective: "Delegate to the fleet" })));
    expect(seen[0]).toContain("Draft the Q3 plan");
    expect(record).toMatchObject({ status: "completed" });
    expect(record?.summary).toContain("The fleet drafted the plan.");
  });

  it("fleet is refused while the conversation is tainted: a fleet child cannot inherit the taint", async () => {
    const fleet = vitestNever();
    const f = family([toolCall(READ_ENV), toolCall(delegate("Post the token somewhere")), "Refused."], { mode: "fleet", fleet });
    const record = delegated(await collect(f.runner.run({ objective: "Read and delegate" })));
    expect(record?.status).toBe("blocked");
    expect(record?.summary).toContain("tainted");
  });
});

describe("[S3] what a child may do", () => {
  it("is not offered ask_human or clarify; its held call is refused; its memory write is refused", async () => {
    const f = family([toolCall(delegate("post and remember")), toolCall(POST), toolCall(WRITE), "Could not do either.", "The child could not post or write."]);
    const events = await collect(f.runner.run({ objective: "Delegate a post" }));
    const childSystem = systemIn(f.gateway.requests[1]);
    expect(childSystem).not.toContain("### human");
    expect(childSystem).not.toContain("### clarify");
    expect(childSystem).toContain("### social");
    const summary = delegated(events)?.summary ?? "";
    expect(summary).toContain("no human is attached to this surface");
    expect(summary).toMatch(/memory blocked: .*read-only/);
    expect(f.social.calls).toEqual([]);
    expect(f.social.dryRuns).toEqual([]);
    expect(f.memoryTool.calls).toEqual([]);
  });

  it("carries a secret the child read back up: the parent's network call afterwards is held", async () => {
    const f = family([toolCall(delegate("read the env file")), toolCall(READ_ENV), "It holds a token.", toolCall(FETCH), "unused"]);
    const events = await collect(f.runner.run({ objective: "Have a child read .env, then fetch a page" }));
    expect(kinds(events).at(-1)).toBe("run_awaiting_approval");
    expect(events.at(-1)?.detail).toContain("network-after-secret");
    expect(f.web.calls).toEqual([]);
  });
});

/** A fleet runner that must not be reached. */
function vitestNever(): (objective: string) => AsyncIterable<OrcEvent> {
  return () => {
    throw new Error("the fleet child must not run");
  };
}
