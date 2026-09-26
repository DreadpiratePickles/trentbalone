/**
 * [CF] What a solo run SENDS, as the runtime builds it (`createHeadlessRuntime` -> `runner-for-mode.ts` -> the
 * solo router -> the conversation's runner), for two council follow-ups:
 *   - C15.1: the gateway handler passes the thread's `platform` with the run (`gateway/agent-handler.ts`); it
 *     reaches `buildSystemPrompt`, whose LAST section is the platform hint, so the prefix before it is the same
 *     bytes on every platform and on none;
 *   - C14.1: on `provider: anthropic` every request offers the tools natively (`tools`, the adapters' own
 *     schemas), and on any other provider it offers none;
 *   - G: the runtime's own solo gateway (`lazyGateway`) streams, so a run shows `step_delta` frames before its
 *     `step_end` (C13 built the frames; the gateway every surface gets exposed `complete` only).
 * The orchestrator is a fake and the model a script: nothing reaches a provider.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigManager, SessionManager } from "@trent/core";
import { collectCompletion } from "@trent/core/model-gateway/complete.js";
import { ALIAS_ENV } from "@trent/core/model-gateway/providers.js";
import type { GatewayStreamEvent, GatewayStreamRequest, ModelGateway } from "@trent/core/model-gateway/types.js";
import type { OrcEvent, Orchestrator } from "@trent/core/orchestrator/index.js";
import { fakeAdapter, scriptedGateway, type ScriptedGateway } from "@trent/core/solo/fakes.test-helpers.js";
import { soloPlatformHint } from "@trent/core/solo/prompt.js";
import { FILE_OPS_INSTRUCTIONS } from "@trent/core/tools/file_ops/index.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { renderToolInstructions, type ToolSchema } from "@trent/core/tools/web/schemas.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import type { EgressHandle } from "../repl/tools.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "./headless.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
let home = "";
const savedHome = process.env.TRENT_HOME;
const savedAlias = process.env[ALIAS_ENV];
let n = 0;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cf-"));
  process.env.TRENT_HOME = home;
  delete process.env[ALIAS_ENV];
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  if (savedAlias === undefined) delete process.env[ALIAS_ENV];
  else process.env[ALIAS_ENV] = savedAlias;
  fs.rmSync(home, { recursive: true, force: true });
});
const runtimes: HeadlessRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.cleanup();
});

/** A toolset that renders its schemas the way every schema toolset does (`renderToolInstructions`). */
const LOOKUP: ToolSchema = {
  name: "weather_lookup",
  description: "The forecast for a city.",
  parameters: { type: "object", properties: { city: { type: "string", description: "The city." }, days: { type: "integer" } }, required: ["city"] },
};
const weather = (): TrentToolAdapter => ({ ...fakeAdapter({ name: "weather", tools: [LOOKUP.name] }), instructions: renderToolInstructions([LOOKUP]) });

async function build(options: { readonly provider: string; readonly model: string; readonly script: string[]; readonly modelGateway?: ModelGateway }): Promise<{ runtime: HeadlessRuntime; gateway: ScriptedGateway; profile: string }> {
  n += 1;
  const profile = `cf-${String(n)}`;
  const configManager = new ConfigManager({ profile });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.provider = options.provider as typeof config.provider;
  config.model = options.model;
  (config as unknown as { agent: Record<string, unknown> }).agent = { mode: "solo" };
  configManager.saveConfig(config);
  const createOrchestrator = (): Orchestrator =>
    ({ ensureCompany: async () => "cmp_cf", snapshot: async () => undefined, run: () => { throw new Error("the fleet must not run in solo mode"); }, approve: async () => true, reject: async () => true }) as unknown as Orchestrator;
  const egress: EgressHandle = { port: 1, url: "http://127.0.0.1:1", token: "t", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined };
  const gateway = scriptedGateway(options.script);
  // `file_ops` as the real adapter describes itself: prose, no rendered blocks (`tools/file_ops/adapter.ts`).
  const files = { ...fakeAdapter({ name: "file_ops", tools: ["read_file", "search_files"], result: () => ({ status: "completed", summary: "README: hello" }) }), instructions: FILE_OPS_INSTRUCTIONS };
  const runtime = await createHeadlessRuntime({
    configManager,
    workspace: REPO_ROOT,
    surface: "gateway",
    createOrchestrator,
    buildAdapters: () => [files, weather()],
    startEgress: async () => egress,
    probeDocker: async () => ({ daemon: false, imagePresent: false }),
    openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
    // G: with a fake MODEL gateway the runtime builds its own solo gateway over it (`lazyGateway`), as in production.
    solo: { ...(options.modelGateway === undefined ? { gateway } : { modelGateway: async () => options.modelGateway as ModelGateway }), audit: async () => undefined, windowTokens: 200_000 },
  });
  runtimes.push(runtime);
  return { runtime, gateway, profile };
}

async function drain(stream: AsyncIterable<OrcEvent>): Promise<OrcEvent[]> {
  const out: OrcEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const systemOf = (gateway: ScriptedGateway, call: number): string => gateway.requests[call]?.messages[0]?.content ?? "";
const HINT_HEADING = "## Where you are talking";

describe("[CF] C15.1: the thread's platform reaches the solo prompt", () => {
  it('a thread on telegram gets the Telegram hint as the last section; a run with none gets none; the prefix before it is byte-identical', async () => {
    const { runtime, gateway, profile } = await build({ provider: "google", model: "gemini-test", script: ["Hi.", "Hi again."] });
    const sessions = new SessionManager(new ConfigManager({ profile }));
    const thread = sessions.startSession("trent", "gemini-test", "google").id;

    // What the gateway handler passes for a solo thread (`agent-handler.ts`, C15): the session and the platform.
    await drain(runtime.run("hello", { trigger: "manual", session: thread, platform: "telegram" }));
    await drain(runtime.run("hello"));

    const onTelegram = systemOf(gateway, 0);
    const nowhere = systemOf(gateway, 1);
    expect(onTelegram).toContain("You are talking over Telegram; keep replies short");
    expect(nowhere).not.toContain(HINT_HEADING);
    expect(onTelegram).toBe(`${nowhere}\n\n${HINT_HEADING}\n${soloPlatformHint("telegram")}`);
  });
});

describe("[CF] C14.1: native tools on the request, on anthropic only", () => {
  it("an anthropic-routed solo request carries `tools`: each adapter's tools with their argument schemas", async () => {
    const { runtime, gateway } = await build({ provider: "anthropic", model: "claude-sonnet-4-6", script: ["Hello."] });
    await drain(runtime.run("hello"));

    const tools = gateway.requests[0]?.tools ?? [];
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("weather_lookup")).toEqual({
      name: "weather_lookup",
      description: "The forecast for a city.",
      parameters: { type: "object", properties: { city: { type: "string", description: "The city." }, days: { type: "integer" } }, required: ["city"] },
    });
    // `file_ops` teaches by example; its schemas are the MCP catalog's prose table (`mcp-server/schemas.ts`).
    expect(byName.get("read_file")?.parameters).toMatchObject({ type: "object", required: ["path"] });
    expect(byName.has("search_files")).toBe(true);
    // The solo text of the memory adapter: replace and remove, as the prompt teaches them.
    expect(JSON.stringify(byName.get("memory")?.parameters)).toContain('"enum":["add","replace","remove"]');
  });

  it("a local or other hosted route carries no `tools`, and the request is otherwise the same shape", async () => {
    const hosted = await build({ provider: "google", model: "gemini-test", script: ["Hello."] });
    await drain(hosted.runtime.run("hello"));
    expect(hosted.gateway.requests[0]).not.toHaveProperty("tools");

    process.env[ALIAS_ENV] = "ollama";
    try {
      const local = await build({ provider: "ollama", model: "qwen3.5:9b", script: ['{"answer": "Hello."}'] });
      await drain(local.runtime.run("hello"));
      expect(local.gateway.requests[0]).not.toHaveProperty("tools");
    } finally {
      delete process.env[ALIAS_ENV];
    }
  });
});

/** A model gateway as `createModelGateway()` returns one: `stream()` yields the reply's tokens, then usage and finish; `complete()` folds the same frames. */
function streamingModelGateway(tokens: readonly string[]): ModelGateway & { readonly streamed: GatewayStreamRequest[]; readonly completed: GatewayStreamRequest[] } {
  const streamed: GatewayStreamRequest[] = [];
  const completed: GatewayStreamRequest[] = [];
  async function* frames(): AsyncGenerator<GatewayStreamEvent> {
    for (const content of tokens) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      yield { type: "token", content, provider: "google", model: "gemini-test" };
    }
    yield { type: "usage", provider: "google", model: "gemini-test", modelTier: "sonnet", inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, costCents: 1, estimated: false, priced_as_default: false, unpriced: false };
    yield { type: "finish", reason: "stop", provider: "google", model: "gemini-test" };
  }
  return {
    streamed,
    completed,
    stream: (request) => (streamed.push(request), frames()),
    complete: (request) => (completed.push(request), collectCompletion(frames())),
    resolveRoute: () => ({ providers: ["google"], fallbackChain: ["google"], modelTier: "sonnet", explicitModel: "gemini-test", modelForProvider: () => "gemini-test" }),
    configuredProviders: () => ["google"],
    estimateCostCents: () => 0,
  };
}

describe("[CF] G: the runtime's solo gateway streams", () => {
  it("a solo run against a model gateway that streams yields step_delta frames, with the answer's text, before step_end", async () => {
    const model = streamingModelGateway(["Five ", "working ", "days, ", "from ", "Monday."]);
    const { runtime } = await build({ provider: "google", model: "gemini-test", script: [], modelGateway: model });

    const kinds = (await drain(runtime.run("How long is the job?"))).map((event) => ({ kind: event.kind, detail: event.detail }));
    const deltas = kinds.filter((event) => event.kind === "step_delta");
    const stepEnd = kinds.findIndex((event) => event.kind === "step_end");

    expect([model.streamed.length, model.completed.length]).toEqual([1, 0]);
    expect(deltas.length).toBeGreaterThan(0);
    expect(kinds.findIndex((event) => event.kind === "step_delta")).toBeLessThan(stepEnd);
    expect(deltas.map((event) => event.detail).join("")).toBe("Five working days, from Monday.");
    expect(kinds.at(-1)?.kind).toBe("run_done");
  });
});
