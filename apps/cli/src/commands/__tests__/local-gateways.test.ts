/**
 * [L1] `trent heartbeat` and `trent improve` build their own model gateways, outside the headless
 * runtime that writes `models.local` into the gateway's env bridge. L0-2 (docs/sessions/
 * 2026-09-26-l0-2-local-client.md, open item 3): they got the defaults, not the configured values.
 * Each construction site now hands the block to `createModelGateway({ local })`, which writes the same
 * bridge (`model-gateway/local-runtime.ts` `applyLocalModelEnv`): budgets, the in-flight cap,
 * constrained output and the local seat effort.
 *
 * The gateway module is replaced by a recorder; nothing here reaches a model or a socket.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";

const { built } = vi.hoisted(() => ({ built: [] as Array<Record<string, unknown>> }));

vi.mock("@trent/core/model-gateway/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createModelGateway: async (config: Record<string, unknown>) => {
      built.push(config);
      return {
        complete: async () => ({ text: "{}", provider: "openai", model: "m", modelTier: "sonnet", inputTokens: 1, outputTokens: 1, costCents: 0, estimated: false, priced_as_default: false, finishReason: "stop" }),
        stream: async function* () {},
        resolveRoute: () => ({ providers: ["openai"], fallbackChain: ["openai"], modelTier: "sonnet", explicitModel: "m", modelForProvider: () => "m" }),
        configuredProviders: () => ["openai"],
        estimateCostCents: () => 0,
      };
    },
  };
});

vi.mock("@trent/core/fleet-memory/index.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  consolidateMemory: async () => ({ blocks: [] }),
}));

import { liveModel, loopConfig } from "../improve-sweep.js";
import { openHeartbeat } from "../groups/heartbeat.js";

const LOCAL = { ttft_seconds: 900, max_in_flight: 2, constrained_output: false, reasoning_effort: "low" };

let home = "";
const savedHome = process.env.TRENT_HOME;
beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-local-gateways-"));
  process.env.TRENT_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});
beforeEach(() => {
  built.length = 0;
});

function localProfile(): ConfigManager {
  const configManager = new ConfigManager({ profile: `gw-${Math.random().toString(36).slice(2, 8)}` });
  const config = configManager.loadConfig();
  config.provider = "ollama";
  config.model = "qwen3.5:9b";
  config.models = { ...config.models, local: LOCAL } as typeof config.models;
  (config.improve as { judge_model?: string }).judge_model = "qwen3.5:4b";
  configManager.saveConfig(config);
  return configManager;
}

describe("[L1] the gateways heartbeat and improve build honour models.local", () => {
  it("`trent improve --live`: the executor's gateway and the judge's both carry the block", async () => {
    const configManager = localProfile();
    const ctx = { config: () => configManager };
    await liveModel(ctx, loopConfig(ctx));
    expect(built).toHaveLength(2);
    for (const config of built) expect(config.local).toEqual(LOCAL);
  });

  it("the heartbeat's memory consolidation gateway carries it", async () => {
    const configManager = localProfile();
    const config = configManager.loadConfig();
    const runtime = { companyId: "cmp_local", store: {}, run: () => { throw new Error("not in this test"); } };
    const { loop } = openHeartbeat({ configManager, config, runtime: runtime as never, buildManager: () => { throw new Error("no delivery here"); }, log: () => undefined });
    await (loop as unknown as { deps: { consolidate: () => Promise<unknown> } }).deps.consolidate();
    expect(built).toHaveLength(1);
    expect(built[0]!.local).toEqual(LOCAL);
  });
});
