/**
 * The live end-to-end proof for the REPL.
 *
 * A real turn, over the real model gateway, against a real provider: the tokens are
 * streamed, the cost is the provider's own integer-cent cost, and the ticker is the sum
 * of what actually happened. The key comes from the gitignored gem.env and is never
 * printed. A skip is not a pass.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTheme } from "../../ui/index.js";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import { createModelGateway } from "@trent/core/model-gateway/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { ReplEngine } from "../engine.js";
import { formatCents } from "../budget.js";
import { MemoryStore } from "./harness.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
/**
 * `gemini-3.6-flash` — the model the core's own live suite defaults to — returns HTTP 429
 * on this key through the OpenAI-compatible surface, while `gemini-3.5-flash-lite` serves
 * normally (verified against the models endpoint). Overridable, so the default is not a
 * hidden pin.
 */
const LIVE_MODEL = process.env.GOOGLE_MODEL_DEFAULT ?? "gemini-3.5-flash-lite";

function readGeminiKey(): string | undefined {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    for (const line of readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      const value = match[1]!.trim().replace(/^["']|["']$/g, "");
      if (value !== "") return value;
    }
  } catch {
    /* no gem.env: the suite skips, loudly */
  }
  return undefined;
}

const GEMINI_API_KEY = readGeminiKey();

if (GEMINI_API_KEY === undefined) {
  console.error(
    "[repl live] SKIPPED: no GEMINI_API_KEY in <repo>/gem.env. This suite is the proof that the REPL " +
      "renders REAL model output; a skip is NOT a pass.",
  );
}

describe.skipIf(GEMINI_API_KEY === undefined)("a real REPL turn against a real provider", () => {
  it("streams real tokens into the transcript and a real cost into the ticker", async () => {
    const gateway = await createModelGateway({
      apiKeys: { google: GEMINI_API_KEY! },
      preferredProvider: "google",
      allowedProviders: ["google"],
      models: { executor: LIVE_MODEL },
    });

    const store = new MemoryStore();
    const out: string[] = [];
    const costs: number[] = [];

    // The seat that answers this turn, streamed straight from the gateway and shaped
    // into the orchestrator's own event vocabulary — the same events index.ts renders.
    const engine = new ReplEngine({
      theme: createTheme("none"),
      config: DEFAULT_CONFIG,
      store,
      companyId: "cmp_live",
      write: (line) => void out.push(line),
      exit: () => {
        throw new Error("the live turn must not exit");
      },
      runner: ({ objective, signal }) =>
        (async function* (): AsyncGenerator<OrcEvent> {
          const at = new Date().toISOString();
          const runId = "run_live";
          yield { kind: "run_start", runId, at, run: { objective } };
          yield { kind: "step_start", runId, at, step: { id: "s1", title: objective, agentRole: "eng-ai-engineer" } };

          let text = "";
          let costCents = 0;
          for await (const event of gateway.stream({
            role: "executor",
            signal,
            messages: [{ role: "user", content: objective }],
            maxTokens: 128,
          })) {
            if (event.type === "token") text += event.content;
            if (event.type === "usage") costCents = event.costCents;
          }
          costs.push(costCents);

          yield { kind: "step_output", runId, at, step: { id: "s1" }, detail: text.trim() };
          yield {
            kind: "step_end",
            runId,
            at,
            step: { id: "s1", title: objective, agentRole: "eng-ai-engineer", status: "completed", costCents },
          };
          yield { kind: "run_done", runId, at, run: { status: "completed" } };
        })(),
    });

    await engine.submit("Reply with exactly: PONG-7423");

    const transcript = engine.transcript.join("\n");
    expect(transcript).toContain("PONG-7423");
    expect(transcript).not.toMatch(/^Trent proxy response/m);
    expect(transcript).not.toContain("I've analyzed");

    expect(costs).toHaveLength(1);
    expect(Number.isInteger(costs[0])).toBe(true);
    expect(engine.budget.spentCents).toBe(costs[0]);
    expect(engine.budget.render(createTheme("none"))).toContain(formatCents(costs[0]!));

    // The key must never reach the transcript or the terminal.
    expect(transcript).not.toContain(GEMINI_API_KEY!);
    expect(out.join("\n")).not.toContain(GEMINI_API_KEY!);
  }, 120_000);
});
