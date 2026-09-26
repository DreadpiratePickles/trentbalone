/**
 * [L1] LIVE: L0-4's five-case tool-call smoke (`doctor/checks/local-smoke.ts`: its cases, prompts and
 * judge) on a local model, with constrained output OFF and then ON, each through the seat port and the
 * real gateway, so the only difference between the two runs is `models.local.constrained_output`.
 * Thinking is off in both (`reasoning_effort: none`, the local seat default). Prints N/5 for each, and
 * per case the time to the first token of every model call and the whole case's time.
 *
 * Gated on TRENT_TEST_LIVE=1 and a reachable Ollama (`OLLAMA_BASE_URL`, default 127.0.0.1:11434) with
 * the model pulled (`TRENT_LIVE_LOCAL_MODEL`, default qwen3.5:9b). Every hosted key and the escalation
 * bridge are removed for the run, and the alias keeps every call on the local runtime: nothing leaves
 * the machine. Ten cases, up to twenty local calls; run it alone (the brief: live local proofs are serial).
 */
import { describe, expect, it } from "vitest";

import { readTurn, SMOKE_CASES, smokeMessages } from "../doctor/checks/local-smoke.js";
import { collectCompletion } from "../model-gateway/complete.js";
import { createModelGateway } from "../model-gateway/index.js";
import { LOCAL_MODEL_ENV } from "../model-gateway/local-runtime.js";
import { ALIAS_ENV, applyProviderAliasEnv } from "../model-gateway/providers.js";
import type { GatewayStreamEvent, GatewayStreamRequest, ModelGateway } from "../model-gateway/types.js";
import { createSeatChatPort } from "./seat-gateway-port.js";

const MODEL = process.env.TRENT_LIVE_LOCAL_MODEL?.trim() || "qwen3.5:9b";
const LIVE = process.env.TRENT_TEST_LIVE === "1";
if (!LIVE) console.error("[seat-constrained.live] SKIPPED: needs TRENT_TEST_LIVE=1 and a local Ollama with the model pulled. A skip is NOT a pass.");

const HOSTED = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "TRENT_ESCALATE_MODEL", "TRENT_ESCALATE_PROVIDER", "TRENT_ESCALATE_ON"];

interface CaseRow {
  readonly id: string;
  readonly pass: boolean;
  readonly reason?: string;
  readonly caseMs: number;
  readonly firstTokenMs: number[];
  readonly calls: number;
}

/** The gateway with each `complete()` timed to its first token (a stream drained into a completion). */
function timed(gateway: ModelGateway, firstTokens: number[]): ModelGateway {
  return {
    ...gateway,
    complete: (req: GatewayStreamRequest) => {
      const started = performance.now();
      let seen = false;
      async function* tap(): AsyncGenerator<GatewayStreamEvent> {
        for await (const event of gateway.stream(req)) {
          if (!seen && event.type === "token") {
            seen = true;
            firstTokens.push(Math.round(performance.now() - started));
          }
          yield event;
        }
      }
      return collectCompletion(tap());
    },
  };
}

async function runSmoke(gateway: ModelGateway, constrained: boolean): Promise<CaseRow[]> {
  process.env[LOCAL_MODEL_ENV.constrainedOutput] = String(constrained);
  const rows: CaseRow[] = [];
  for (const smoke of SMOKE_CASES) {
    const firstTokenMs: number[] = [];
    const port = createSeatChatPort(timed(gateway, firstTokenMs));
    const started = performance.now();
    let reason: string | undefined;
    try {
      const reply = await port({ model: MODEL, temperature: 0.2, response_format: { type: "json_object" }, messages: smokeMessages(smoke).map((m) => ({ role: m.role === "assistant" ? "user" : m.role, content: m.content })) });
      const turn = readTurn(reply.choices[0]?.message.content ?? "", smoke);
      reason = turn.kind === "invalid" ? turn.reason : smoke.judge(turn);
    } catch (error) {
      reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
    rows.push({ id: smoke.id, pass: reason === undefined, ...(reason === undefined ? {} : { reason }), caseMs: Math.round(performance.now() - started), firstTokenMs, calls: firstTokenMs.length });
  }
  return rows;
}

describe.skipIf(!LIVE)("[L1] LIVE: the five-case smoke, constrained output off vs on", () => {
  it(`${MODEL}: prints N/5 for each and the first-token times`, { timeout: 3_600_000 }, async () => {
    const saved = new Map<string, string | undefined>();
    for (const name of [...HOSTED, ALIAS_ENV, "OPENAI_BASE_URL", "OPENAI_API_KEY", LOCAL_MODEL_ENV.constrainedOutput, LOCAL_MODEL_ENV.reasoningEffort]) {
      saved.set(name, process.env[name]);
    }
    try {
      for (const name of HOSTED) delete process.env[name];
      applyProviderAliasEnv("ollama", MODEL);
      process.env[LOCAL_MODEL_ENV.reasoningEffort] = "none";
      const gateway = await createModelGateway({ retry: { attempts: 1 } });
      const off = await runSmoke(gateway, false);
      const on = await runSmoke(gateway, true);
      const score = (rows: CaseRow[]): number => rows.filter((row) => row.pass).length;
      console.log(JSON.stringify({ model: MODEL, reasoning_effort: "none", off: { score: `${score(off)}/5`, cases: off }, on: { score: `${score(on)}/5`, cases: on } }, null, 2));
      expect(off).toHaveLength(5);
      expect(on).toHaveLength(5);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
