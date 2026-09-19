/**
 * [D5] item 1 — the per-tool signal the sweep reads off the traces it already reads.
 */
import { describe, expect, it } from "vitest";

import type { AgentTraceRow } from "../store/StorePort.js";
import {
  DEFAULT_TOOL_HEALTH_MIN_CALLS,
  DEFAULT_TOOL_HEALTH_THRESHOLD,
  encodeToolCall,
  parseToolCall,
  toolHealth,
  toolsOverThreshold,
} from "./tool-health.js";

const BASE: Omit<AgentTraceRow, "id" | "toolCalls" | "toolCallCount"> = {
  companyId: "co_tools",
  agentRole: "engineer",
  agentId: "engineer",
  runId: "run_1",
  taskType: "ship-feature",
  stepTitle: "implement",
  status: "completed",
  critiqueVerdict: "pass",
  improvement: null,
  evalScore: 0.9,
  costCents: 1,
  latencyMs: 10,
  humanCorrected: false,
  skillApplied: false,
  createdAt: "2026-09-18T10:00:00.000Z",
};

function row(id: string, toolCalls: string[], over: Partial<AgentTraceRow> = {}): AgentTraceRow {
  return { ...BASE, id, toolCalls, toolCallCount: toolCalls.length, ...over };
}

describe("toolHealth", () => {
  it("counts calls, failures, invalid arguments, corrected re-calls and the mean args size per tool", () => {
    const rows = [
      row("t1", [
        encodeToolCall({ tool: "web_search", adapter: "web", status: "failed", error: 'invalid arguments: "query" is required', args: { q: "x" } }),
        encodeToolCall({ tool: "web_search", adapter: "web", status: "completed", args: { query: "x" } }),
      ]),
    ];

    const [health] = toolHealth(rows);
    expect(health?.tool).toBe("web_search");
    expect(health?.adapter).toBe("web");
    expect(health?.calls).toBe(2);
    expect(health?.failures).toBe(1);
    expect(health?.failureRate).toBe(0.5);
    expect(health?.invalidArguments).toBe(1);
    expect(health?.invalidArgumentRate).toBe(0.5);
    expect(health?.retries).toBe(1);
    expect(health?.retryRate).toBe(0.5);
    // `{"q":"x"}` is 9 bytes and `{"query":"x"}` is 13.
    expect(health?.meanArgsBytes).toBe(11);
    expect(health?.examples).toEqual(['invalid arguments: "query" is required']);
  });

  it("keeps at most three example failures and redacts them", () => {
    const calls = Array.from({ length: 4 }, (_, i) =>
      encodeToolCall({ tool: "web_search", status: "failed", error: `schema error ${i}: token sk-abcdefghijklmnopqrstuvwxyz0123456789 rejected` }),
    );
    const [health] = toolHealth([row("t1", calls)]);
    expect(health?.examples).toHaveLength(3);
    for (const example of health?.examples ?? []) expect(example).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("an entry that carries only an adapter name still counts a call, and a failed row attributes its last call", () => {
    const rows = [row("t1", ["GitHub", "memory:read"], { status: "failed", critiqueVerdict: "escalate" })];
    const health = toolHealth(rows);
    const github = health.find((h) => h.tool === "GitHub");
    const memory = health.find((h) => h.tool === "read");
    expect(github?.calls).toBe(1);
    expect(github?.failures).toBe(0);
    expect(memory?.calls).toBe(1);
    // The last call of a failed step is the one that failed (the app's own convention).
    expect(memory?.failures).toBe(1);
    expect(memory?.adapter).toBe("memory");
    expect(memory?.meanArgsBytes).toBe(0);
  });

  it("a repeated identical call is a loop, not a corrected re-call", () => {
    const call = encodeToolCall({ tool: "web_search", status: "failed", error: "invalid arguments", args: { q: "x" } });
    const [health] = toolHealth([row("t1", [call, call, call])]);
    expect(health?.calls).toBe(3);
    expect(health?.retries).toBe(0);
  });
});

describe("toolsOverThreshold", () => {
  const failing = (count: number, bad: number): AgentTraceRow[] => [
    row(
      "t1",
      Array.from({ length: count }, (_, i) =>
        encodeToolCall(
          i < bad
            ? { tool: "web_search", status: "failed", error: "invalid arguments: unknown key", args: { q: i } }
            : { tool: "web_search", status: "completed", args: { query: i } },
        ),
      ),
    ),
  ];

  it("defaults are the documented ones", () => {
    expect(DEFAULT_TOOL_HEALTH_THRESHOLD).toBe(0.2);
    expect(DEFAULT_TOOL_HEALTH_MIN_CALLS).toBe(20);
  });

  it("a tool whose invalid-argument rate clears the threshold over enough calls is over it", () => {
    const over = toolsOverThreshold(toolHealth(failing(24, 6)));
    expect(over.map((h) => h.tool)).toEqual(["web_search"]);
    expect(over[0]?.invalidArgumentRate).toBe(0.25);
  });

  it("the same rate under the minimum call count is not over the threshold", () => {
    expect(toolsOverThreshold(toolHealth(failing(8, 2)))).toEqual([]);
  });

  it("enough calls under the rate is not over the threshold either", () => {
    expect(toolsOverThreshold(toolHealth(failing(40, 4)))).toEqual([]);
  });

  it("the retry rate crosses on its own", () => {
    const calls: string[] = [];
    for (let i = 0; i < 12; i += 1) {
      calls.push(encodeToolCall({ tool: "read_file", status: "failed", error: "no such file", args: { path: `a${i}` } }));
      calls.push(encodeToolCall({ tool: "read_file", status: "completed", args: { path: `b${i}` } }));
    }
    const health = toolHealth([row("t1", calls)]);
    const over = toolsOverThreshold(health);
    expect(over.map((h) => h.tool)).toEqual(["read_file"]);
    expect(over[0]?.retries).toBe(12);
    expect(over[0]?.invalidArgumentRate).toBe(0);
  });
});

describe("parseToolCall", () => {
  it("reads the three encodings the wrapper produces and invents nothing for the bare one", () => {
    expect(parseToolCall("GitHub")).toEqual({ tool: "GitHub" });
    expect(parseToolCall("memory:read")).toEqual({ tool: "read", adapter: "memory" });
    expect(parseToolCall(encodeToolCall({ tool: "web_search", adapter: "web", status: "completed", args: { query: "x" } }))).toEqual({
      tool: "web_search",
      adapter: "web",
      status: "completed",
      argsBytes: 13,
    });
  });

  it("reads a tool-call record the app's own shape produces", () => {
    const entry = JSON.stringify({ adapter: "web", action: 'web_search {"query":"x"}', status: "failed", summary: "invalid arguments: limit must be an integer" });
    expect(parseToolCall(entry)).toEqual({
      tool: "web_search",
      adapter: "web",
      status: "failed",
      error: "invalid arguments: limit must be an integer",
      argsBytes: 13,
    });
  });
});
