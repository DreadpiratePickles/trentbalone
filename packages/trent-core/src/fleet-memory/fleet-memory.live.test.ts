/**
 * Live proof on gemini-3.5-flash-lite: two consecutive runs by different seats, and the second
 * demonstrably uses the first's output. Run 1 has the engineer establish a fact (and asks it to
 * store it with the shared `memory` tool); run 2 asks the support seat a question whose only
 * source is run 1. The second seat's prelude lines and its answer are printed for the report.
 *
 * Needs TRENT_TEST_LIVE=1 and GEMINI_API_KEY (env or <repo>/gem.env). A skip is NOT a pass.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrchestrationRunSnapshot } from "../orchestrator/types.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const LIVE_MODEL = process.env.GOOGLE_MODEL_DEFAULT ?? "gemini-3.5-flash-lite";

function readGeminiKey(): string | undefined {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of fs.readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const value = match[1]!.trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    }
  } catch {
    /* no gem.env */
  }
  return undefined;
}

const GEMINI_API_KEY = readGeminiKey();
const LIVE = process.env.TRENT_TEST_LIVE === "1" && GEMINI_API_KEY !== undefined;
if (!LIVE) console.error("[fleet-memory.live] SKIPPED: needs TRENT_TEST_LIVE=1 and GEMINI_API_KEY (env or <repo>/gem.env).");

const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "REDIS_URL", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "TRENT_QUEUE_FALLBACK",
  "TRENT_EVAL_SYNC_QUEUE", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
  "GOOGLE_MODEL_FAST", "GOOGLE_MODEL_DEFAULT", "GOOGLE_MODEL_STRONG", "MODEL_PREFERRED_PROVIDER", "MODEL_ALLOWED_PROVIDERS"] as const;
const savedEnv: Record<string, string | undefined> = {};

type SeatInput = { subtask: { id: string; seat: string; objective: string }; dynamicPrompt?: string };

/** The fact only run 1 can establish; a made-up value so the model cannot know it from training. */
const FACT = "the Northwind partner API rate limit is 47 requests per minute per key";

describe.skipIf(!LIVE)(`fleet memory on ${LIVE_MODEL}: run 2 (support) uses run 1 (engineer)`, () => {
  const seatInputs: SeatInput[] = [];
  let profileDir = "";
  let first: OrchestrationRunSnapshot;
  let second: OrchestrationRunSnapshot;
  let secondPrelude = "";
  let secondAnswer = "";

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
    process.env.GEMINI_API_KEY = GEMINI_API_KEY;
    process.env.GOOGLE_MODEL_FAST = LIVE_MODEL;
    process.env.GOOGLE_MODEL_DEFAULT = LIVE_MODEL;
    process.env.GOOGLE_MODEL_STRONG = LIVE_MODEL;
    process.env.MODEL_PREFERRED_PROVIDER = "google";
    process.env.MODEL_ALLOWED_PROVIDERS = "google";
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-fleet-live-"));

    const { createFleetMemoryHook, createAppFleetSource } = await import("./index.js");
    const { createOrchestrator } = await import("../orchestrator/index.js");
    const fleetMemory = createFleetMemoryHook({ source: createAppFleetSource(), profileDir });
    const model = { provider: "google", model: LIVE_MODEL };
    const orchestrator = createOrchestrator({ fleetMemory, model });
    // Observe the seat prompts without replacing the executor: wrap the installed seat model port.
    const companyId = await orchestrator.ensureCompany({ name: "Fleet memory live proof", vision: "shared memory across seats" });

    const observe = fleetMemory.wrapSeatModel;
    (fleetMemory as { wrapSeatModel: typeof observe }).wrapSeatModel = (fn) =>
      observe(async (input) => {
        seatInputs.push(input as unknown as SeatInput);
        return fn(input);
      });

    const objective1 =
      `Engineering note: we measured that ${FACT}. Use the memory tool (target=memory, action=add) to record this exact fact ` +
      `for the rest of the company, then reply with a one-line summary that repeats the number.`;
    const h1 = createOrchestrator({ fleetMemory, model }).run({ companyId, objective: objective1 });
    for await (const event of h1) {
      if (event.kind === "run_awaiting_approval" && event.step?.id) await orchestrator.approve(event.runId, event.step.id);
    }
    first = await h1.result();

    const objective2 = "Customer support: a customer asks what the Northwind partner API rate limit is. Answer with the exact number our company already knows; do not guess.";
    const h2 = createOrchestrator({ fleetMemory, model }).run({ companyId, objective: objective2 });
    for await (const event of h2) {
      if (event.kind === "run_awaiting_approval" && event.step?.id) await orchestrator.approve(event.runId, event.step.id);
    }
    second = await h2.result();
    secondPrelude = fleetMemory.preludeFor(h2.runId) ?? "";
    secondAnswer = second.steps.map((s) => s.output ?? "").join("\n") + "\n" + (second.summary ?? "");

    const lines = secondPrelude.split("\n").filter((l) => /47|Northwind|Fleet recall|Company memory|MEMORY\.md/.test(l));
    console.log("[fleet-memory.live] run 1 status:", first.status, "steps:", first.steps.map((s) => `${s.agentRole}:${s.status}`).join(","));
    console.log("[fleet-memory.live] MEMORY.md:", fs.existsSync(path.join(profileDir, "memories", "MEMORY.md")) ? fs.readFileSync(path.join(profileDir, "memories", "MEMORY.md"), "utf8") : "(not written)");
    console.log("[fleet-memory.live] run 2 prelude lines:\n" + lines.map((l) => "  " + l.slice(0, 300)).join("\n"));
    console.log("[fleet-memory.live] run 2 prelude chars:", secondPrelude.length, "recall block chars:", Math.max(0, secondPrelude.length - secondPrelude.indexOf("## Fleet recall")));
    console.log("[fleet-memory.live] run 2 answer:\n" + secondAnswer.slice(0, 1200));
  }, 600_000);

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("both runs complete on the live model", () => {
    expect(first.status, first.summary ?? "").toBe("completed");
    expect(second.status, second.summary ?? "").toBe("completed");
  });

  it("run 2's prelude carries run 1's fact (via shared memory and/or recall of the engineer's output)", () => {
    expect(secondPrelude).toMatch(/47/);
    expect(secondPrelude).toMatch(/Northwind/i);
  });

  it("run 2's answer states the number that only run 1 established", () => {
    expect(secondAnswer).toMatch(/47/);
  });
});
