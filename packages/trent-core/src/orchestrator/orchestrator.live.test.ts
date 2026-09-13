/**
 * The live proof that agents RUN and CALL TOOLS against a real, cheap model.
 *
 * One real orchestration through `createOrchestrator()` with the REAL gateway — no mock providers,
 * no `runtime-eval-overrides` ports — on `gemini-3.5-flash-lite` through Google's OpenAI-compatible
 * endpoint (the only surface that answers on this key; see config/defaults.ts).
 *
 * The objective is chosen so the answer is unobtainable without a tool: the company is seeded with
 * exactly SEEDED_DOCS memory documents and the seat is asked for the count. The only way to know
 * the number is to invoke the `memory:read` internal action, whose result is recorded on
 * `step.toolCalls` and asserted here. Every outbound HTTP call to the provider is traced (path,
 * model, status, token usage, prompt excerpt, raw reply) by a loopback proxy that `GOOGLE_BASE_URL`
 * points at; the key is forwarded as an opaque header and never read or printed.
 *
 * Gated like the other live suites: `TRENT_TEST_LIVE=1` (root vitest config) AND a key in
 * <repo>/gem.env or `GEMINI_API_KEY`. A skip is NOT a pass.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { OrcEvent, OrchestrationRunSnapshot, OrchestrationStepSnapshot } from "./types.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const LIVE_MODEL = process.env.GOOGLE_MODEL_DEFAULT ?? "gemini-3.5-flash-lite";
const SEEDED_DOCS = 3;

function readGeminiKey(): string | undefined {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[1]!.trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  } catch {
    /* no gem.env: skip, loudly */
  }
  return undefined;
}

const GEMINI_API_KEY = readGeminiKey();
const LIVE = process.env.TRENT_TEST_LIVE === "1" && GEMINI_API_KEY !== undefined;

if (!LIVE) {
  console.error(
    "[orchestrator.live] SKIPPED: needs TRENT_TEST_LIVE=1 and GEMINI_API_KEY (env or <repo>/gem.env). " +
      "This suite is the proof that agents run and call tools on a real model; a skip is NOT a pass.",
  );
}

/** One outbound provider request as seen by the forwarding proxy. Never contains the key. */
type ProviderCall = {
  seq: number;
  path: string;
  model?: string;
  status?: number;
  ms: number;
  /** The seat/user prompt lines that matter for the tool proof (Available tools, Tool-use step). */
  promptExcerpt?: string[];
  /** The raw assistant content the model returned — this is where a toolCall shows up. */
  content?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: string;
};

/** A phase frame from `emitJobEvent` (the job-run feed), distinct from the 20-kind orc bus. */
type JobFrame = { status?: string; summary?: string; phase?: string; label?: string; at?: string };

type ToolCallRecord = { adapter: string; action: string; status: string; summary: string };
type StepWithTools = OrchestrationStepSnapshot & { toolCalls?: ToolCallRecord[] };

const GOOGLE_UPSTREAM = "https://generativelanguage.googleapis.com";

const ENV_KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "REDIS_URL",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "TRENT_QUEUE_FALLBACK",
  "TRENT_EVAL_SYNC_QUEUE",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_BASE_URL",
  "GOOGLE_MODEL_FAST",
  "GOOGLE_MODEL_DEFAULT",
  "GOOGLE_MODEL_STRONG",
  "MODEL_PREFERRED_PROVIDER",
  "MODEL_ALLOWED_PROVIDERS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

/** Gemini-only, like a fresh install whose only key is GEMINI_API_KEY. */
function imitateGeminiOnlyInstall(proxyBaseUrl: string): void {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Not `test`: vitest's default also disables the queue fallback, which would make the
  // run_done-exactly-once assertion pass vacuously. Same choice as orchestrator.test.ts.
  process.env.NODE_ENV = "production";
  process.env.GEMINI_API_KEY = GEMINI_API_KEY;
  process.env.GOOGLE_BASE_URL = proxyBaseUrl;
  // ai-client.ts resolves google model names per tier from these; the hard-coded defaults
  // (gemini-2.0-flash / gemini-2.5-pro) are retired and 404. apps/web is read-only, so pin here.
  process.env.GOOGLE_MODEL_FAST = LIVE_MODEL;
  process.env.GOOGLE_MODEL_DEFAULT = LIVE_MODEL;
  process.env.GOOGLE_MODEL_STRONG = LIVE_MODEL;
  process.env.MODEL_PREFERRED_PROVIDER = "google";
  process.env.MODEL_ALLOWED_PROVIDERS = "google";
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function excerptPrompt(messages: Array<{ role?: string; content?: string }>): string[] {
  const user = messages.filter((m) => m.role === "user").map((m) => m.content ?? "").join("\n");
  return user
    .split("\n")
    .filter((line) => /^(Seat:|Objective:|Tool guidance:|Available tools:|Tool-use step|- .*\("|Prior tool results)/.test(line))
    .map((line) => line.slice(0, 400));
}

/**
 * A loopback HTTP proxy in front of Google's OpenAI-compatible endpoint. The OpenAI SDK does not
 * route through `globalThis.fetch`, so wrapping fetch sees nothing; pointing `GOOGLE_BASE_URL` at
 * this server is the only way to trace the real traffic without touching apps/web. The
 * Authorization header is forwarded verbatim and never read into the trace.
 */
async function startTracingProxy(calls: ProviderCall[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  let seq = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const call: ProviderCall = { seq: ++seq, path: req.url ?? "", ms: 0 };
      calls.push(call);
      try {
        const body = JSON.parse(bodyText) as { model?: string; messages?: Array<{ role?: string; content?: string }> };
        call.model = body.model;
        call.promptExcerpt = excerptPrompt(body.messages ?? []);
      } catch {
        /* not JSON */
      }
      const started = Date.now();
      try {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === "string" && name !== "host" && name !== "content-length") headers[name] = value;
        }
        const upstream = await fetch(`${GOOGLE_UPSTREAM}${req.url ?? ""}`, {
          method: req.method,
          headers,
          body: bodyText,
        });
        const text = await upstream.text();
        call.status = upstream.status;
        call.ms = Date.now() - started;
        try {
          const json = JSON.parse(text) as {
            usage?: ProviderCall["usage"];
            choices?: Array<{ message?: { content?: string } }>;
            error?: { message?: string };
          };
          call.usage = json.usage;
          call.content = json.choices?.[0]?.message?.content ?? undefined;
          if (json.error?.message) call.error = json.error.message.slice(0, 300);
        } catch {
          call.error = text.slice(0, 300);
        }
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        res.end(text);
      } catch (error) {
        call.ms = Date.now() - started;
        call.error = error instanceof Error ? error.message : String(error);
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: call.error } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1beta/openai/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.skipIf(!LIVE)("orchestrator — live agents and tools on gemini-3.5-flash-lite", () => {
  const events: OrcEvent[] = [];
  const jobFrames: JobFrame[] = [];
  const providerCalls: ProviderCall[] = [];
  let snapshot: OrchestrationRunSnapshot;
  let companyId = "";
  let objective = "";
  let wallMs = 0;
  /** What the store really holds, read back after seeding, so the tool result is checked against truth. */
  let storedDocs = { total: 0, semantic: 0 };
  let closeProxy: () => Promise<void> = async () => undefined;
  let unsubscribeJobs: () => void = () => undefined;

  beforeAll(async () => {
    const proxy = await startTracingProxy(providerCalls);
    closeProxy = proxy.close;
    imitateGeminiOnlyInstall(proxy.baseUrl);

    // Standalone env contract FIRST (inside createOrchestrator), before any apps/web import.
    const { createOrchestrator } = await import("./index.js");
    const orchestrator = createOrchestrator({ traceSink: (event) => void events.push(event) });

    const { store } = await import("@/lib/store");
    const { subscribeJobEvents } = await import("@/lib/job-events");
    unsubscribeJobs = subscribeJobEvents((frame: unknown) => void jobFrames.push(frame as JobFrame));

    const company = await store.createCompany({
      name: "Live tool proof",
      brief: { vision: "prove agents call tools on a cheap model" },
    });
    companyId = company.id;
    for (let index = 1; index <= SEEDED_DOCS; index += 1) {
      await store.createDocument({
        companyId,
        type: "agent_note",
        title: `Seeded memory ${index}`,
        content: `Memory document ${index} of ${SEEDED_DOCS}, seeded by the live proof.`,
        source: "orchestrator.live.test",
        memoryTier: "semantic",
      } as never);
    }

    // The tool is named exactly as the seat loop advertises it. The first live run showed the model
    // splitting it into {name:"memory", action:"read"}, which the resolver rejects, so the
    // objective spells out the exact shape rather than leaving the wire format to chance.
    const docs = (await store.listDocuments(companyId)) as Array<{ memoryTier?: string }>;
    storedDocs = { total: docs.length, semantic: docs.filter((doc) => doc.memoryTier === "semantic").length };

    objective =
      // "send" is avoided on purpose: the deterministic fallback planner's approval regex
      // (/publish|send|merge|deploy|.../) would add an approval gate and park the run.
      'Invoke the tool whose exact name is "memory:read" (toolCall {"name":"memory:read","action":"count memory documents"}) ' +
      "and report the exact number of memory documents this company has. Do not guess and do not " +
      "count documents from context: the number must come from the tool result summary.";

    const started = Date.now();
    const handle = orchestrator.run({ companyId, objective, trigger: "manual" });
    for await (const _event of handle) {
      /* the traceSink already collects; iterating just keeps the handle honest */
    }
    snapshot = await handle.result();
    wallMs = Date.now() - started;
  }, 300_000);

  afterAll(async () => {
    unsubscribeJobs();
    await closeProxy();
    // Written for the evidence file; path from env so the test itself never chooses a location.
    const out = process.env.TRENT_LIVE_EVIDENCE_OUT;
    if (out) {
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(
        out,
        JSON.stringify(
          { model: LIVE_MODEL, companyId, objective, storedDocs, wallMs, events, jobFrames, providerCalls, snapshot },
          null,
          2,
        ),
      );
    }
    restoreEnv();
  });

  it("emits run_done exactly once and finishes completed", () => {
    expect(events.filter((event) => event.kind === "run_done")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "run_failed")).toHaveLength(0);
    expect(snapshot.status).toBe("completed");
  });

  it("runs at least one agent seat, each announced by step_start with its role", () => {
    const starts = events.filter((event) => event.kind === "step_start");
    expect(starts.length).toBeGreaterThanOrEqual(1);
    for (const start of starts) expect(typeof start.step?.agentRole).toBe("string");
    const roles = new Set(starts.map((start) => start.step?.agentRole));
    expect(roles.size).toBeGreaterThanOrEqual(1);
  });

  it("actually reached Google: every provider call is the pinned model and at least one returned 200", () => {
    expect(providerCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of providerCalls) {
      expect(call.path).toMatch(/^\/v1beta\/openai\/chat\/completions/);
      expect(call.model).toBe(LIVE_MODEL);
    }
    expect(providerCalls.some((call) => call.status === 200)).toBe(true);
  });

  it("at least one agent CALLED A TOOL, and the tool's real result carries the seeded count", () => {
    const steps = snapshot.steps as StepWithTools[];
    const toolCalls = steps.flatMap((step) => step.toolCalls ?? []);
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    const memoryReads = toolCalls.filter((call) => call.adapter === "memory:read" && call.status === "completed");
    expect(memoryReads.length).toBeGreaterThanOrEqual(1);
    // createCompany writes the brief as a document too, so total = seeded + 1; the semantic count is
    // exactly what was seeded. Both are checked against the store, not against a guess.
    expect(storedDocs.semantic).toBe(SEEDED_DOCS);
    expect(memoryReads[0]!.summary).toBe(
      `Read ${storedDocs.total} memory document(s), including ${storedDocs.semantic} semantic fact document(s).`,
    );
  });

  it("the tool result reached the final answer", () => {
    const steps = snapshot.steps as StepWithTools[];
    const withTool = steps.find((step) => (step.toolCalls ?? []).some((call) => call.adapter === "memory:read"));
    expect(withTool?.output ?? "").toMatch(new RegExp(`\\b${storedDocs.total}\\b|\\b${storedDocs.semantic}\\b`));
  });

  it("reports integer cents per step and in total", () => {
    let total = 0;
    for (const step of snapshot.steps) {
      expect(Number.isInteger(step.costCents ?? 0)).toBe(true);
      total += step.costCents ?? 0;
    }
    expect(Number.isInteger(total)).toBe(true);
    expect(wallMs).toBeGreaterThan(0);
  });
});
