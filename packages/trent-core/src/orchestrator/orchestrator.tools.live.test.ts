/**
 * The live proof for the tools build: ONE real orchestration on `gemini-3.5-flash-lite` (Google's
 * OpenAI-compatible endpoint, the surface the configured key answers on) with `toolsets:
 * [file_ops, terminal]` wired, asking for the name field of package.json. The proof is that the
 * REAL model chooses `read_file` and the recorded tool result carries the real name — before this
 * build the same seat recorded `Tool "read_file" is not allowed for this seat.`
 *
 * Every provider call is traced by a loopback proxy (`GOOGLE_BASE_URL`), so the assistant content
 * where the model asked for the tool is on record; the key is forwarded verbatim and never read.
 * Gated like every live suite: `TRENT_TEST_LIVE=1` and a key in <repo>/gem.env or `GEMINI_API_KEY`.
 */
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrcEvent, OrchestrationRunSnapshot } from "./types.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const LIVE_MODEL = process.env.GOOGLE_MODEL_DEFAULT ?? "gemini-3.5-flash-lite";
const GOOGLE_UPSTREAM = "https://generativelanguage.googleapis.com";

function readGeminiKey(): string | undefined {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of fs.readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/.exec(line);
      if (match) {
        const value = match[1]!.trim().replace(/^["']|["']$/g, "");
        if (value) return value;
      }
    }
  } catch {
    /* no gem.env */
  }
  return undefined;
}
const GEMINI_API_KEY = readGeminiKey();
const LIVE = process.env.TRENT_TEST_LIVE === "1" && GEMINI_API_KEY !== undefined;
if (!LIVE) console.error("[orchestrator.tools.live] SKIPPED: needs TRENT_TEST_LIVE=1 and GEMINI_API_KEY. A skip is NOT a pass.");

const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "TRENT_QUEUE_FALLBACK",
  "TRENT_EVAL_SYNC_QUEUE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
  "GOOGLE_BASE_URL", "GOOGLE_MODEL_FAST", "GOOGLE_MODEL_DEFAULT", "GOOGLE_MODEL_STRONG", "MODEL_PREFERRED_PROVIDER", "MODEL_ALLOWED_PROVIDERS"] as const;
const savedEnv: Record<string, string | undefined> = {};

type ProviderCall = { seq: number; status?: number; content?: string; toolLines?: string[] };
type ToolCall = { adapter: string; action: string; status: string; summary: string };
type StepWithTools = OrchestrationRunSnapshot["steps"][number] & { toolCalls?: ToolCall[] };

/** Records the seat prompts' tool lines and the raw assistant content; the Authorization header is only forwarded. */
async function startTracingProxy(calls: ProviderCall[]): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let seq = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const call: ProviderCall = { seq: ++seq };
      calls.push(call);
      try {
        const body = JSON.parse(bodyText) as { messages?: Array<{ role?: string; content?: string }> };
        call.toolLines = (body.messages ?? [])
          .filter((m) => m.role === "user")
          .flatMap((m) => (m.content ?? "").split("\n"))
          .filter((line) => /^(Available tools:|Tool guidance:|Tool-use step|- file_ops|- terminal)/.test(line))
          .map((line) => line.slice(0, 300));
      } catch {
        /* not JSON */
      }
      try {
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === "string" && name !== "host" && name !== "content-length") headers[name] = value;
        }
        const upstream = await fetch(`${GOOGLE_UPSTREAM}${req.url ?? ""}`, { method: req.method, headers, body: bodyText });
        const text = await upstream.text();
        call.status = upstream.status;
        try {
          call.content = (JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content;
        } catch {
          call.content = text.split(/\r?\n/).filter((l) => l.startsWith("data:") && !l.includes("[DONE]"))
            .map((l) => { try { return (JSON.parse(l.slice(5)) as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0]?.delta?.content ?? ""; } catch { return ""; } })
            .join("");
        }
        res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
        res.end(text);
      } catch (error) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/v1beta/openai/`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe.skipIf(!LIVE)("tools — live: gemini-3.5-flash-lite chooses and uses read_file", () => {
  const events: OrcEvent[] = [];
  const providerCalls: ProviderCall[] = [];
  let snapshot: OrchestrationRunSnapshot;
  let expectedName = "";
  let profileDir = "";
  let closeProxy: () => Promise<void> = async () => undefined;
  let cleanup: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    const proxy = await startTracingProxy(providerCalls);
    closeProxy = proxy.close;
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
    process.env.GEMINI_API_KEY = GEMINI_API_KEY;
    process.env.GOOGLE_BASE_URL = proxy.baseUrl;
    process.env.GOOGLE_MODEL_FAST = LIVE_MODEL;
    process.env.GOOGLE_MODEL_DEFAULT = LIVE_MODEL;
    process.env.GOOGLE_MODEL_STRONG = LIVE_MODEL;
    process.env.MODEL_PREFERRED_PROVIDER = "google";
    process.env.MODEL_ALLOWED_PROVIDERS = "google";

    expectedName = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { name: string }).name;
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-tools-live-"));
    const { buildTrentToolAdapters } = await import("../tools/index.js");
    const tools = buildTrentToolAdapters(
      { toolsets: ["file_ops", "terminal"], disabled_toolsets: [] },
      { workspace: REPO_ROOT, profileDir, dockerImage: "alpine:3" },
    );
    cleanup = async () => {
      for (const tool of tools) await tool.cleanup();
    };

    const { createOrchestrator } = await import("./index.js");
    const orchestrator = createOrchestrator({ tools, model: { provider: "google", model: LIVE_MODEL }, traceSink: (event) => void events.push(event) });
    const companyId = await orchestrator.ensureCompany({ name: "Live tools proof", vision: "prove a seat reads a repo file" });
    // "send/publish/delete..." avoided: the fallback planner's approval regex would park the run.
    const objective =
      'Report the exact value of the "name" field in the file package.json at the root of the workspace. ' +
      'Do not guess: call the file_ops tool with toolCall {"name":"file_ops","action":"read_file {\\"path\\":\\"package.json\\"}"} ' +
      "and take the value from the tool result.";
    const handle = orchestrator.run({ companyId, objective, trigger: "manual" });
    for await (const event of handle) {
      if (event.kind === "run_awaiting_approval" && event.step?.id) await orchestrator.approve(event.runId, event.step.id);
    }
    snapshot = await handle.result();
  }, 300_000);

  afterAll(async () => {
    await cleanup();
    await closeProxy();
    const out = process.env.TRENT_LIVE_EVIDENCE_OUT;
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ model: LIVE_MODEL, expectedName, events, providerCalls, snapshot }, null, 2));
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("finishes completed with run_done exactly once", () => {
    expect(events.filter((event) => event.kind === "run_done")).toHaveLength(1);
    expect(snapshot.status).toBe("completed");
  });

  it("the seat prompt offered file_ops, and the REAL model asked for read_file", () => {
    const offered = providerCalls.filter((call) => (call.toolLines ?? []).some((line) => /^Available tools:.*file_ops/.test(line)));
    expect(offered.length, "seat prompts that advertised file_ops").toBeGreaterThanOrEqual(1);
    const chose = providerCalls.filter((call) => /read_file/.test(call.content ?? "") && /toolCall/.test(call.content ?? ""));
    expect(chose.length, "provider replies containing a read_file toolCall").toBeGreaterThanOrEqual(1);
  });

  it("the recorded file_ops call completed and carries the real name; no 'not allowed for this seat'", () => {
    const calls = (snapshot.steps as StepWithTools[]).flatMap((step) => step.toolCalls ?? []);
    const read = calls.find((call) => call.adapter === "file_ops" && /read_file/.test(call.action) && call.status === "completed");
    expect(read, JSON.stringify(calls.map((c) => [c.adapter, c.action.slice(0, 60), c.status, c.summary.slice(0, 80)]))).toBeDefined();
    expect(read!.summary).toContain(`"name": "${expectedName}"`);
    expect(calls.some((call) => /not allowed for this seat/.test(call.summary))).toBe(false);
  });

  it("the name reached the step output", () => {
    const step = (snapshot.steps as StepWithTools[]).find((s) => (s.toolCalls ?? []).some((c) => c.adapter === "file_ops"));
    expect(step?.output ?? "").toContain(expectedName);
  });
});
