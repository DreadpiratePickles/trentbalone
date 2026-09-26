/**
 * [C12] The plan outlives the message (council C12 accept: "a todo from turn 1 is listed unchanged in turn 3 and after a
 * forced compaction"). The real `todo` adapter on the real solo runner: each message is its own run, so before C12 the
 * list written in turn 1 was empty in turn 3. The list lives in the profile, keyed by the conversation
 * (`tools/todo/index.ts`), so a compaction, which only rewrites the transcript, cannot touch it. Fakes for the model.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTodoAdapter } from "../tools/todo/index.js";
import { FIXED_NOW, collect, fakeMemory, fakeMeter, sequentialIds, toolCall, toolCallsOf } from "./fakes.test-helpers.js";
import { SUMMARY_REPLY, filler, routedGateway, tempProfile } from "./fakes-s3.test-helpers.js";
import { createSoloRunner } from "./runner.js";
import { memorySoloSession } from "./session-store.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const ADD = toolCall('todo {"action": "add", "items": ["draft the catalogue", "price the oak tables"]}');
const LIST = toolCall('todo {"action": "list"}');

/** The summary of the last todo call a run's frames carry. */
const lastTodo = (events: Awaited<ReturnType<typeof collect>>): string =>
  events.flatMap((event) => toolCallsOf(event)).filter((record) => record.adapter === "todo").at(-1)?.summary ?? "";

describe("[C12] a solo conversation's todo list", () => {
  it("written in turn 1, is listed unchanged in turn 3 and again after a forced compaction", async () => {
    const profileDir = tempProfile("trent-solo-c12-todo-");
    temps.push(profileDir);
    const gateway = routedGateway([ADD, "Planned.", filler("ANSWER-2", 900), LIST, "Here is the plan.", LIST, "Still the plan."], { summary: [SUMMARY_REPLY] });
    const runner = createSoloRunner({
      gateway,
      tools: { adapters: [createTodoAdapter({ profileDir, now: () => "2026-09-26T09:00:00.000Z" })] },
      session: memorySoloSession(),
      memory: fakeMemory([]).memory,
      meter: fakeMeter(),
      now: FIXED_NOW,
      newId: sequentialIds(),
      compaction: { compactAfterChars: 100_000, historyChars: 600 },
    });

    const written = lastTodo(await collect(runner.run({ objective: "Plan the autumn catalogue." })));
    await collect(runner.run({ objective: filler("QUESTION-2", 900) }));
    const turn3 = lastTodo(await collect(runner.run({ objective: "What is left on the plan?" })));
    const compacted = await runner.compact?.({ force: true });
    const turn4 = lastTodo(await collect(runner.run({ objective: "And now?" })));

    expect(written).toContain("t1 [todo] draft the catalogue");
    expect(turn3).toBe(written);
    expect(compacted?.status).toBe("compacted");
    expect(turn4).toBe(written);
  });
});
