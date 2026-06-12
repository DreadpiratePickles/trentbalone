import { afterEach, describe, expect, it } from "vitest";
import type { ModelPolicySnapshot } from "@/lib/model-policy";
import type { ModelProvider } from "@/lib/model-gateway";
import { resolveModelName } from "@/lib/ai-client";
import { routeWorkbenchStream } from "@/lib/model-gateway";
import {
  collectStreamArtifactWithMeta,
  setWorkbenchStreamOverrides,
  streamArtifactWithFallback,
  type WorkbenchStreamProviderFn,
} from "@/lib/workbench-llm-client";
import type { ArtifactStreamToken } from "@/lib/workbench-agent-types";

const BASE_POLICY: ModelPolicySnapshot = {
  planner: "p",
  specialist: "s",
  critic: "c",
  workbench: {
    planner: "gpt-5.2",
    executor: "gpt-5.2-codex",
    apply: "gpt-4.1-nano",
    critic: "gpt-5.2",
  },
  routing: {
    preferredProvider: "openai",
    allowedProviders: ["openai", "anthropic"],
    qualityPolicy: "best",
  },
};

const MESSAGES = [{ role: "system" as const, content: "build" }, { role: "user" as const, content: "app" }];

function makeStreamProvider(
  handler: (provider: ModelProvider, model: string) => AsyncGenerator<ArtifactStreamToken>,
): WorkbenchStreamProviderFn {
  return async function* (provider, model) {
    yield* handler(provider, model);
  };
}

describe("workbench streaming failover", () => {
  afterEach(() => {
    setWorkbenchStreamOverrides(undefined);
  });

  it("falls through to the next provider when the primary stream throws", async () => {
    const streamProvider = makeStreamProvider(async function* (provider, _model) {
      if (provider === "openai") throw new Error("openai outage");
      yield { type: "token", content: "<boltArtifact>" };
      yield { type: "finish", reason: "stop" };
      yield { type: "usage", inputTokens: 12, outputTokens: 6 };
    });

    const { tokens, fallback } = await collectStreamArtifactWithMeta(
      { messages: MESSAGES },
      { policy: BASE_POLICY, streamProvider },
    );

    expect(fallback).toBe(true);
    expect(tokens.some((token) => token.type === "token")).toBe(true);
    expect(tokens.find((token) => token.type === "finish")).toMatchObject({ reason: "stop" });
  });

  it("routes an Anthropic EXECUTOR_MODEL through the Anthropic streaming path", async () => {
    const anthropicExecutor = "claude-sonnet-4-6";
    const policy: ModelPolicySnapshot = {
      ...BASE_POLICY,
      workbench: { ...BASE_POLICY.workbench, executor: anthropicExecutor },
      routing: {
        preferredProvider: "anthropic",
        allowedProviders: ["anthropic", "openai"],
        qualityPolicy: "best",
      },
    };

    const seen: Array<{ provider: ModelProvider; model: string }> = [];
    const streamProvider: WorkbenchStreamProviderFn = async function* (provider, model) {
      seen.push({ provider, model });
      yield { type: "token", content: "hello" };
      yield { type: "finish", reason: "stop" };
    };

    const tokens: ArtifactStreamToken[] = [];
    for await (const token of streamArtifactWithFallback({ messages: MESSAGES }, { policy, streamProvider })) {
      tokens.push(token);
    }

    expect(seen[0]).toEqual({ provider: "anthropic", model: anthropicExecutor });
    expect(tokens.some((token) => token.type === "token")).toBe(true);
  });

  it("uses resolveModelName for fallback providers that do not match the explicit executor", async () => {
    const policy: ModelPolicySnapshot = {
      ...BASE_POLICY,
      workbench: { ...BASE_POLICY.workbench, executor: "claude-sonnet-4-6" },
      routing: {
        preferredProvider: "anthropic",
        allowedProviders: ["anthropic", "openai"],
        qualityPolicy: "best",
      },
    };

    const seen: Array<{ provider: ModelProvider; model: string }> = [];
    const streamProvider = makeStreamProvider(async function* (provider, model) {
      seen.push({ provider, model });
      if (provider === "anthropic") throw new Error("anthropic outage");
      yield { type: "token", content: "recovered" };
      yield { type: "finish", reason: "stop" };
    });

    const { fallback } = await collectStreamArtifactWithMeta(
      { messages: MESSAGES },
      { policy, streamProvider },
    );

    expect(fallback).toBe(true);
    expect(seen[1]).toEqual({
      provider: "openai",
      model: resolveModelName("opus", "openai"),
    });
  });

  it("honors env token caps for executor streams", async () => {
    const seenMaxTokens: number[] = [];
    const saved = process.env.WORKBENCH_MAX_TOKENS_EXECUTOR;
    process.env.WORKBENCH_MAX_TOKENS_EXECUTOR = "900";
    const streamProvider: WorkbenchStreamProviderFn = async function* (_provider, _model, _input, maxTokens) {
      seenMaxTokens.push(maxTokens);
      yield { type: "finish", reason: "stop" };
    };

    try {
      const tokens: ArtifactStreamToken[] = [];
      for await (const token of streamArtifactWithFallback({ messages: MESSAGES }, { policy: BASE_POLICY, streamProvider })) {
        tokens.push(token);
      }
    } finally {
      if (saved) process.env.WORKBENCH_MAX_TOKENS_EXECUTOR = saved;
      else delete process.env.WORKBENCH_MAX_TOKENS_EXECUTOR;
    }

    expect(seenMaxTokens[0]).toBe(900);
  });

  it("exposes a configured provider chain from routeWorkbenchStream", () => {
    const savedOpenAi = process.env.OPENAI_API_KEY;
    const savedAnthropic = process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "test-openai";
    process.env.ANTHROPIC_API_KEY = "test-anthropic";

    const route = routeWorkbenchStream("executor", BASE_POLICY);
    expect(route.fallbackChain).toEqual(["openai", "anthropic"]);
    expect(route.providers).toEqual(["openai", "anthropic"]);
    expect(route.modelForProvider("openai")).toBe(BASE_POLICY.workbench.executor);

    if (savedOpenAi) process.env.OPENAI_API_KEY = savedOpenAi;
    else delete process.env.OPENAI_API_KEY;
    if (savedAnthropic) process.env.ANTHROPIC_API_KEY = savedAnthropic;
    else delete process.env.ANTHROPIC_API_KEY;
  });
});
