/**
 * The REPL over the REAL orchestrator wrapper — wired exactly as `index.ts` wires it — with the
 * seat provider replaced by a fake. This is the transcript-level proof for the live-proof
 * defects (04_verification/output/live-agents-and-tools.md §3-4):
 *
 *   D1  a run whose every model call 404s renders as a failure, never `Run complete`
 *   D2  answering the card actually calls `orchestrator.approve(runId, stepId)` and the run proceeds
 *   D4  an objective containing "send" produces an answerable gate, not a silent stall
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTheme, GLYPHS } from "../../ui/index.js";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import type { Orchestrator, SeatChatResponse } from "@trent/core/orchestrator/index.js";
import { ReplEngine, bindApprovalAnswers, type ReplRunner } from "../engine.js";
import { MemoryStore } from "./harness.js";

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
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_MODEL_FAST",
  "GOOGLE_MODEL_DEFAULT",
  "GOOGLE_MODEL_STRONG",
  "MODEL_PREFERRED_PROVIDER",
  "MODEL_ALLOWED_PROVIDERS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

function finalTurn(summary: string): SeatChatResponse {
  return {
    choices: [{ message: { content: JSON.stringify({ toolCall: null, summary, findings: [], recommendations: [], workRequests: [] }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

interface Session {
  engine: ReplEngine;
  out: string[];
  approve: ReturnType<typeof vi.fn>;
  reject: ReturnType<typeof vi.fn>;
}

/** The `index.ts` wiring, minus the terminal: config -> createOrchestrator -> runner -> engine. */
async function openSession(companyId: string, provider: () => Promise<SeatChatResponse>): Promise<Session> {
  const { createOrchestrator } = await import("@trent/core/orchestrator/index.js");
  const real = createOrchestrator({
    model: { provider: DEFAULT_CONFIG.provider, model: DEFAULT_CONFIG.model },
    createChatCompletion: provider,
  });
  const approve = vi.fn((runId: string, stepId: string) => real.approve(runId, stepId));
  const reject = vi.fn((runId: string, stepId: string) => real.reject(runId, stepId));
  const orchestrator: Orchestrator = { ...real, approve, reject };
  const runner: ReplRunner = ({ objective, signal }) =>
    orchestrator.run({ companyId, objective, trigger: "manual", signal });
  const out: string[] = [];
  const engine = new ReplEngine({
    theme: createTheme("none"),
    config: DEFAULT_CONFIG,
    store: new MemoryStore(),
    companyId,
    runner,
    width: 80,
    write: (line) => void out.push(line),
    exit: () => undefined,
    onApprovalAnswer: bindApprovalAnswers(orchestrator),
  });
  return { engine, out, approve, reject };
}

async function newCompany(name: string): Promise<string> {
  const { store } = await import("@/lib/store");
  return (await store.createCompany({ name, brief: { vision: "repl defect regression" } })).id;
}

async function until(predicate: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the REPL");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the REPL over the real orchestrator", () => {
  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("D1: a run whose every model call 404s renders as a failure with the provider's message, and no success glyph", async () => {
    const companyId = await newCompany("REPL D1");
    const session = await openSession(companyId, async () => {
      throw new Error("404 status code (no body)");
    });
    await session.engine.submit("Summarise the operating brief in two lines.");
    const transcript = session.engine.transcript;

    expect(transcript.join("\n")).toContain("404 status code (no body)");
    expect(transcript.some((line) => line.includes("Run failed"))).toBe(true);
    expect(transcript.some((line) => line.includes("Run complete"))).toBe(false);
    expect(transcript.some((line) => line.includes(GLYPHS.done))).toBe(false);
  }, 60_000);

  it("D2 + D4: an objective containing 'send' opens an answerable gate; 'y' calls approve(runId, stepId) and the run proceeds", async () => {
    const companyId = await newCompany("REPL D2 D4");
    const session = await openSession(companyId, async () => finalTurn("done"));
    const turn = session.engine.submit("Draft and send the weekly investor update to the team.");

    await until(() => session.engine.awaitingApproval);
    const card = session.out.join("\n");
    expect(card).toContain("APPROVAL REQUIRED");
    expect(card).toMatch(/fallback planner/i);
    expect(session.engine.busy).toBe(true);

    session.engine.feed("y");
    await turn;

    expect(session.approve).toHaveBeenCalledTimes(1);
    const [runId, stepId] = session.approve.mock.calls[0]!;
    expect(runId).toMatch(/^orc_/);
    expect(stepId).toMatch(/^s\d+$/);
    expect(session.reject).not.toHaveBeenCalled();
    expect(session.engine.context.runIds).toEqual([runId]);

    const transcript = session.engine.transcript;
    expect(transcript.some((line) => line.includes("Run complete"))).toBe(true);
    // The gate was answered exactly once even though the bus emits both step_ and run_awaiting_approval.
    expect(transcript.filter((line) => line.includes("awaiting your approval"))).toHaveLength(1);
  }, 60_000);
});
