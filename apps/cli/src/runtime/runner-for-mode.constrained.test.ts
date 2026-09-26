/**
 * [C11] What a solo run SENDS, as the runtime builds it (`createHeadlessRuntime` -> `runner-for-mode.ts`):
 *   - under a local alias every turn carries the solo envelope as `response_format` (json_schema, the tool
 *     names as an enum: `soloResponseFormat`), because a 9B writes its own shape otherwise (council C11;
 *     the L1 seat smoke went 2/5 -> 4/5 constrained); a delegated child gets it too, over its own tools;
 *   - on a hosted provider nothing changes: the `<tool_call>` text protocol, no `response_format`;
 *   - `models.local.constrained_output: false` turns it off, the seats' own switch (L1);
 *   - `agent.solo.max_tool_calls` reaches the runner and is its cap.
 * The alias variable is the one the orchestrator's constructor writes (`applyModelEnv`), set here because
 * the orchestrator is a fake. The model is scripted: nothing reaches a provider or a local server.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigManager } from "@trent/core";
import { LOCAL_MODEL_ENV } from "@trent/core/model-gateway/local-runtime.js";
import { ALIAS_ENV } from "@trent/core/model-gateway/providers.js";
import type { OrcEvent, Orchestrator } from "@trent/core/orchestrator/index.js";
import { fakeAdapter, scriptedGateway, type ScriptedGateway } from "@trent/core/solo/fakes.test-helpers.js";
import type { SoloResponseFormat } from "@trent/core/solo/types.js";
import { SOLO_ENVELOPE_INSTRUCTION } from "@trent/core/solo/turn-settings.js";
import { createDelegateAdapter } from "@trent/core/tools/delegate/index.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import type { EgressHandle } from "../repl/tools.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "./headless.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const ENV_NAMES = [ALIAS_ENV, ...Object.values(LOCAL_MODEL_ENV)];
let home = "";
const savedHome = process.env.TRENT_HOME;
const savedEnv = new Map<string, string | undefined>();
let n = 0;

beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-c11-"));
  process.env.TRENT_HOME = home;
  for (const name of ENV_NAMES) savedEnv.set(name, process.env[name]);
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});
const runtimes: HeadlessRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.cleanup();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

interface BuildOptions {
  readonly local: boolean;
  readonly script: string[];
  readonly adapters?: (profileDir: string) => TrentToolAdapter[];
  readonly solo?: Record<string, unknown>;
  readonly modelsLocal?: Record<string, unknown>;
}

async function build(options: BuildOptions): Promise<{ runtime: HeadlessRuntime; gateway: ScriptedGateway }> {
  n += 1;
  const configManager = new ConfigManager({ profile: `c11-${String(n)}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.provider = options.local ? "ollama" : "google";
  config.model = options.local ? "qwen3.5:9b" : "gemini-test";
  if (options.modelsLocal !== undefined) (config as unknown as { models: Record<string, unknown> }).models = { ...(config as unknown as { models?: Record<string, unknown> }).models, local: options.modelsLocal };
  (config as unknown as { agent: Record<string, unknown> }).agent = { mode: "solo", ...(options.solo === undefined ? {} : { solo: options.solo }) };
  configManager.saveConfig(config);
  // What the real orchestrator's constructor writes for this provider (`applyModelEnv`); the fake writes nothing.
  if (options.local) process.env[ALIAS_ENV] = "ollama";
  else delete process.env[ALIAS_ENV];
  const createOrchestrator = (): Orchestrator =>
    ({ ensureCompany: async () => "cmp_c11", snapshot: async () => undefined, run: () => { throw new Error("the fleet must not run in solo mode"); }, approve: async () => true, reject: async () => true }) as unknown as Orchestrator;
  const egress: EgressHandle = { port: 1, url: "http://127.0.0.1:1", token: "t", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined };
  const gateway = scriptedGateway(options.script);
  const profileDir = configManager.getProfileDir();
  const files = fakeAdapter({ name: "file_ops", tools: ["read_file", "search_files"], result: () => ({ status: "completed", summary: "README: hello" }) });
  const runtime = await createHeadlessRuntime({
    configManager,
    workspace: REPO_ROOT,
    surface: "repl",
    createOrchestrator,
    buildAdapters: () => options.adapters?.(profileDir) ?? [files],
    startEgress: async () => egress,
    probeDocker: async () => ({ daemon: false, imagePresent: false }),
    openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
    // The window without asking a server: this test never opens a socket.
    solo: { gateway, audit: async () => undefined, windowTokens: 32_768 },
  });
  runtimes.push(runtime);
  return { runtime, gateway };
}

async function drain(stream: AsyncIterable<OrcEvent>): Promise<OrcEvent[]> {
  const out: OrcEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

type JsonSchemaFormat = Extract<SoloResponseFormat, { type: "json_schema" }>;
/** The tool enum of the envelope's call alternative (`soloEnvelopeFormat`: an `anyOf`, the calls first). */
const toolEnum = (format: SoloResponseFormat | undefined): string[] => {
  const schema = (format as JsonSchemaFormat | undefined)?.json_schema.schema as { anyOf?: Array<{ properties?: { tool_calls?: { items?: { properties?: { name?: { enum?: string[] } } } } } }> } | undefined;
  return schema?.anyOf?.[0]?.properties?.tool_calls?.items?.properties?.name?.enum ?? [];
};

const envelope = (name: string, args: Record<string, unknown>): string => JSON.stringify({ tool_calls: [{ name, arguments: args }] });
const READ = envelope("read_file", { path: "README.md" });

describe("[C11] a solo request under a local alias carries the solo envelope as response_format", () => {
  it("every model call of the turn: json_schema, named solo_turn, the tools' names as the enum; the envelope is read back", async () => {
    const { runtime, gateway } = await build({ local: true, script: [READ, JSON.stringify({ answer: "The README says hello." })] });
    const events = await drain(runtime.run("What does the README say?"));

    expect(gateway.requests[0]?.responseFormat).toMatchObject({ type: "json_schema", json_schema: { name: "solo_turn" } });
    expect(events.at(-1)).toMatchObject({ kind: "run_done", run: { summary: "The README says hello." } });
    expect(gateway.requests).toHaveLength(2);
    for (const request of gateway.requests) {
      expect(request.responseFormat).toMatchObject({ type: "json_schema", json_schema: { name: "solo_turn" } });
      expect(toolEnum(request.responseFormat)).toEqual(expect.arrayContaining(["file_ops", "read_file", "search_files"]));
      // Told the envelope it is decoded under (live run 2 looped on read_file without it), once, at the system message's end.
      const system = request.messages[0];
      expect(system?.role).toBe("system");
      expect(system?.content.endsWith(`\n\n${SOLO_ENVELOPE_INSTRUCTION}`)).toBe(true);
      expect(request.messages.slice(1).some((message) => message.content.includes(SOLO_ENVELOPE_INSTRUCTION))).toBe(false);
    }
  });

  it("a delegated child runs constrained too, over its own tools", async () => {
    const files = fakeAdapter({ name: "file_ops", tools: ["read_file"], result: () => ({ status: "completed", summary: "README: hello" }) });
    const script = [envelope("delegate_task", { tasks: [{ goal: "Summarise the README" }] }), JSON.stringify({ answer: "It says hello." }), JSON.stringify({ answer: "Your README says hello." })];
    const { runtime, gateway } = await build({ local: true, script, adapters: (profileDir) => [files, createDelegateAdapter({ profileDir })] });
    const events = await drain(runtime.run("What is in the README?"));

    expect(events.at(-1)?.kind).toBe("run_done");
    expect(gateway.requests).toHaveLength(3);
    const child = gateway.requests[1];
    expect(child?.messages.at(-1)?.content).toContain("Summarise the README");
    expect(child?.responseFormat).toMatchObject({ type: "json_schema", json_schema: { name: "solo_turn" } });
    expect(toolEnum(child?.responseFormat)).toEqual(expect.arrayContaining(["read_file"]));
  });

  it("models.local.constrained_output: false turns it off, as it does for the seats", async () => {
    const { runtime, gateway } = await build({ local: true, script: ["ready"], modelsLocal: { constrained_output: false } });
    await drain(runtime.run("Say ready"));
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.responseFormat).toBeUndefined();
  });
});

describe("[C11] a hosted provider keeps the text protocol", () => {
  it("no response_format on any request; a <tool_call> block is still run", async () => {
    const { runtime, gateway } = await build({ local: false, script: ['<tool_call>\n{"name": "read_file", "arguments": {"path": "README.md"}}\n</tool_call>', "It says hello."] });
    const events = await drain(runtime.run("What does the README say?"));

    expect(events.at(-1)).toMatchObject({ kind: "run_done", run: { summary: "It says hello." } });
    expect(gateway.requests).toHaveLength(2);
    for (const request of gateway.requests) expect(request.responseFormat).toBeUndefined();
    for (const request of gateway.requests) expect(request.messages[0]?.content).not.toContain('{"answer": ');
  });
});

describe("[C11] agent.solo.max_tool_calls reaches the runner", () => {
  it("the run stops at the configured cap with a verdict naming it, before the next call runs", async () => {
    const calls = [1, 2, 3].map((i) => `<tool_call>\n{"name": "read_file", "arguments": {"path": "file-${String(i)}.md"}}\n</tool_call>`);
    const { runtime, gateway } = await build({ local: false, script: calls, solo: { max_tool_calls: 2 } });
    const events = await drain(runtime.run("Read three files"));

    expect(gateway.requests).toHaveLength(3);
    expect(events.at(-1)?.kind).toBe("run_failed");
    expect(events.at(-1)?.detail).toContain("stopped at the solo loop's cap of 2 tool calls");
  });
});
