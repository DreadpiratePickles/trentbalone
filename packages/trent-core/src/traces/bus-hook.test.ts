/**
 * The OTel bus hook: one run span, a child step span per step, a child tool span per tool call
 * record, exported as OTLP/HTTP JSON to whatever endpoint the config names. The receiver here is a
 * real local HTTP server, so what is asserted is the bytes on the wire, not a mock's call list.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { OrcEvent } from "../orchestrator/types.js";
import { OTelExporter } from "./OTelExporter.js";
import { composeBusHooks, createOTelBusHook } from "./bus-hook.js";

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
}
interface OtlpPayload {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }>;
  }>;
}

let server: http.Server;
let endpoint: string;
let received: Array<{ method: string; path: string; contentType: string | undefined; body: string }>;

beforeEach(async () => {
  received = [];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      received.push({ method: req.method ?? "", path: req.url ?? "", contentType: req.headers["content-type"], body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${port}/v1/traces`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const attr = (span: OtlpSpan, key: string): OtlpAttribute["value"] | undefined => span.attributes.find((a) => a.key === key)?.value;

function ev(kind: OrcEvent["kind"], at: string, extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_otel_1", at, ...extra };
}

const STEP = { id: "step_1", title: "Read the auth route", agentRole: "engineer", model: "gemini-3.5-flash-lite" };

/** The step as the app's bus carries it on `step_output`: the snapshot plus its tool call records. */
const STEP_WITH_TOOLS = {
  ...STEP,
  status: "completed",
  output: "Done. The key sk-proj-1234567890abcdef12345678 was in auth.ts",
  tokens: 230,
  costCents: 4,
  toolCalls: [{ adapter: "file_ops", action: "read_file", status: "completed", summary: "read auth.ts (41 lines)" }],
};

describe("createOTelBusHook", () => {
  it("a run with one step and one tool call posts three spans with a run > step > tool parent chain", async () => {
    const exporter = new OTelExporter({ endpoint, serviceName: "trent-test" });
    const hook = createOTelBusHook(exporter);

    hook.sink(ev("run_start", "2026-09-15T10:00:00.000Z", { run: { companyId: "cmp_1", objective: "Fix the auth bug" } }));
    hook.sink(ev("step_start", "2026-09-15T10:00:01.000Z", { step: { ...STEP, status: "running" } }));
    hook.sink(ev("step_output", "2026-09-15T10:00:05.000Z", { step: STEP_WITH_TOOLS as OrcEvent["step"] }));
    hook.sink(ev("step_end", "2026-09-15T10:00:05.000Z", { step: STEP_WITH_TOOLS as OrcEvent["step"] }));
    hook.sink(ev("run_done", "2026-09-15T10:00:06.000Z", { run: { status: "completed" } }));
    await hook.flush();

    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe("POST");
    expect(received[0]?.path).toBe("/v1/traces");
    expect(received[0]?.contentType).toContain("application/json");

    const payload = JSON.parse(received[0]!.body) as OtlpPayload;
    const resource = payload.resourceSpans[0]!;
    expect(resource.resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "trent-test" } });
    const spans = resource.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(3);

    const run = spans.find((s) => s.name === "trent.run")!;
    const step = spans.find((s) => s.name === "gen_ai.agent.turn")!;
    const tool = spans.find((s) => s.name.startsWith("execute_tool"))!;
    expect(run).toBeDefined();
    expect(step).toBeDefined();
    expect(tool).toBeDefined();

    // OTLP ids: a 32-hex trace id shared by all three, 16-hex span ids, and the parent chain.
    expect(run.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(step.traceId).toBe(run.traceId);
    expect(tool.traceId).toBe(run.traceId);
    for (const s of spans) expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(run.parentSpanId).toBeUndefined();
    expect(step.parentSpanId).toBe(run.spanId);
    expect(tool.parentSpanId).toBe(step.spanId);

    // Times come from the events, as nanosecond strings the way OTLP/JSON encodes uint64.
    expect(run.startTimeUnixNano).toBe(String(Date.parse("2026-09-15T10:00:00.000Z") * 1_000_000));
    expect(run.endTimeUnixNano).toBe(String(Date.parse("2026-09-15T10:00:06.000Z") * 1_000_000));
    expect(step.startTimeUnixNano).toBe(String(Date.parse("2026-09-15T10:00:01.000Z") * 1_000_000));
    expect(step.endTimeUnixNano).toBe(String(Date.parse("2026-09-15T10:00:05.000Z") * 1_000_000));

    expect(attr(run, "trent.run.status")?.stringValue).toBe("completed");
    expect(attr(step, "gen_ai.agent.role")?.stringValue).toBe("engineer");
    expect(attr(step, "gen_ai.request.model")?.stringValue).toBe("gemini-3.5-flash-lite");
    expect(attr(step, "gen_ai.usage.total_tokens")?.intValue).toBe("230");
    expect(attr(step, "trent.step.status")?.stringValue).toBe("completed");
    expect(attr(tool, "gen_ai.tool.name")?.stringValue).toBe("file_ops");
    expect(attr(tool, "trent.tool.action")?.stringValue).toBe("read_file");
    expect(attr(tool, "trent.tool.status")?.stringValue).toBe("completed");

    // Redaction stays: the secret in the step output never reaches the wire.
    expect(received[0]!.body).not.toContain("sk-proj-1234567890abcdef12345678");
    expect(attr(step, "gen_ai.completion")?.stringValue).toContain("[REDACTED_SECRET]");
  });

  it("re-emitted step_output frames do not duplicate tool spans, and nothing is exported before the run ends", async () => {
    const exporter = new OTelExporter({ endpoint });
    const hook = createOTelBusHook(exporter);

    hook.sink(ev("run_start", "2026-09-15T10:00:00.000Z", { run: { objective: "x" } }));
    hook.sink(ev("step_start", "2026-09-15T10:00:01.000Z", { step: { ...STEP, status: "running" } }));
    hook.sink(ev("step_output", "2026-09-15T10:00:02.000Z", { step: STEP_WITH_TOOLS as OrcEvent["step"] }));
    hook.sink(ev("step_output", "2026-09-15T10:00:03.000Z", { step: STEP_WITH_TOOLS as OrcEvent["step"] }));
    hook.sink(ev("step_end", "2026-09-15T10:00:03.000Z", { step: STEP_WITH_TOOLS as OrcEvent["step"] }));
    hook.sink(ev("step_end", "2026-09-15T10:00:03.000Z", { step: STEP_WITH_TOOLS as OrcEvent["step"] }));
    expect(received).toHaveLength(0);
    expect(exporter.getBufferedCount()).toBe(2);

    hook.sink(ev("run_failed", "2026-09-15T10:00:04.000Z", { detail: "planner gave up" }));
    await hook.flush();

    expect(received).toHaveLength(1);
    const spans = (JSON.parse(received[0]!.body) as OtlpPayload).resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.map((s) => s.name).sort()).toEqual(["execute_tool file_ops", "gen_ai.agent.turn", "trent.run"]);
    expect(attr(spans.find((s) => s.name === "trent.run")!, "trent.run.status")?.stringValue).toBe("failed");
  });

  it("flush() exports spans of a run that has not ended yet, so a cancelled process still ships what it has", async () => {
    const exporter = new OTelExporter({ endpoint });
    const hook = createOTelBusHook(exporter);
    hook.sink(ev("run_start", "2026-09-15T10:00:00.000Z", { run: { objective: "x" } }));
    hook.sink(ev("step_start", "2026-09-15T10:00:01.000Z", { step: { ...STEP, status: "running" } }));
    hook.sink(ev("step_end", "2026-09-15T10:00:02.000Z", { step: { ...STEP, status: "completed" } }));
    await hook.flush();
    expect(received).toHaveLength(1);
    const spans = (JSON.parse(received[0]!.body) as OtlpPayload).resourceSpans[0]!.scopeSpans[0]!.spans;
    expect(spans.map((s) => s.name)).toEqual(["gen_ai.agent.turn"]);
  });

  it("an unreachable endpoint is reported through onError and never throws into the run", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const errors: string[] = [];
    const exporter = new OTelExporter({ endpoint });
    const hook = createOTelBusHook(exporter, { onError: (message) => errors.push(message) });
    hook.sink(ev("run_start", "2026-09-15T10:00:00.000Z", { run: { objective: "x" } }));
    hook.sink(ev("run_cancelled", "2026-09-15T10:00:01.000Z"));
    await hook.flush();
    // Once for the export at run end, once for the retry flush() makes while spans are still buffered.
    expect(errors).toHaveLength(2);
    for (const message of errors) expect(message).toContain(endpoint);
    expect(exporter.getBufferedCount()).toBe(1);
    server = http.createServer(() => undefined);
  });
});

describe("composeBusHooks", () => {
  it("fans every event out to each hook and flush awaits all of them", async () => {
    const seen: string[] = [];
    let flushedA = false;
    let flushedB = false;
    const a = { sink: (e: OrcEvent) => void seen.push(`a:${e.kind}`), flush: async () => void (flushedA = true) };
    const b = { sink: (e: OrcEvent) => void seen.push(`b:${e.kind}`), flush: async () => void (flushedB = true) };
    const composed = composeBusHooks(a, b);
    composed.sink(ev("run_start", "2026-09-15T10:00:00.000Z"));
    await composed.flush();
    expect(seen).toEqual(["a:run_start", "b:run_start"]);
    expect(flushedA && flushedB).toBe(true);
  });

  it("with a single hook returns that hook itself", () => {
    const a = { sink: () => undefined, flush: async () => undefined };
    expect(composeBusHooks(a)).toBe(a);
  });
});
