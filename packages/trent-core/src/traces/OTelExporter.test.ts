import { describe, it, expect, vi } from "vitest";
import { OTelExporter, type TraceStepInput } from "./OTelExporter.js";

describe("OTelExporter", () => {
  it("converts a trace step to standard OpenTelemetry gen_ai.* span attributes", () => {
    const exporter = new OTelExporter();
    const input: TraceStepInput = {
      traceId: "trace-123",
      stepId: "step-1",
      agentId: "engineer",
      agentRole: "Lead Engineer",
      model: "claude-3-7-sonnet",
      provider: "anthropic",
      prompt: "Fix the bug in auth route",
      completion: "I have updated the token validation in auth.ts",
      tokens: { prompt: 150, completion: 80, total: 230 },
      cost: 0.04,
      durationMs: 820,
      toolCalls: [{ name: "read_file", args: { path: "auth.ts" } }],
      critiqueVerdict: "approved",
    };

    const span = exporter.convertToSpan(input);

    expect(span.name).toBe("gen_ai.agent.turn");
    expect(span.attributes["gen_ai.system"]).toBe("anthropic");
    expect(span.attributes["gen_ai.request.model"]).toBe("claude-3-7-sonnet");
    expect(span.attributes["gen_ai.usage.prompt_tokens"]).toBe(150);
    expect(span.attributes["gen_ai.usage.completion_tokens"]).toBe(80);
    expect(span.attributes["gen_ai.usage.total_tokens"]).toBe(230);
    expect(span.attributes["gen_ai.cost"]).toBe(0.04);
    expect(span.attributes["gen_ai.agent.id"]).toBe("engineer");
    expect(span.attributes["gen_ai.agent.role"]).toBe("Lead Engineer");
    expect(span.attributes["gen_ai.critique.verdict"]).toBe("approved");
    expect(span.attributes["gen_ai.tool_calls.count"]).toBe(1);
  });

  it("redacts sensitive secrets and API keys from prompt and completion", () => {
    const exporter = new OTelExporter();
    const input: TraceStepInput = {
      traceId: "trace-456",
      stepId: "step-2",
      agentId: "ceo",
      model: "gpt-5.6-terra",
      provider: "openai",
      prompt: "Connecting using sk-proj-1234567890abcdef12345678 and token bearer eyJhbGciOi...",
      completion: "Secret sk-ant-api03-abcdef987654321 configured.",
    };

    const span = exporter.convertToSpan(input);

    expect(span.attributes["gen_ai.prompt"]).not.toContain("sk-proj-1234567890abcdef12345678");
    expect(span.attributes["gen_ai.prompt"]).toContain("[REDACTED_SECRET]");
    expect(span.attributes["gen_ai.completion"]).not.toContain("sk-ant-api03-abcdef987654321");
    expect(span.attributes["gen_ai.completion"]).toContain("[REDACTED_SECRET]");
  });

  it("buffers spans and exports them in batch", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const exporter = new OTelExporter({
      endpoint: "http://localhost:4318/v1/traces",
      fetchImpl: fetchSpy,
    });

    exporter.record({
      traceId: "trace-789",
      stepId: "step-1",
      agentId: "support",
      model: "gemini-2.5-pro",
      provider: "google",
      prompt: "Customer asks for refund",
      completion: "Processed refund",
    });

    expect(exporter.getBufferedCount()).toBe(1);
    const success = await exporter.flush();
    expect(success).toBe(true);
    expect(exporter.getBufferedCount()).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
