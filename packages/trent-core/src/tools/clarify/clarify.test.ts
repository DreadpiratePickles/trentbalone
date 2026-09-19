/**
 * A3 — `clarify`: up to five independent questions in ONE founder card.
 *
 * No second parking mechanism. `clarify` rides exactly the path `ask_human` rides: `dryRun`
 * returns the `needs_approval` record the seat loop parks on, `questionFromEvent` reads the card
 * off the gate event (so the REPL, the gateway and the one-shot `trent run` all show it without
 * knowing this tool exists), and `Orchestrator.answer` releases it through `HumanAnswers`.
 */
import { describe, expect, it } from "vitest";
import { HumanAnswers, questionFromEvent } from "../human/index.js";
import type { OrcEvent } from "../../orchestrator/types.js";
import { runWithToolCallContext } from "../../governance/tool-call-context.js";
import { CLARIFY_ADAPTER_NAME, CLARIFY_MAX_QUESTIONS, createClarifyAdapter, type ClarifyRecord } from "./index.js";

const RUN = { runId: "run_clarify", stepId: "step_1" };

const FIVE = {
  questions: [
    { id: "region", question: "Which region do we launch in first?", choices: ["EU", "US"] },
    { id: "pricing", question: "Do we keep the founding-customer price after launch?" },
    { id: "seats", question: "How many seats does the first plan include?" },
    { id: "support", question: "Who answers support in the first week?" },
    { id: "date", question: "What date do we announce?" },
  ],
};

describe("clarify", () => {
  it("parks one card carrying all five questions", async () => {
    const adapter = createClarifyAdapter({ answers: new HumanAnswers() });
    expect(adapter.requiresApproval(`clarify ${JSON.stringify(FIVE)}`)).toBe(true);

    const parked = (await adapter.dryRun?.(`clarify ${JSON.stringify(FIVE)}`, {})) as ClarifyRecord;
    expect(parked.status).toBe("needs_approval");
    expect(parked.details.kind).toBe("questions");
    expect(parked.details.questions).toHaveLength(CLARIFY_MAX_QUESTIONS);
    expect(parked.details.questions.map((entry) => entry.id)).toEqual(["region", "pricing", "seats", "support", "date"]);
    expect(parked.summary).toContain("Which region do we launch in first?");
    expect(parked.summary).toContain("What date do we announce?");
  });

  it("refuses a sixth question rather than silently dropping it", async () => {
    const adapter = createClarifyAdapter({ answers: new HumanAnswers() });
    const six = { questions: [...FIVE.questions, { id: "extra", question: "And one more?" }] };
    const result = await adapter.execute(`clarify ${JSON.stringify(six)}`, {});

    expect(result.status).toBe("failed");
    expect(result.summary).toContain(String(CLARIFY_MAX_QUESTIONS));
    expect(result.summary).toContain("6");
  });

  it("resolves every answer in one turn, keyed by question id", async () => {
    const answers = new HumanAnswers();
    const adapter = createClarifyAdapter({ answers });
    answers.put(RUN.runId, RUN.stepId, ["region: EU", "pricing: yes", "seats: 5", "support: Bobby", "date: 2026-10-01"].join("\n"));

    const result = await runWithToolCallContext(RUN, () => adapter.execute(`clarify ${JSON.stringify(FIVE)}`, {}));
    expect(result.status).toBe("completed");
    for (const line of ["region: EU", "pricing: yes", "seats: 5", "support: Bobby", "date: 2026-10-01"]) {
      expect(result.summary).toContain(line);
    }
  });

  it("never invents an answer when the step is released without one", async () => {
    const adapter = createClarifyAdapter({ answers: new HumanAnswers() });
    const result = await runWithToolCallContext(RUN, () => adapter.execute(`clarify ${JSON.stringify(FIVE)}`, {}));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("no answer");
  });

  it("is readable off the gate event by the one card path every surface already uses", async () => {
    const adapter = createClarifyAdapter({ answers: new HumanAnswers() });
    const parked = (await adapter.dryRun?.(`clarify ${JSON.stringify(FIVE)}`, {})) as ClarifyRecord;
    const event = {
      kind: "step_awaiting_approval",
      step: { id: "step_1", adapter: CLARIFY_ADAPTER_NAME, toolCalls: [parked] },
    } as unknown as OrcEvent;

    const question = questionFromEvent(event);
    expect(question?.question).toContain("Which region do we launch in first?");
    expect(question?.question).toContain("What date do we announce?");
    // Five questions have five answer sets, so the single-question option list stays empty and the
    // choices are rendered beside the question they belong to.
    expect(question?.options).toBeUndefined();
    expect(question?.question).toContain("EU");
  });
});
