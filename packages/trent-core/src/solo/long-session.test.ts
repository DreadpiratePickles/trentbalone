/**
 * [C12] Proof: a scripted 60-turn solo session on a fake gateway (council C12, "Proof").
 *
 * The gateway refuses the first call of turns 20, 40 and 60 with Anthropic's context-length 400 (Hermes
 * `tests/agent/test_413_compression.py:1504`, as `retry.overflow.test.ts` cites it). The session must finish every turn
 * with no provider 400 surfacing, one compaction per refusal, and the frozen prefix (the system prompt) byte-identical
 * before and after each compaction. On the way: the todo list turn 1 writes is listed unchanged in turn 3 and after each
 * forced compaction (turns 21 and 41), and the one turn that nears `max_tool_calls` (turn 10, nine calls of a cap of 10)
 * is told to wrap up exactly once. The window is the hosted figure a runtime would now pass (200,000 tokens), so the
 * automatic path never fires: every compaction here is a refusal's. Real runner, real `todo` adapter, no model call.
 */
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayStreamRequest } from "../model-gateway/types.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { createTodoAdapter } from "../tools/todo/index.js";
import { FIXED_NOW, collect, completion, fakeAdapter, fakeMemory, fakeMeter, sequentialIds, toolCall, toolCallsOf } from "./fakes.test-helpers.js";
import { SUMMARY_REPLY, kindOf, systemIn, tempProfile, type CallKind } from "./fakes-s3.test-helpers.js";
import { overflow400 } from "./fakes-c12.test-helpers.js";
import { createSoloRunner } from "./runner.js";
import { memorySoloSession } from "./session-store.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const TURNS = 60;
const REFUSED = new Set([20, 40, 60]);
const LISTED = new Set([3, 21, 41]);
const BUSY_TURN = 10;
const ADD = toolCall('todo {"action": "add", "items": ["draft the catalogue", "price the oak tables", "book the photographer"]}');
const LIST = toolCall('todo {"action": "list"}');
const NOTE = /\d+ tool calls? left; wrap up/g;

/** Every turn call's reply, in the order the runner makes them; an Error is thrown (the refusal). */
function turnScript(): Array<string | Error> {
  const script: Array<string | Error> = [];
  for (let n = 1; n <= TURNS; n += 1) {
    if (REFUSED.has(n)) script.push(overflow400());
    if (n === 1) script.push(ADD, "Planned: three steps.");
    else if (LISTED.has(n)) script.push(LIST, `Turn ${String(n)}: the plan stands.`);
    else if (n === BUSY_TURN) script.push(...Array.from({ length: 9 }, (_, i) => toolCall(`read_file {"path": "notes-${String(i + 1)}.md"}`)), "Read nine files.");
    else script.push(`Answer ${String(n)}: noted, and the walnut stain stays.`);
  }
  return script;
}

function sessionGateway() {
  const requests: GatewayStreamRequest[] = [];
  const kinds: CallKind[] = [];
  const turns = turnScript();
  let next = 0;
  return {
    requests,
    kinds,
    async complete(request: GatewayStreamRequest) {
      requests.push(request);
      const kind = kindOf(request);
      kinds.push(kind);
      if (kind === "summary") return completion(SUMMARY_REPLY);
      const reply = kind === "turn" ? turns[next++] : undefined;
      if (reply === undefined) throw new Error(`the test script has no ${kind} reply for call ${String(requests.length)}`);
      if (reply instanceof Error) throw reply;
      return completion(reply);
    },
  };
}

const notesIn = (request: GatewayStreamRequest | undefined): string[] => (request?.messages ?? []).flatMap((message) => message.content.match(NOTE) ?? []);
const lastTodo = (events: readonly OrcEvent[]): string => events.flatMap((event) => toolCallsOf(event)).filter((record) => record.adapter === "todo").at(-1)?.summary ?? "";

describe("[C12] a 60-turn solo session", () => {
  it("survives three context-length refusals: one compaction each, no 400 surfacing, the prefix byte-identical; the plan and the wrap-up hold", async () => {
    const profileDir = tempProfile("trent-solo-c12-long-");
    temps.push(profileDir);
    const gateway = sessionGateway();
    const runner = createSoloRunner({
      gateway,
      tools: { adapters: [createTodoAdapter({ profileDir, now: () => "2026-09-26T09:00:00.000Z" }), fakeAdapter({ name: "file_ops", tools: ["read_file"] })] },
      session: memorySoloSession(),
      memory: fakeMemory([]).memory,
      meter: fakeMeter(),
      now: FIXED_NOW,
      newId: sequentialIds(),
      config: { contextWindowTokens: 200_000, maxToolCalls: 10 },
    });

    const runs: OrcEvent[][] = [];
    for (let n = 1; n <= TURNS; n += 1) runs.push(await collect(runner.run({ objective: `TURN-${String(n)}: carry on with the catalogue.` })));

    // Every turn answered; no provider refusal reached a frame.
    expect(runs.map((events) => events.at(-1)?.kind)).toEqual(Array.from({ length: TURNS }, () => "run_done"));
    const frames = JSON.stringify(runs);
    expect(frames).not.toContain("HTTP 400");
    expect(frames).not.toContain("prompt is too long");

    // One compaction per refusal, and it happened between the refused call and its retry.
    const summaries = gateway.kinds.flatMap((kind, i) => (kind === "summary" ? [i] : []));
    expect(summaries).toHaveLength(REFUSED.size);
    // The frozen prefix: every turn request carries the same system prompt, the ones either side of each compaction included.
    const prefix = systemIn(gateway.requests[0]);
    const turnRequests = gateway.requests.filter((request) => kindOf(request) === "turn");
    expect(new Set(turnRequests.map(systemIn)).size).toBe(1);
    for (const at of summaries) {
      expect(systemIn(gateway.requests[at - 1])).toBe(prefix);
      expect(systemIn(gateway.requests[at + 1])).toBe(prefix);
    }

    // The plan: written in turn 1, listed unchanged in turn 3 and after the forced compactions of turns 20 and 40.
    const written = lastTodo(runs[0] ?? []);
    expect(written).toContain("t3 [todo] book the photographer");
    for (const n of LISTED) expect(lastTodo(runs[n - 1] ?? [])).toBe(written);

    // The wrap-up: introduced once (the last message of one request), and only in turn 10's requests.
    const introduced = turnRequests.filter((request) => (request.messages.at(-1)?.content.match(NOTE) ?? []).length > 0);
    expect(introduced).toHaveLength(1);
    expect(notesIn(introduced[0])).toEqual(["2 tool calls left; wrap up"]);
    const told = turnRequests.filter((request) => notesIn(request).length > 0);
    expect(told.every((request) => request.messages.some((message) => message.content.includes(`TURN-${String(BUSY_TURN)}:`)))).toBe(true);
  });
});
