import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const captured = vi.hoisted(() => ({
  calls: [] as Array<{ user: string }>,
  behaviors: [] as Array<"throw_schema" | "throw_infra" | "ok">,
  reply: { verdict: "pass", reason: "ok" } as Record<string, unknown>,
}));

vi.mock("@/lib/ai-client", () => ({
  MAX_TOKENS: { JSON: 8192, PLANNING: 8192 },
  callJson: vi.fn(async (_model: string, _system: string, user: string, schema: { parse(v: unknown): unknown }) => {
    captured.calls.push({ user });
    const behavior = captured.behaviors[captured.calls.length - 1] ?? "ok";
    if (behavior === "throw_schema") {
      throw new Error("gpt-4.1-mini response failed schema validation: Expected string, received boolean");
    }
    if (behavior === "throw_infra") {
      throw new Error("OPENAI_API_KEY is not configured");
    }
    return { data: schema.parse(captured.reply), tokens: 7 };
  }),
}));

const schema = z.object({ verdict: z.string(), reason: z.string() });

afterEach(() => {
  captured.calls = [];
  captured.behaviors = [];
  captured.reply = { verdict: "pass", reason: "ok" };
  vi.clearAllMocks();
});

describe("callCriticJsonWithRepair", () => {
  it("returns the first result without repair when parsing succeeds", async () => {
    const { callCriticJsonWithRepair } = await import("@/lib/orchestrator-critic-repair");
    const events: string[] = [];
    const result = await callCriticJsonWithRepair({
      model: "critic-model", system: "s", user: "u", schema, maxTokens: 8192,
      onTelemetry: (e) => events.push(e),
    });
    expect(result.repaired).toBe(false);
    expect(captured.calls).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("retries once with the validation error injected and succeeds, emitting repair telemetry", async () => {
    captured.behaviors = ["throw_schema", "ok"];
    const { callCriticJsonWithRepair } = await import("@/lib/orchestrator-critic-repair");
    const events: string[] = [];
    const result = await callCriticJsonWithRepair({
      model: "critic-model", system: "s", user: "original prompt", schema, maxTokens: 8192,
      onTelemetry: (e) => events.push(e),
    });
    expect(result.repaired).toBe(true);
    expect(captured.calls).toHaveLength(2);
    expect(captured.calls[1].user).toContain("original prompt");
    expect(captured.calls[1].user).toContain("could not be parsed");
    expect(events).toEqual(["critic_schema_repair_attempted", "critic_schema_repair_succeeded"]);
  });

  it("emits repair_failed and rethrows when the repair retry also fails", async () => {
    captured.behaviors = ["throw_schema", "throw_schema"];
    const { callCriticJsonWithRepair } = await import("@/lib/orchestrator-critic-repair");
    const events: string[] = [];
    await expect(callCriticJsonWithRepair({
      model: "critic-model", system: "s", user: "u", schema, maxTokens: 8192,
      onTelemetry: (e) => events.push(e),
    })).rejects.toThrow(/schema validation/);
    expect(events).toEqual(["critic_schema_repair_attempted", "critic_schema_repair_failed"]);
  });

  it("does NOT attempt repair for genuine infrastructure failures (not-configured / network)", async () => {
    captured.behaviors = ["throw_infra"];
    const { callCriticJsonWithRepair } = await import("@/lib/orchestrator-critic-repair");
    const events: string[] = [];
    await expect(callCriticJsonWithRepair({
      model: "critic-model", system: "s", user: "u", schema, maxTokens: 8192,
      onTelemetry: (e) => events.push(e),
    })).rejects.toThrow(/not configured/);
    expect(captured.calls).toHaveLength(1); // no retry
    expect(events).toEqual([]);
  });

  it("telemetry never carries the prompt contents", async () => {
    captured.behaviors = ["throw_schema", "ok"];
    const { callCriticJsonWithRepair } = await import("@/lib/orchestrator-critic-repair");
    const metas: Array<Record<string, unknown>> = [];
    await callCriticJsonWithRepair({
      model: "critic-model", system: "SECRET SYSTEM PROMPT", user: "SECRET USER PROMPT", schema, maxTokens: 8192,
      meta: { companyId: "co_1", runId: "orc_1" },
      onTelemetry: (_e, meta) => metas.push(meta),
    });
    const serialized = JSON.stringify(metas);
    expect(serialized).not.toContain("SECRET SYSTEM PROMPT");
    expect(serialized).not.toContain("SECRET USER PROMPT");
    expect(serialized).toContain("co_1");
  });
});
