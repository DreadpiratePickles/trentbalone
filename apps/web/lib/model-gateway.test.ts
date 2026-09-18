import { describe, expect, it } from "vitest";
import {
  buildFallbackChain,
  clearModelGatewayCache,
  estimateModelCostCents,
  executeSeatModel,
  routeModel,
  semanticCacheKey,
} from "@/lib/model-gateway";
import { resolveModelName } from "@/lib/ai-client";
import type { ModelPolicySnapshot } from "@/lib/model-policy";

describe("model gateway policy", () => {
  it("routes by task tier, reversibility, and cost while producing fallback chains", () => {
    expect(routeModel({ seat: "support", taskTier: "triage", reversibility: "reversible" }).modelTier).toBe("haiku");
    expect(routeModel({ seat: "finance", taskTier: "synthesis", reversibility: "irreversible" }).modelTier).toBe("opus");
    expect(buildFallbackChain("anthropic")).toEqual(["anthropic", "openai", "google", "mistral", "openrouter"]);
    expect(estimateModelCostCents({ modelTier: "sonnet", inputTokens: 1000, outputTokens: 500 })).toBeGreaterThan(0);
  });

  it("creates stable semantic cache keys without raw prompt leakage", () => {
    const key = semanticCacheKey({ companyId: "co_1", taskType: "seo", prompt: "secret customer@example.com" });

    expect(key).toMatch(/^semcache_/);
    expect(key).not.toContain("customer@example.com");
  });

  it("respects allowed provider, quality, latency, and region policy", () => {
    const cheap = routeModel({
      seat: "support",
      taskTier: "triage",
      reversibility: "reversible",
      qualityPolicy: "cheap",
      allowedProviders: ["openrouter", "openai"],
    });

    expect(cheap.provider).toBe("openrouter");
    expect(cheap.fallbackChain).toEqual(["openrouter", "openai"]);

    const eu = routeModel({
      seat: "analyst",
      taskTier: "standard",
      reversibility: "reversible",
      region: "eu",
      allowedProviders: ["anthropic", "mistral"],
    });

    expect(eu.provider).toBe("mistral");
  });

  it("executes a seat model call through an injected OpenAI-compatible completion function", async () => {
    const createChatCompletion = async () => ({
      choices: [{ message: { content: JSON.stringify({ summary: "Budget looks safe", findings: ["under cap"] }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const result = await executeSeatModel({
      companyId: "co_1",
      modelPolicy: {
        planner: "p",
        specialist: "s",
        critic: "c",
        workbench: { planner: "wp", executor: "we", apply: "wa", critic: "wc" },
        routing: { preferredProvider: "openai", allowedProviders: ["openai"] },
      },
      subtask: {
        id: "sub_1",
        seat: "finance",
        objective: "Review budget",
        outputContractId: "finance.v1",
        toolGuidance: [],
        boundaries: [],
        input: {},
        contextBundle: {},
        classification: { type: "finance", complexity: "standard", reversibility: "reversible" },
        budgetCents: 10,
      },
      systemPrompt: "finance system prompt",
      createChatCompletion,
    });

    expect(result).toMatchObject({
      model: resolveModelName("opus", "openai"),
      tokens: 150,
      fallback: false,
      output: { summary: "Budget looks safe", findings: ["under cap"] },
    });
    expect(result.costCents).toBeGreaterThanOrEqual(0);
  });

  it("includes tool-specific instructions in the seat model prompt", async () => {
    let userPrompt = "";
    const createChatCompletion = async (input: { messages: Array<{ role: string; content: string }> }) => {
      userPrompt = input.messages.find((message) => message.role === "user")?.content ?? "";
      return {
        choices: [{ message: { content: JSON.stringify({ summary: "ready" }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      };
    };

    await executeSeatModel({
      companyId: "co_1",
      modelPolicy: {
        planner: "p",
        specialist: "s",
        critic: "c",
        workbench: { planner: "wp", executor: "we", apply: "wa", critic: "wc" },
        routing: { preferredProvider: "openai", allowedProviders: ["openai"] },
      },
      subtask: {
        id: "sub_workbench",
        seat: "engineer",
        objective: "Use Workbench",
        outputContractId: "engineer.v1",
        toolGuidance: ["workbench:session"],
        boundaries: [],
        input: {},
        contextBundle: {},
        classification: { type: "engineer", complexity: "standard", reversibility: "reversible" },
        budgetCents: 10,
      },
      systemPrompt: "engineer system prompt",
      toolLoopContext: {
        step: 1,
        maxSteps: 15,
        toolHistory: [],
        availableTools: ["workbench:session"],
        toolInstructions: [
          "Use toolCall.name \"workbench:session\" and a JSON action with \"writeFiles\" and \"command\".",
        ],
      },
      createChatCompletion,
    });

    expect(userPrompt).toContain("Tool-specific instructions");
    expect(userPrompt).toContain("workbench:session");
    expect(userPrompt).toContain('"writeFiles"');
    expect(userPrompt).toContain('"command"');
  });

  it("returns an explicit configuration error when OpenAI is not configured", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    const result = await executeSeatModel({
      companyId: "co_1",
      subtask: {
        id: "sub_1",
        seat: "analyst",
        objective: "Summarize metrics",
        outputContractId: "analyst.v1",
        toolGuidance: [],
        boundaries: [],
        input: {},
        contextBundle: {},
        classification: { type: "analysis", complexity: "standard", reversibility: "reversible" },
        budgetCents: 10,
      },
      systemPrompt: "analyst system prompt",
    });

    expect(result).toMatchObject({
      model: "not-configured",
      fallback: true,
      tokens: 0,
      costCents: 0,
      error: expect.stringContaining("No model provider API keys are configured"),
    });
    if (saved) process.env.OPENAI_API_KEY = saved;
  });

  it("falls through to the next provider when the primary errors and still completes", async () => {
    clearModelGatewayCache();
    let calls = 0;
    const policy: ModelPolicySnapshot = {
      planner: "p",
      specialist: "s",
      critic: "c",
      workbench: { planner: "wp", executor: "we", apply: "wa", critic: "wc" },
      routing: {
        preferredProvider: "openai",
        allowedProviders: ["openai", "anthropic"],
        qualityPolicy: "balanced",
      },
    };
    const createChatCompletion = async () => {
      calls++;
      if (calls === 1) throw new Error("openai outage");
      return {
        choices: [{ message: { content: JSON.stringify({ summary: "recovered via fallback" }) } }],
        usage: { prompt_tokens: 80, completion_tokens: 40, total_tokens: 120 },
      };
    };

    const result = await executeSeatModel({
      companyId: "co_1",
      modelPolicy: policy,
      subtask: {
        id: "sub_failover",
        seat: "growth",
        objective: "Draft campaign",
        outputContractId: "growth.v1",
        toolGuidance: [],
        boundaries: [],
        input: {},
        contextBundle: {},
        classification: { type: "growth", complexity: "standard", reversibility: "reversible" },
        budgetCents: 10,
      },
      systemPrompt: "growth system prompt",
      createChatCompletion,
    });

    expect(calls).toBe(2);
    expect(result.fallback).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ summary: "recovered via fallback" });
    expect(result.tokens).toBe(120);
  });

  it("switches provider from model policy without code edits", async () => {
    clearModelGatewayCache();
    const models: string[] = [];
    const subtask = {
      id: "sub_policy",
      seat: "analyst" as const,
      objective: "Summarize metrics",
      outputContractId: "analyst.v1",
      toolGuidance: [],
      boundaries: [],
      input: {},
      contextBundle: {},
      classification: { type: "analysis", complexity: "standard" as const, reversibility: "reversible" as const },
      budgetCents: 10,
    };
    const createChatCompletion = async (input: { model: string }) => {
      models.push(input.model);
      return {
        choices: [{ message: { content: JSON.stringify({ summary: "ok" }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
    };

    await executeSeatModel({
      companyId: "co_1",
      modelPolicy: {
        planner: "p",
        specialist: "s",
        critic: "c",
        workbench: { planner: "wp", executor: "we", apply: "wa", critic: "wc" },
        routing: { preferredProvider: "anthropic", allowedProviders: ["anthropic", "openai"] },
      },
      subtask,
      systemPrompt: "analyst",
      createChatCompletion,
    });
    expect(models[0]).toBe(resolveModelName("sonnet", "anthropic"));

    models.length = 0;
    await executeSeatModel({
      companyId: "co_2",
      modelPolicy: {
        planner: "p",
        specialist: "s",
        critic: "c",
        workbench: { planner: "wp", executor: "we", apply: "wa", critic: "wc" },
        routing: { preferredProvider: "openai", allowedProviders: ["openai", "anthropic"] },
      },
      subtask: { ...subtask, id: "sub_policy_openai", objective: "Summarize revenue" },
      systemPrompt: "analyst",
      createChatCompletion,
    });
    expect(models[0]).toBe(resolveModelName("sonnet", "openai"));
  });

  it("uses the semantic cache for repeated read-only analyst work", async () => {
    clearModelGatewayCache();
    let calls = 0;
    const createChatCompletion = async () => {
      calls++;
      return {
        choices: [{ message: { content: JSON.stringify({ summary: `cached ${calls}` }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };
    };
    const subtask = {
      id: "sub_cache",
      seat: "analyst" as const,
      objective: "Summarize activation metrics",
      outputContractId: "analyst.v1",
      toolGuidance: [],
      boundaries: [],
      input: {},
      contextBundle: {},
      classification: { type: "analysis", complexity: "standard" as const, reversibility: "reversible" as const },
      budgetCents: 10,
    };

    const first = await executeSeatModel({ companyId: "co_1", subtask, systemPrompt: "analyst", createChatCompletion });
    const second = await executeSeatModel({ companyId: "co_1", subtask, systemPrompt: "analyst", createChatCompletion });

    expect(calls).toBe(1);
    expect(second.output).toEqual(first.output);
    expect(second.fallback).toBe(false);
  });

  it("does not serve a cached analyst result to a different dynamic prompt", async () => {
    // `dynamicPrompt` carries the fleet-memory prelude and, now, the session's conversation. Two
    // runs with the same objective and different history are different questions; a key built
    // from the objective alone answers the second one with the first one's result.
    clearModelGatewayCache();
    let calls = 0;
    const createChatCompletion = async () => {
      calls++;
      return {
        choices: [{ message: { content: JSON.stringify({ summary: `answer ${calls}` }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      };
    };
    const subtask = {
      id: "sub_history",
      seat: "analyst" as const,
      objective: "Summarize activation metrics",
      outputContractId: "analyst.v1",
      toolGuidance: [],
      boundaries: [],
      input: {},
      contextBundle: {},
      classification: { type: "analysis", complexity: "standard" as const, reversibility: "reversible" as const },
      budgetCents: 10,
    };

    const first = await executeSeatModel({
      companyId: "co_1",
      subtask,
      systemPrompt: "analyst",
      dynamicPrompt: "## Conversation so far\nuser: which region?\n\nassistant: EMEA.",
      createChatCompletion,
    });
    const second = await executeSeatModel({
      companyId: "co_1",
      subtask,
      systemPrompt: "analyst",
      dynamicPrompt: "## Conversation so far\nuser: which region?\n\nassistant: APAC.",
      createChatCompletion,
    });

    expect(calls).toBe(2);
    expect(second.output).not.toEqual(first.output);
  });
});
