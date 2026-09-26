/**
 * [C12] A context-length refusal is not a dead run (council C12; Hermes `agent/turn_overflow.py`).
 *
 * The provider says the prompt does not fit (`model-gateway/retry.ts` `context_overflow`). The run then compacts its
 * conversation ONCE, mid-run (S3's `compactConversation`, forced, the run's own messages kept verbatim), rebuilds the
 * request with the frozen system prefix untouched, and asks again ONCE. A second refusal in the run, or a compaction
 * that could not shrink anything, ends the run with a verdict naming the window. Fakes only: no model call.
 */
import { describe, expect, it } from "vitest";
import type { GatewayStreamRequest } from "../model-gateway/types.js";
import { verdictOf } from "../orchestrator/verdict.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { FIXED_NOW, collect, completion, fakeMemory, fakeMeter, kinds, sequentialIds } from "./fakes.test-helpers.js";
import { SUMMARY_REPLY, filler, kindOf, systemIn, toldIn, type CallKind } from "./fakes-s3.test-helpers.js";
import { overflow400 } from "./fakes-c12.test-helpers.js";
import { createSoloRunner } from "./runner.js";
import { memorySoloSession } from "./session-store.js";
import type { SoloGateway } from "./types.js";


interface OverflowGateway extends SoloGateway {
  readonly requests: GatewayStreamRequest[];
  readonly kinds: CallKind[];
}

/** Turns answered in order (an Error is thrown), summaries from their own script, no flush (no memory adapter here). */
function overflowGateway(turns: ReadonlyArray<string | Error>, summaries: readonly string[] = [SUMMARY_REPLY]): OverflowGateway {
  const requests: GatewayStreamRequest[] = [];
  const called: CallKind[] = [];
  const next = { turn: 0, summary: 0 };
  return {
    requests,
    kinds: called,
    async complete(request) {
      requests.push(request);
      const kind = kindOf(request);
      called.push(kind);
      const reply = kind === "summary" ? summaries[next.summary++] : kind === "turn" ? turns[next.turn++] : undefined;
      if (reply === undefined) throw new Error(`the test script has no ${kind} reply for call ${String(requests.length)}`);
      if (reply instanceof Error) throw reply;
      return completion(reply);
    },
  };
}

function setup(turns: ReadonlyArray<string | Error>, summaries?: readonly string[]) {
  const gateway = overflowGateway(turns, summaries);
  const runner = createSoloRunner({
    gateway,
    tools: { adapters: [] },
    session: memorySoloSession(),
    memory: fakeMemory([]).memory,
    meter: fakeMeter(),
    now: FIXED_NOW,
    newId: sequentialIds(),
    config: { contextWindowTokens: 200_000 },
    // The automatic path never fires here (100,000 chars); a forced compaction keeps a 1,200-char tail.
    compaction: { compactAfterChars: 100_000, historyChars: 1_200 },
  });
  return { gateway, runner };
}

const chatter = (n: number): string[] => Array.from({ length: n }, (_, i) => filler(`ANSWER-${String(i + 1)}`, 700));
const ask = (i: number): string => filler(`QUESTION-${String(i)}`, 700);
const notes = (events: readonly OrcEvent[]): string[] => events.filter((event) => event.kind === "step_note").map((event) => String(event.detail ?? ""));

describe("[C12] a context-length 400 mid-run", () => {
  it("compacts exactly once, asks again once, and the run answers; the system prefix is byte-identical", async () => {
    const { gateway, runner } = setup([...chatter(3), overflow400(), "Answered after one compaction."]);
    for (let i = 1; i <= 3; i += 1) await collect(runner.run({ objective: ask(i) }));
    const events = await collect(runner.run({ objective: "QUESTION-4: what did we decide?" }));

    expect(kinds(events).at(-1)).toBe("run_done");
    expect(gateway.kinds).toEqual(["turn", "turn", "turn", "turn", "summary", "turn"]);
    const [first, overflowed, retried] = [gateway.requests[0], gateway.requests[3], gateway.requests[5]];
    expect(systemIn(overflowed)).toBe(systemIn(first));
    expect(systemIn(retried)).toBe(systemIn(first));
    expect(toldIn(retried)).toContain("Walnut stain.");
    expect(toldIn(retried)).toContain("QUESTION-4: what did we decide?");
    expect(toldIn(retried)).not.toContain("QUESTION-1");
    expect(notes(events).join("\n")).toMatch(/context window \(200,000 tokens\)/);
    expect(JSON.stringify(events)).not.toContain("HTTP 400");
  });

  it("a second refusal in the same run ends it with a verdict naming the window, after exactly one compaction", async () => {
    const { gateway, runner } = setup([...chatter(3), overflow400(), overflow400()]);
    for (let i = 1; i <= 3; i += 1) await collect(runner.run({ objective: ask(i) }));
    const events = await collect(runner.run({ objective: "QUESTION-4" }));

    expect(kinds(events).at(-1)).toBe("run_failed");
    expect(gateway.kinds.filter((kind) => kind === "summary")).toHaveLength(1);
    const summary = verdictOf(events.at(-1))?.summary ?? "";
    expect(summary).toContain("context window (200,000 tokens)");
    expect(summary).toContain("prompt is too long");
  });

  it("when nothing can be compacted, it does not send the same request again", async () => {
    const { gateway, runner } = setup([overflow400(), "unused"]);
    const events = await collect(runner.run({ objective: "QUESTION-1" }));

    expect(kinds(events).at(-1)).toBe("run_failed");
    expect(gateway.kinds).toEqual(["turn"]);
    expect(verdictOf(events.at(-1))?.summary ?? "").toContain("context window (200,000 tokens)");
  });
});
