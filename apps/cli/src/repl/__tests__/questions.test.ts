/**
 * T2.4 — `ask_human` in the REPL. A gate raised by the human tool is a question, not a yes/no:
 * the card shows the question, ordinary input is held, the typed line is the answer, and the
 * answer text (never a fabricated one) is what releases the step through `onApprovalAnswer`.
 */

import { describe, it, expect, vi } from "vitest";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { bindApprovalAnswers } from "../engine.js";
import { makeHarness } from "./harness.js";

const ASK = 'ask_human {"question":"Ship the EU launch first or the US launch first?","context":"Both are ready.","options":["EU","US"]}';

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_a", at: "2026-09-15T00:00:00.000Z", ...extra } as OrcEvent;
}

function questionGate(): OrcEvent {
  return ev("step_awaiting_approval", {
    step: { id: "s1", title: "Ask the founder", agentRole: "ceo", seatLoopState: { pendingToolCall: { name: "human", action: ASK } } } as OrcEvent["step"],
    detail: "Awaiting tool approval: Ask the founder",
  });
}

describe("a question inside a live turn", () => {
  it("prints the question and its options, holds input, and the typed line resumes the run as the answer", async () => {
    const answers: Array<[string, string | undefined, unknown]> = [];
    const h = makeHarness({
      events: [ev("run_start", { run: { objective: "decide the launch order" } }), questionGate()],
      onApprovalAnswer: (runId, stepId, answer) => { answers.push([runId, stepId, answer]); },
    });

    const turn = h.engine.submit("decide the launch order");
    await h.emitted(2);
    await new Promise((r) => setTimeout(r, 5));

    expect(h.engine.awaitingApproval).toBe(true);
    // The card is written straight to the terminal, like the approval card; the transcript keeps the events.
    const shown = h.out.join("\n");
    expect(shown).toContain("Ship the EU launch first or the US launch first?");
    expect(shown).toContain("Both are ready.");
    expect(shown).toMatch(/1\. EU/);
    expect(shown).toMatch(/2\. US/);
    expect(shown).not.toMatch(/\[y\] approve/);

    // A single y is not a decision here: it is the first letter of an answer.
    h.feed("y");
    expect(h.engine.awaitingApproval).toBe(true);
    h.feed("\x7f");
    h.feed("EU first, the US waits for the SOC 2 letter.\r");
    await turn;

    expect(h.engine.awaitingApproval).toBe(false);
    expect(answers).toEqual([["run_a", "s1", { answer: "EU first, the US waits for the SOC 2 letter." }]]);
    expect(h.transcript().join("\n")).toContain("EU first, the US waits for the SOC 2 letter.");
    expect(h.store.allApprovals()[0]?.status).toBe("approved");
    expect(h.engine.draft).toBe("");
  });

  it("an empty line is not an answer: the gate stays open until real text is typed", async () => {
    const answers: unknown[] = [];
    const h = makeHarness({ events: [questionGate()], onApprovalAnswer: (_r, _s, answer) => { answers.push(answer); } });
    const turn = h.engine.submit("decide");
    await h.emitted(1);
    await new Promise((r) => setTimeout(r, 5));
    h.feed("\r");
    expect(h.engine.awaitingApproval).toBe(true);
    expect(answers).toEqual([]);
    h.feed("US\r");
    await turn;
    expect(answers).toEqual([{ answer: "US" }]);
  });
});

describe("bindApprovalAnswers", () => {
  it("routes an answer to orchestrator.answer with the text, and a decision to approve/reject as before", async () => {
    const target = { approve: vi.fn(async () => true), reject: vi.fn(async () => true), answer: vi.fn(async () => true) };
    const bound = bindApprovalAnswers(target);
    await bound("run_a", "s1", { answer: "EU first" });
    await bound("run_a", "s2", "approved");
    await bound("run_a", "s3", "rejected");
    expect(target.answer).toHaveBeenCalledWith("run_a", "s1", "EU first");
    expect(target.approve).toHaveBeenCalledWith("run_a", "s2");
    expect(target.reject).toHaveBeenCalledWith("run_a", "s3");
  });
});
