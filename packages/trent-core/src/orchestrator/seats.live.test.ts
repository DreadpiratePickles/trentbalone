/**
 * Phase B live proof — seats are different capabilities, on a real run against a real model.
 *
 * `seat-wiring.per-seat.test.ts` proves the mapping as a pure function. What it cannot prove is
 * that a REAL plan from a REAL planner routes work to the seat that owns it, that the seat loop
 * then runs with the environment 80a1497 recorded for THAT seat, and that the difference survives
 * the whole pipeline: before B2 every seat received one adapter list, so a finance seat carried
 * the sandboxed shell and nobody could tell from a run that it should not have.
 *
 * One run, two working seats:
 *   - the planner is asked for one finance step and one analyst step, and the emitted bus events
 *     are read for the seats that actually ran;
 *   - both steps must end `completed`;
 *   - the environment the run RECORDED for finance (`getAgentPlugAssignment`, what
 *     `getAgentRuntime` hands the seat loop) must carry no `terminal` and no `process_manage`,
 *     while the analyst's — whose manifest names `Workbench Sandbox` — must carry both.
 *
 * Every provider call is traced by a loopback proxy that `GOOGLE_BASE_URL` points at, so the
 * finance seat's own prompt is on record and its `Available tools:` line is asserted. The
 * Authorization header is forwarded verbatim, never read, never logged.
 *
 * Gated like every live suite: `TRENT_TEST_LIVE=1` and a key in `GEMINI_API_KEY` or <repo>/gem.env.
 * A skip is NOT a pass.
 */
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrcEvent, OrchestrationRunSnapshot } from "./types.js";
import type { SeatEnvironment } from "./libs.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const LIVE_MODEL = process.env.GOOGLE_MODEL_DEFAULT ?? "gemini-3.5-flash-lite";
const GOOGLE_UPSTREAM = "https://generativelanguage.googleapis.com";

function readGeminiKey(): string | undefined {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    for (const line of fs.readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      const value = match[1]!.trim().replace(/^["']|["']$/g, "");
      if (value !== "") return value;
    }
  } catch {
    /* no gem.env on this machine */
  }
  return undefined;
}

const GEMINI_API_KEY = readGeminiKey();
const LIVE = process.env.TRENT_TEST_LIVE === "1" && GEMINI_API_KEY !== undefined;
if (!LIVE) {
  console.error(
    "[orchestrator seats.live] SKIPPED: needs TRENT_TEST_LIVE=1 and GEMINI_API_KEY (env or <repo>/gem.env). " +
      "This suite is the proof that a live run routes to the finance and analyst seats with per-seat tools; a skip is NOT a pass.",
  );
}

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

/** One outbound provider request as the proxy saw it. Never carries the key. */
interface ProviderCall {
  seq: number;
  status?: number;
  /** The seat this prompt was built for, from the seat prompt's own `Seat:` line. */
  seat?: string;
  /** The seat prompt's `Available tools:` line, when the call was a seat tool loop. */
  availableTools?: string;
}

function seatOf(messages: ReadonlyArray<{ role?: string; content?: string }>): { seat?: string; availableTools?: string } {
  const text = messages.filter((message) => message.role === "user").map((message) => message.content ?? "").join("\n");
  const seat = /^Seat: (.+)$/m.exec(text)?.[1]?.trim();
  const tools = /^Available tools: (.*)$/m.exec(text)?.[1]?.trim();
  return { ...(seat === undefined ? {} : { seat }), ...(tools === undefined ? {} : { availableTools: tools }) };
}

/** A loopback proxy in front of Google's OpenAI-compatible endpoint; the SDK does not use global fetch. */
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
        Object.assign(call, seatOf(body.messages ?? []));
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
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/v1beta/openai/`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/**
 * Small on purpose: two working steps of arithmetic and one sentence, so the bill is a few cents.
 * "send/publish/merge/deploy" are avoided — the fallback planner's approval regex would park the run.
 */
const OBJECTIVE =
  "Plan exactly two working steps and one final consolidation step, and no others. " +
  'Step one, agentRole "finance": compute the monthly cost of 12 seats at 40 dollars per seat per month and state the total in dollars. ' +
  'Step two, agentRole "analyst": state in one sentence the single biggest risk to that estimate. ' +
  "Keep every step's output under 50 words. Do not assign any step to the growth seat.";

describe.skipIf(!LIVE)("a live run that needs a finance seat and an analyst seat", () => {
  const events: OrcEvent[] = [];
  const providerCalls: ProviderCall[] = [];
  let snapshot: OrchestrationRunSnapshot;
  let companyId = "";
  let wallMs = 0;
  const approvals: string[] = [];
  /** What the run recorded for each seat: the environment `getAgentRuntime` hands the seat loop. */
  const recorded = new Map<string, SeatEnvironment>();
  let profileDir = "";
  let closeProxy: () => Promise<void> = async () => undefined;
  let cleanupTools: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    const proxy = await startTracingProxy(providerCalls);
    closeProxy = proxy.close;
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Not `test`: vitest's default also disables the queue fallback, which would make the
    // run_done-exactly-once assertion pass vacuously.
    process.env.NODE_ENV = "production";
    process.env.GEMINI_API_KEY = GEMINI_API_KEY;
    process.env.GOOGLE_BASE_URL = proxy.baseUrl;
    process.env.GOOGLE_MODEL_FAST = LIVE_MODEL;
    process.env.GOOGLE_MODEL_DEFAULT = LIVE_MODEL;
    process.env.GOOGLE_MODEL_STRONG = LIVE_MODEL;
    process.env.MODEL_PREFERRED_PROVIDER = "google";
    process.env.MODEL_ALLOWED_PROVIDERS = "google";

    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-seats-live-"));
    // The shell is BUILT, so "finance has no terminal" is a gate and not an absence: the engineer
    // and analyst manifests entitle them to exactly these two adapters.
    const { buildTrentToolAdapters } = await import("../tools/index.js");
    const tools = buildTrentToolAdapters(
      { toolsets: ["file_ops", "terminal"], disabled_toolsets: [] },
      { workspace: profileDir, profileDir, dockerImage: "alpine:3" },
    );
    cleanupTools = async () => {
      for (const tool of tools) await tool.cleanup();
    };

    const { createOrchestrator } = await import("./index.js");
    const orchestrator = createOrchestrator({
      tools,
      model: { provider: "google", model: LIVE_MODEL },
      traceSink: (event) => void events.push(event),
    });
    companyId = await orchestrator.ensureCompany({ name: "Live seat proof", vision: "prove seats are different capabilities" });

    const started = Date.now();
    const handle = orchestrator.run({ companyId, objective: OBJECTIVE, trigger: "manual" });
    for await (const event of handle) {
      // The critic is a real model now: a live verdict of "escalate" parks the run on a founder
      // gate. Answer it so the proof terminates, and record that it happened.
      if (event.kind === "run_awaiting_approval" && event.step?.id !== undefined) {
        approvals.push(event.step.id);
        await orchestrator.approve(event.runId, event.step.id);
      }
    }
    snapshot = await handle.result();
    wallMs = Date.now() - started;

    // Read back what the run wrote for each seat — the same rows the seat loop resolves from.
    const { store } = await import("@/lib/store");
    for (const seat of ["finance", "analyst", "engineer"] as const) {
      const assignment = (await store.getAgentPlugAssignment(companyId, seat)) as { environment: SeatEnvironment } | null | undefined;
      if (assignment?.environment !== undefined) recorded.set(seat, assignment.environment);
    }

    const roles = snapshot.steps.map((step) => `${step.agentRole}:${step.status}`).join(", ");
    const cents = snapshot.steps.reduce((sum, step) => sum + (step.costCents ?? 0), 0);
    console.error(
      `[seats.live] model=${LIVE_MODEL} steps=[${roles}] status=${snapshot.status} ` +
        `cost=${cents} cent(s) wall=${wallMs}ms provider_calls=${providerCalls.length} approvals=${approvals.length}`,
    );
  }, 600_000);

  afterAll(async () => {
    await cleanupTools();
    await closeProxy();
    const out = process.env.TRENT_LIVE_EVIDENCE_OUT;
    if (out !== undefined && out !== "") {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(
        out,
        JSON.stringify(
          { model: LIVE_MODEL, objective: OBJECTIVE, wallMs, approvals, events, providerCalls, recorded: [...recorded], snapshot },
          null,
          2,
        ),
      );
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (profileDir !== "") fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("the run finished, with run_done exactly once", () => {
    expect(events.filter((event) => event.kind === "run_done")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "run_failed")).toHaveLength(0);
    expect(snapshot.status).toBe("completed");
  });

  it("a finance seat and an analyst seat each ran a step, and neither is ceo or growth", () => {
    const starts = events.filter((event) => event.kind === "step_start").map((event) => event.step?.agentRole);
    expect(starts, `seats announced by step_start: ${starts.join(", ")}`).toContain("finance");
    expect(starts).toContain("analyst");
    // The seat the objective told the planner to leave alone. `ceo` is NOT asserted absent: the
    // app's planner is instructed to close every plan with a ceo consolidation step
    // (`apps/web/lib/orchestrator-runtime.ts`, plan rule 2), which is read-only.
    expect(starts).not.toContain("growth");

    const steps = snapshot.steps.filter((step) => step.agentRole === "finance" || step.agentRole === "analyst");
    expect(steps.length).toBeGreaterThanOrEqual(2);
    for (const step of steps) expect(step.status, `${step.agentRole} step status`).toBe("completed");
    // Real work, not an empty seat turn.
    for (const step of steps) expect((step.output ?? "").trim().length, `${step.agentRole} output`).toBeGreaterThan(0);
  });

  it("the finance seat's recorded environment carries no shell; the analyst's does", () => {
    const finance = recorded.get("finance");
    const analyst = recorded.get("analyst");
    expect(finance, "finance seat assignment recorded by the run").toBeDefined();
    expect(analyst, "analyst seat assignment recorded by the run").toBeDefined();

    // Per-seat gating (80a1497): finance's manifest names no capability that maps to `terminal`.
    expect(finance!.tools).not.toContain("terminal");
    expect(finance!.tools).not.toContain("process_manage");
    expect(finance!.tools).not.toContain("file_ops");
    // A seat may be stricter than the approval floor, never looser.
    expect(finance!.approvalRequiredFor).not.toContain("terminal.dangerous");
    expect(finance!.approvalRequiredFor).toEqual(expect.arrayContaining(["payout", "refund"]));

    // The same build, a different seat: the shell exists, finance simply may not have it.
    expect(analyst!.tools).toEqual(expect.arrayContaining(["terminal", "process_manage"]));
    expect(recorded.get("engineer")?.tools ?? []).toContain("terminal");
  });

  it("the finance seat's own prompt never offered it the shell", () => {
    const financeCalls = providerCalls.filter((call) => call.seat === "finance");
    expect(financeCalls.length, "provider calls built for the finance seat").toBeGreaterThanOrEqual(1);
    for (const call of financeCalls) {
      expect(call.availableTools ?? "", `finance seat prompt #${call.seq}`).not.toContain("terminal");
      expect(call.availableTools ?? "").not.toContain("process_manage");
    }
    // The analyst's prompt is the control: if no seat prompt ever advertised the shell, the
    // assertion above would be vacuous.
    const analystTools = providerCalls.filter((call) => call.seat === "analyst").map((call) => call.availableTools ?? "");
    expect(analystTools.some((line) => line.includes("terminal"))).toBe(true);
  });

  it("reports integer cents per step", () => {
    let total = 0;
    for (const step of snapshot.steps) {
      expect(Number.isInteger(step.costCents ?? 0)).toBe(true);
      total += step.costCents ?? 0;
    }
    expect(Number.isInteger(total)).toBe(true);
    expect(wallMs).toBeGreaterThan(0);
  });
});
