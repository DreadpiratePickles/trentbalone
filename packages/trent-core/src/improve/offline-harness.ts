/**
 * Test-only: boots the orchestrator offline (mock providers, semantic-router stub, in-memory
 * store, NODE_ENV=production so the queue fallback cannot mask a double execution). Same pattern
 * as `../orchestrator/orchestrator.test.ts`; shared here so every improve test runs a REAL
 * multi-step orchestration rather than a hand-built event list.
 */

import type { OrcEvent, OrchestrationRunSnapshot, SeatChatRequest, SeatChatResponse } from "../orchestrator/types.js";

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
  "ORCHESTRATION_GOLDEN_CAPTURE",
  "ORCHESTRATION_GOLDENS_DIR",
  "SKILL_INJECTION_ENABLED",
] as const;

const saved: Record<string, string | undefined> = {};

export function imitateCompiledBinary(): void {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.NODE_ENV = "production";
}

export function restoreEnv(): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export type OfflineHarness = {
  companyId: string;
  objective: string;
  createCompletion: (...args: never[]) => unknown;
  executeSeatModelFn: (...args: never[]) => unknown;
};

export async function bootOffline(label: string): Promise<OfflineHarness> {
  const { applyStandaloneEnv, IN_MEMORY_DATABASE } = await import("../runtime/env.js");
  applyStandaloneEnv(IN_MEMORY_DATABASE);

  const { store } = await import("@/lib/store");
  const { createEvalExecuteSeatModel, createEvalMockCompletion, pickIntegrationOrchestrationObjectives } =
    await import("@/lib/eval-mock-providers");
  const { buildOrchestrationGoldenObjectives } = await import("@/lib/orchestration-eval");
  const { setSemanticRouterEmbedderForTests } = await import("@/lib/semantic-router");
  setSemanticRouterEmbedderForTests(async (texts: string[]) => texts.map(() => Array(384).fill(0.1)));

  const objective = pickIntegrationOrchestrationObjectives(buildOrchestrationGoldenObjectives())[0]!.objective;
  const company = await store.createCompany({ name: label, brief: { vision: "improve loop test" } });
  return {
    companyId: company.id,
    objective,
    createCompletion: createEvalMockCompletion({}) as unknown as (...args: never[]) => unknown,
    executeSeatModelFn: createEvalExecuteSeatModel() as unknown as (...args: never[]) => unknown,
  };
}

export async function newCompany(name: string): Promise<string> {
  const { store } = await import("@/lib/store");
  const company = await store.createCompany({ name, brief: { vision: "improve loop test" } });
  return company.id;
}

export function finalTurn(summary: string): SeatChatResponse {
  return {
    choices: [{ message: { content: JSON.stringify({ toolCall: null, summary, findings: [], recommendations: [], workRequests: [] }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

export function userPrompt(request: SeatChatRequest): string {
  return request.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
}

export async function collect(
  handle: AsyncIterable<OrcEvent> & { result(): Promise<OrchestrationRunSnapshot> },
): Promise<{ events: OrcEvent[]; snapshot: OrchestrationRunSnapshot }> {
  const events: OrcEvent[] = [];
  for await (const event of handle) events.push(event);
  return { events, snapshot: await handle.result() };
}
