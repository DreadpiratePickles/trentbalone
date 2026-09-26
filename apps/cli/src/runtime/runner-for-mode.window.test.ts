/**
 * [C12] A hosted model has a window too (council C12; `runner-for-mode.ts` `soloWindowTokens`).
 *
 * Before C12 only a LOCAL alias had one (the runtime's probe), so a hosted solo session compacted at S3's fixed
 * 64,000 characters whatever the model. Now a hosted model's window is `model_overrides.<model>.context_window`
 * when the profile names one, else the gateway's own table (`model-gateway/pricing.ts` `contextWindowFor`), and S3's
 * threshold follows it (half the window, in characters). A model neither knows keeps the fixed 64,000.
 * The model is scripted and the orchestrator is a fake: nothing reaches a provider.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigManager, SessionManager } from "@trent/core";
import { ALIAS_ENV } from "@trent/core/model-gateway/providers.js";
import type { OrcEvent, Orchestrator } from "@trent/core/orchestrator/index.js";
import { fakeAdapter } from "@trent/core/solo/fakes.test-helpers.js";
import { SUMMARY_REPLY, filler, routedGateway, type RoutedGateway } from "@trent/core/solo/fakes-s3.test-helpers.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import type { EgressHandle } from "../repl/tools.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "./headless.js";
import { soloWindowTokens } from "./runner-for-mode.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
let home = "";
const savedHome = process.env.TRENT_HOME;
const savedAlias = process.env[ALIAS_ENV];
let n = 0;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-c12-window-"));
  process.env.TRENT_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});
const runtimes: HeadlessRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.cleanup();
  if (savedAlias === undefined) delete process.env[ALIAS_ENV];
  else process.env[ALIAS_ENV] = savedAlias;
});

const TURNS = 8;
const TURN_CHARS = 3_750;

async function build(model: string, overrides: Record<string, { context_window: number }> = {}): Promise<{ runtime: HeadlessRuntime; gateway: RoutedGateway; session: string }> {
  n += 1;
  const configManager = new ConfigManager({ profile: `c12-window-${String(n)}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.provider = "google";
  config.model = model;
  (config as unknown as { model_overrides: Record<string, unknown> }).model_overrides = overrides;
  (config as unknown as { agent: Record<string, unknown> }).agent = { mode: "solo" };
  configManager.saveConfig(config);
  delete process.env[ALIAS_ENV]; // hosted: no local alias
  const createOrchestrator = (): Orchestrator =>
    ({ ensureCompany: async () => "cmp_c12", snapshot: async () => undefined, run: () => { throw new Error("the fleet must not run in solo mode"); }, approve: async () => true, reject: async () => true }) as unknown as Orchestrator;
  const egress: EgressHandle = { port: 1, url: "http://127.0.0.1:1", token: "t", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined };
  const answers = Array.from({ length: TURNS }, (_, i) => filler(`ANSWER-${String(i + 1)}`, TURN_CHARS));
  const gateway = routedGateway(answers, { flush: ["[]"], summary: [SUMMARY_REPLY] });
  const runtime = await createHeadlessRuntime({
    configManager,
    workspace: REPO_ROOT,
    surface: "repl",
    createOrchestrator,
    buildAdapters: () => [fakeAdapter({ name: "file_ops", tools: ["read_file"] })],
    startEgress: async () => egress,
    probeDocker: async () => ({ daemon: false, imagePresent: false }),
    openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
    // No `windowTokens` seam: the runtime works the window out, which is what this file tests.
    solo: { gateway, audit: async () => undefined },
  });
  runtimes.push(runtime);
  const session = new SessionManager(configManager).startSession("trent", model, "google").id;
  return { runtime, gateway, session };
}

async function drain(stream: AsyncIterable<OrcEvent>): Promise<OrcEvent[]> {
  const out: OrcEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

/** Eight turns of 7,500 characters each (question and answer): 52,500 stored before the eighth. */
async function talk(b: { runtime: HeadlessRuntime; session: string }): Promise<string[]> {
  const ends: string[] = [];
  for (let i = 1; i <= TURNS; i += 1) ends.push((await drain(b.runtime.run(filler(`QUESTION-${String(i)}`, TURN_CHARS), { session: b.session }))).at(-1)?.kind ?? "");
  return ends;
}

describe("[C12] the solo window on a hosted provider", () => {
  it("is the profile's model_overrides window first, then the gateway's table; unknown stays unknown; local is the probe's", async () => {
    expect(await soloWindowTokens("gemini-3.5-flash-lite", {})).toBe(1_000_000);
    expect(await soloWindowTokens("claude-sonnet-4-6", {})).toBe(200_000);
    expect(await soloWindowTokens("deepseek-chat", { [ALIAS_ENV]: "deepseek" })).toBe(128_000);
    expect(await soloWindowTokens("gemini-3.5-flash-lite", {}, undefined, { "gemini-3.5-flash-lite": { context_window: 500_000 } })).toBe(500_000);
    expect(await soloWindowTokens("my-finetune", {}, undefined, { "my-finetune": { context_window: 32_000 } })).toBe(32_000);
    expect(await soloWindowTokens("gemini-test", {})).toBeUndefined();
    const refused = async (): Promise<Response> => { throw new Error("no server in this test"); };
    expect(await soloWindowTokens("qwen3.5:9b", { [ALIAS_ENV]: "ollama", TRENT_LOCAL_CONTEXT_TOKENS: "16384" }, refused, { "qwen3.5:9b": { context_window: 999 } })).toBe(16384);
  });

  it("S3's threshold follows it: a 24,000-token window compacts at 48,000 characters, before the eighth turn", async () => {
    const b = await build("gemini-test", { "gemini-test": { context_window: 24_000 } });
    const ends = await talk(b);
    expect(ends).toEqual(Array.from({ length: TURNS }, () => "run_done"));
    expect(b.gateway.kinds.filter((kind) => kind === "summary")).toHaveLength(1);
    expect(b.gateway.kinds.slice(-2)).toEqual(["summary", "turn"]);
  });

  it("a model with no known window keeps the fixed 64,000 characters: the same eight turns compact nothing", async () => {
    const b = await build("gemini-test");
    expect(await talk(b)).toEqual(Array.from({ length: TURNS }, () => "run_done"));
    expect(b.gateway.kinds).toEqual(Array.from({ length: TURNS }, () => "turn"));
  });
});
