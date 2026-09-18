/**
 * D.1 and D.4 — the REPL has a conversation, and the budget cap refuses a turn.
 *
 * Before this, every submitted line was a fresh orchestration run with no message history, so
 * "now do the second one" referred to nothing; and `daily_cap` only printed a warning while the
 * run it was warning about went ahead. Both are asserted here against the engine's real turn
 * path with a recording runner: nothing about the assertions is a literal the engine invented.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import {
  Conversation,
  DEFAULT_HISTORY_CHARS,
  DEFAULT_HISTORY_TURNS,
  trimHistory,
  type HistoryMessage,
} from "../conversation.js";
import { makeHarness } from "./harness.js";

const FIRST = "list the two worst bottlenecks in the drain loop";
const SECOND = "now do the second one";
const SUMMARY = "The queue drain takes one job at a time, and the seat loop re-sends its whole tool history.";

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_conv", at: "2026-09-18T00:00:00.000Z", ...extra } as OrcEvent;
}

/** A run that finishes with a real consolidated summary, the way a completed run does. */
const EVENTS: OrcEvent[] = [
  ev("run_start", { run: { objective: FIRST } }),
  ev("step_start", { step: { id: "s1", title: "Read the audit", agentRole: "eng-ai-engineer" } }),
  ev("step_end", {
    step: {
      id: "s1",
      title: "Read the audit",
      agentRole: "eng-ai-engineer",
      costCents: 4,
      tokens: 120,
      model: "scripted-seat",
      toolCalls: [{ adapter: "file_ops", action: "read_file docs/jobs.md", status: "completed" }],
    } as OrcEvent["step"],
  }),
  ev("consolidate_end", { run: { summary: SUMMARY } }),
  ev("run_done", { run: { status: "completed", summary: SUMMARY } }),
];

describe("the conversation the next run sees", () => {
  it("hands the second run the first turn's user line and assistant output", async () => {
    const h = makeHarness({ events: EVENTS });
    await h.engine.submit(FIRST);
    await h.engine.submit(SECOND);

    expect(h.objectives).toEqual([FIRST, SECOND]);
    // The first turn has nothing to refer to; the second carries the first, oldest first.
    expect(h.histories[0]).toEqual([]);
    expect(h.histories[1]).toEqual([
      { role: "user", content: FIRST },
      { role: "assistant", content: SUMMARY },
    ]);
  });

  it("passes the new line as the objective and never folds the history into it", async () => {
    const h = makeHarness({ events: EVENTS });
    await h.engine.submit(FIRST);
    await h.engine.submit(SECOND);
    expect(h.objectives[1]).toBe(SECOND);
  });

  it("records the failure summary as the assistant turn when the run fails", async () => {
    const failed: OrcEvent[] = [
      ev("run_start", { run: { objective: FIRST } }),
      ev("run_failed", { detail: "every provider call failed", run: { status: "failed" } }),
    ];
    const h = makeHarness({ events: failed });
    await h.engine.submit(FIRST);
    await h.engine.submit(SECOND);
    expect(h.histories[1]?.[1]?.role).toBe("assistant");
    expect(h.histories[1]?.[1]?.content).toContain("every provider call failed");
  });
});

describe("an interrupted turn", () => {
  it("persists the user line and the fragment marked interrupted, and threads neither as a reply", async () => {
    const persisted: Array<{ role: string; content: string; status?: string }> = [];
    const conversation = new Conversation({
      sink: {
        user: (content) => void persisted.push({ role: "user", content }),
        assistant: (content, metadata) => void persisted.push({ role: "assistant", content, ...(metadata.status === undefined ? {} : { status: metadata.status }) }),
      },
    });
    const h = makeHarness({ events: EVENTS, conversation });

    const turn = h.engine.submit(FIRST);
    await h.emitted(4); // the consolidated summary has arrived; the run has not finished
    h.feed("\x03");
    await turn;
    await h.engine.submit(SECOND);

    // The session keeps what happened, labelled for what it is; the turn after it is not labelled.
    expect(persisted.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(persisted[1]?.status).toBe("interrupted");
    expect(persisted[3]?.status).toBeUndefined();
    // The next run is told about the question, never about the fragment.
    expect(h.histories[1]).toEqual([{ role: "user", content: FIRST }]);
  });
});

describe("the history budget", () => {
  it("keeps the newest turns and drops the oldest past the character budget", () => {
    const messages: HistoryMessage[] = [
      { role: "user", content: "a".repeat(4000) },
      { role: "assistant", content: "b".repeat(4000) },
      { role: "user", content: "c" },
    ];
    const kept = trimHistory(messages, { maxTurns: DEFAULT_HISTORY_TURNS, maxChars: DEFAULT_HISTORY_CHARS });
    expect(kept.map((m) => m.content[0])).toEqual(["b", "c"]);
  });

  it("keeps at most the configured number of turns", () => {
    const conversation = new Conversation({ maxTurns: 2, maxChars: DEFAULT_HISTORY_CHARS });
    for (const n of [1, 2, 3, 4]) {
      conversation.recordUser(`ask ${n}`);
      conversation.recordAssistant(`answer ${n}`, {});
    }
    expect(conversation.history().map((m) => m.content)).toEqual(["ask 3", "answer 3", "ask 4", "answer 4"]);
  });
});

describe("the budget stop", () => {
  const cap = 500;
  const config = { ...DEFAULT_CONFIG, budget: { ...DEFAULT_CONFIG.budget, daily_cap: cap } };

  it("refuses the turn at the daily cap, names the cap and the spend, and never calls the runner", async () => {
    const h = makeHarness({ events: EVENTS, config, openingCents: 512 });
    await h.engine.submit("keep going");

    expect(h.objectives).toEqual([]);
    const refusal = h.transcript().find((line) => /daily cap/i.test(line)) ?? "";
    expect(refusal).toContain(String(cap));
    expect(refusal).toContain("512");
    // Integer cents only: the refusal never prints a dollar float.
    expect(refusal).not.toMatch(/\$\d/);
  });

  it("stops a run in flight once the per-run cap is reached", async () => {
    const perRun = {
      ...DEFAULT_CONFIG,
      budget: { ...DEFAULT_CONFIG.budget, daily_cap: 100_000, per_run_cap: 3 },
    };
    const h = makeHarness({ events: EVENTS, config: perRun });
    await h.engine.submit(FIRST);

    // The step cost 4 cents against a 3-cent per-run cap: the stream is abandoned, not drained.
    expect(h.streamCompleted).toBe(false);
    expect(h.transcript().some((line) => /per-run cap/i.test(line))).toBe(true);
  });

  it("lets a turn through while the ledger is under the cap", async () => {
    const h = makeHarness({ events: EVENTS, config, openingCents: 10 });
    await h.engine.submit(FIRST);
    expect(h.objectives).toEqual([FIRST]);
  });
});
