import { describe, it, expect } from "vitest";
import { StructuredLogger, FORBIDDEN_LOG_FIELDS } from "./logger.js";

function collect(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe("StructuredLogger", () => {
  it("emits timestamp, level, runId, stage, taskId and safe fields", () => {
    const { lines, sink } = collect();
    const log = new StructuredLogger({ runId: "run_1", sink });
    log.info("plan.start", { stage: "plan", taskId: "task_7", attempt: 2 });

    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(typeof rec.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(rec.timestamp as string))).toBe(false);
    expect(rec.level).toBe("info");
    expect(rec.runId).toBe("run_1");
    expect(rec.stage).toBe("plan");
    expect(rec.taskId).toBe("task_7");
    expect(rec.event).toBe("plan.start");
    expect(rec.attempt).toBe(2);
  });

  it("names prompt, messages, content and body as forbidden", () => {
    expect([...FORBIDDEN_LOG_FIELDS].sort()).toEqual(
      ["body", "completion", "content", "messages", "prompt", "toolResult", "tool_payload"].sort(),
    );
  });

  it("drops a forbidden field entirely and warns, never redacting it in place", () => {
    const { lines, sink } = collect();
    const log = new StructuredLogger({ runId: "run_2", sink });
    log.info("model.call", {
      stage: "execute",
      prompt: "my secret prompt sk-ant-api03-FAKEFAKEFAKE",
      model: "claude-sonnet-5",
    });

    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect("prompt" in rec).toBe(false);
    expect(lines[0]).not.toContain("sk-ant-api03-FAKEFAKEFAKE");
    expect(lines[0]).not.toContain("my secret prompt");
    expect(lines[0]).not.toContain("[redacted]");
    expect(rec.droppedFields).toEqual(["prompt"]);
    expect(rec.model).toBe("claude-sonnet-5");
  });

  it("drops every forbidden field shape", () => {
    const { lines, sink } = collect();
    const log = new StructuredLogger({ runId: "run_3", sink });
    log.info("e", {
      prompt: "ZZALPHA",
      messages: [{ role: "user", content: "ZZBETA" }],
      content: "ZZGAMMA",
      body: { raw: "ZZDELTA" },
    });
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec.droppedFields).toEqual(["body", "content", "messages", "prompt"]);
    for (const junk of ["ZZALPHA", "ZZBETA", "ZZGAMMA", "ZZDELTA"]) {
      expect(lines[0]).not.toContain(junk);
    }
  });

  it("throws in strict mode rather than dropping", () => {
    const { sink } = collect();
    const log = new StructuredLogger({ runId: "run_4", sink, strict: true });
    expect(() => log.info("e", { prompt: "x" })).toThrow(/prompt/);
  });

  it("redacts secret-shaped values that appear in otherwise-safe fields", () => {
    const { lines, sink } = collect();
    const log = new StructuredLogger({ runId: "run_5", sink });
    log.error("provider.error", { reason: "auth failed for sk-ant-api03-FAKEFAKEFAKE" });
    expect(lines[0]).not.toContain("sk-ant-api03-FAKEFAKEFAKE");
    expect(JSON.parse(lines[0]!).level).toBe("error");
  });

  it("supports child loggers that inherit runId and stage", () => {
    const { lines, sink } = collect();
    const log = new StructuredLogger({ runId: "run_6", sink }).child({ stage: "verify" });
    log.warn("slow");
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(rec.runId).toBe("run_6");
    expect(rec.stage).toBe("verify");
    expect(rec.level).toBe("warn");
  });
});
