/**
 * `ask_human`: the tool that hands a decision to the founder and waits. In a run the record parks
 * the step exactly like a tool approval; the answer comes back as the tool result on the replay.
 * In a delegated child the call is `blocked` with a one-line reason. Nothing here is fabricated:
 * a release without an answer is a `failed` record that says so.
 */
import { describe, expect, it } from "vitest";
import { runWithToolCallContext } from "../../governance/tool-call-context.js";
import { classifyCall } from "../../governance/policy-rules.js";
import { isSideEffecting } from "../../governance/idempotent-dispatch.js";
import type { OrcEvent } from "../../orchestrator/types.js";
import { createHumanAdapter, HumanAnswers, HUMAN_ADAPTER_NAME, HUMAN_TOOL_SCHEMAS, questionFromEvent, type QuestionRecord } from "./index.js";

const ACTION = 'ask_human {"question":"Ship to EU first or US first?","context":"Both launches are ready.","options":["EU","US"]}';
const RUN = { runId: "run_q", stepId: "step_q" };

describe("ask_human in a run", () => {
  it("advertises Hermes-style ask_human with question, context and options", () => {
    const schema = HUMAN_TOOL_SCHEMAS.find((s) => s.name === "ask_human");
    expect(schema?.parameters.required).toEqual(["question"]);
    expect(Object.keys(schema!.parameters.properties)).toEqual(["question", "context", "options"]);
    expect(createHumanAdapter().instructions).toContain("ask_human");
  });

  it("is read-only for policy purposes: no side-effect token and no action class", () => {
    const adapter = createHumanAdapter();
    expect(isSideEffecting(adapter.name, "ask_human")).toBe(false);
    expect(classifyCall({ adapter: adapter.name, scopes: adapter.scopes, tool: "ask_human", args: { question: "x" } })).toEqual([]);
  });

  it("parks the step: requiresApproval is true and dryRun returns needs_approval with the question in details", async () => {
    const adapter = createHumanAdapter();
    expect(adapter.requiresApproval(ACTION)).toBe(true);
    const record = (await adapter.dryRun!(ACTION, {})) as QuestionRecord;
    expect(record.adapter).toBe(HUMAN_ADAPTER_NAME);
    expect(record.status).toBe("needs_approval");
    expect(record.details).toEqual({ kind: "question", question: "Ship to EU first or US first?", context: "Both launches are ready.", options: ["EU", "US"] });
    expect(record.summary).toContain("Ship to EU first or US first?");
    expect(record.summary).toContain("EU");
  });

  it("on the replay, the answer stored for that run and step is the tool result, verbatim, and is consumed", async () => {
    const answers = new HumanAnswers();
    const adapter = createHumanAdapter({ answers });
    answers.put(RUN.runId, RUN.stepId, "EU first, the US needs the SOC 2 letter.");
    const record = await runWithToolCallContext(RUN, () => adapter.execute(ACTION, {}));
    expect(record.status).toBe("completed");
    expect(record.summary).toBe("EU first, the US needs the SOC 2 letter.");
    expect(answers.take(RUN.runId, RUN.stepId)).toBeUndefined();
  });

  it("a release without an answer is a failed record that says so, never an invented answer", async () => {
    const adapter = createHumanAdapter({ answers: new HumanAnswers() });
    const inRun = await runWithToolCallContext(RUN, () => adapter.execute(ACTION, {}));
    expect(inRun.status).toBe("failed");
    expect(inRun.summary).toMatch(/without an answer/i);
    const outside = await adapter.execute(ACTION, {});
    expect(outside.status).toBe("failed");
    expect(outside.summary).toMatch(/outside a run/i);
  });

  it("a malformed call is a failed record with usage, from both dryRun and execute", async () => {
    const adapter = createHumanAdapter();
    expect((await adapter.dryRun!("ask_human {}", {})).status).toBe("failed");
    expect((await adapter.execute('ask_human {"question":""}', {})).summary).toContain("question");
    expect((await adapter.dryRun!("ask_human {broken", {})).summary).toContain("ask_human");
  });
});

describe("ask_human in a delegated child", () => {
  it("returns blocked with a one-line reason instead of parking, on both paths", async () => {
    const adapter = createHumanAdapter({ callerContext: () => ({ delegated: true }) });
    expect(adapter.requiresApproval(ACTION)).toBe(false);
    const record = await runWithToolCallContext(RUN, () => adapter.execute(ACTION, {}));
    expect(record.status).toBe("blocked");
    expect(record.summary).not.toContain("\n");
    expect(record.summary).toMatch(/delegated/i);
    expect((await adapter.dryRun!(ACTION, {})).status).toBe("blocked");
  });

  it("bindCallerContext replaces the provider, so one shared adapter follows the step that is calling", async () => {
    const adapter = createHumanAdapter();
    let delegated = false;
    adapter.bindCallerContext(() => ({ delegated }));
    expect(adapter.requiresApproval(ACTION)).toBe(true);
    delegated = true;
    expect(adapter.requiresApproval(ACTION)).toBe(false);
  });
});

describe("questionFromEvent", () => {
  const base = { runId: "run_q", at: "2026-09-15T00:00:00.000Z" };

  it("reads the question off the parked step's pending call", () => {
    const event = { ...base, kind: "run_awaiting_approval", step: { id: "step_q", seatLoopState: { pendingToolCall: { name: "human", action: ACTION } } } } as unknown as OrcEvent;
    expect(questionFromEvent(event)).toEqual({ kind: "question", question: "Ship to EU first or US first?", context: "Both launches are ready.", options: ["EU", "US"] });
  });

  it("falls back to the needs_approval record's details, and is undefined for an ordinary gate", () => {
    const record: QuestionRecord = { adapter: "human", action: ACTION, status: "needs_approval", summary: "q", details: { kind: "question", question: "Which?" } };
    const withRecord = { ...base, kind: "step_awaiting_approval", step: { id: "step_q", toolCalls: [record] } } as unknown as OrcEvent;
    expect(questionFromEvent(withRecord)?.question).toBe("Which?");
    const plain = { ...base, kind: "step_awaiting_approval", step: { id: "s2", seatLoopState: { pendingToolCall: { name: "terminal", action: "terminal rm -rf build" } } } } as unknown as OrcEvent;
    expect(questionFromEvent(plain)).toBeUndefined();
    expect(questionFromEvent({ ...base, kind: "step_start" })).toBeUndefined();
  });
});
