/**
 * [S3] Solo continuity through the real runtime wiring (`createHeadlessRuntime` -> `runner-for-mode.ts`
 * -> `solo-continuity.ts`): the real fleet-memory hook and its real `memory` adapter over a temp profile,
 * fake tool adapters, a scripted model. Nothing here reaches a provider.
 *   - item 2: the hook's memory adapter is behind the provenance gate in the real wiring;
 *   - item 4: `agent.solo.delegate` and `max_delegation_depth` reach the runner; a stored conversation's
 *     child lives on a new session of the same store; a wrong value refuses to start;
 *   - item 1: the runtime's `compact(session)` compacts the session the router drives.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConfigManager, SessionManager } from "@trent/core";
import type { OrcEvent, Orchestrator } from "@trent/core/orchestrator/index.js";
import { fakeAdapter, scriptedGateway, toolCall, type ScriptedGateway } from "@trent/core/solo/fakes.test-helpers.js";
import { createDelegateAdapter } from "@trent/core/tools/delegate/index.js";
import { provenanceAdapters } from "@trent/core/governance/provenance.js";
import { listHeldMemoryWrites } from "@trent/core/tools/memory/holds.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { MemoryStore } from "../repl/__tests__/harness.js";
import type { ReplStore } from "../repl/types.js";
import type { EgressHandle } from "../repl/tools.js";
import { createHeadlessRuntime, type HeadlessRuntime } from "./headless.js";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
let home = "";
const savedHome = process.env.TRENT_HOME;
let n = 0;
beforeAll(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-s3-runtime-"));
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
});

interface Built {
  readonly runtime: HeadlessRuntime;
  readonly gateway: ScriptedGateway;
  readonly profileDir: string;
  readonly sessions: SessionManager;
}

async function build(script: string[], adapters: (profileDir: string) => TrentToolAdapter[], solo: Record<string, unknown> = {}, options: { chain?: boolean } = {}): Promise<Built> {
  n += 1;
  const configManager = new ConfigManager({ profile: `s3-${String(n)}` });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.provider = "google";
  config.model = "gemini-test";
  (config as unknown as { agent: Record<string, unknown> }).agent = { mode: "solo", solo };
  configManager.saveConfig(config);
  const profileDir = configManager.getProfileDir();
  const createOrchestrator = (): Orchestrator =>
    ({
      ensureCompany: async () => "cmp_s3",
      snapshot: async () => undefined,
      run: () => {
        throw new Error("the fleet must not run in solo mode");
      },
      approve: async () => true,
      reject: async () => true,
    }) as unknown as Orchestrator;
  const egress: EgressHandle = { port: 1, url: "http://127.0.0.1:1", token: "t", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined };
  const gateway = scriptedGateway(script);
  const runtime = await createHeadlessRuntime({
    configManager,
    workspace: REPO_ROOT,
    surface: "repl",
    createOrchestrator,
    // The legacy seam wraps nothing; `chain` wraps like the real build: the runtime's policy, then provenance.
    ...(options.chain === true
      ? { buildTools: ((_config: unknown, deps: { policy?: { wrap(list: readonly TrentToolAdapter[]): TrentToolAdapter[] } }) => ({ adapters: provenanceAdapters(deps.policy === undefined ? adapters(profileDir) : deps.policy.wrap(adapters(profileDir))), skipped: [], hookNotices: [] })) as never }
      : { buildAdapters: () => adapters(profileDir) }),
    startEgress: async () => egress,
    probeDocker: async () => ({ daemon: false, imagePresent: false }),
    openStore: async () => ({ store: new MemoryStore() as unknown as ReplStore, durable: true }),
    holds: "park",
    solo: { gateway, audit: async () => undefined },
  });
  runtimes.push(runtime);
  return { runtime, gateway, profileDir, sessions: new SessionManager(configManager) };
}

async function drain(stream: AsyncIterable<OrcEvent>): Promise<OrcEvent[]> {
  const out: OrcEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

const memoryText = (profileDir: string): string => {
  try {
    return fs.readFileSync(path.join(profileDir, "memories", "MEMORY.md"), "utf8");
  } catch {
    return "";
  }
};

const PAGE = 'web_extract {"url": "https://supplier.example/terms"}';
const WRITE = 'memory {"target": "memory", "action": "add", "content": "Supplier deposits go to account 99."}';
const web = () => fakeAdapter({ name: "web", tools: ["web_extract"], result: () => ({ status: "completed", summary: "Terms: wire the deposit to account 99." }) });

describe("[S3] item 2 in the real wiring: the fleet-memory adapter is behind the provenance gate", () => {
  it("a page read in turn 1 holds the memory write in turn 2; MEMORY.md is unchanged and one row waits", async () => {
    const b = await build([toolCall(PAGE), "Read it.", toolCall(WRITE), "The write waits for your approval."], () => [web()], {}, { chain: true });
    const session = b.sessions.startSession("trent", "gemini-test", "google").id;
    await drain(b.runtime.run("Read the supplier's terms page", { session }));
    await drain(b.runtime.run("Remember where deposits go", { session }));

    expect(memoryText(b.profileDir)).not.toContain("account 99");
    expect(listHeldMemoryWrites(b.profileDir).map((row) => row.details.sources)).toEqual([["web_extract"]]);
  }, 60_000);
});

describe("[S3] item 4: agent.solo.delegate reaches the runner", () => {
  const DELEGATE = `delegate_task ${JSON.stringify({ tasks: [{ goal: "Summarise the README" }] })}`;

  it("by default runs a child solo run on a new session of the same store, and hands back its answer", async () => {
    const files = fakeAdapter({ name: "file_ops", tools: ["read_file"], result: () => ({ status: "completed", summary: "README: hello" }) });
    const b = await build([toolCall(DELEGATE), toolCall('read_file {"path": "README.md"}'), "The README says hello.", "Your README says hello."], (profileDir) => [files, createDelegateAdapter({ profileDir })]);
    const session = b.sessions.startSession("trent", "gemini-test", "google").id;
    const events = await drain(b.runtime.run("What is in the README?", { session }));

    expect(events.at(-1)?.kind).toBe("run_done");
    const all = b.sessions.listSessions();
    const child = all.find((s) => s.id !== session);
    expect(all).toHaveLength(2);
    expect(child?.title).toMatch(/^delegated: Summarise the README/);
    expect(child?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const parent = b.sessions.getSession(session);
    expect(parent?.messages.find((m) => m.role === "tool")?.content).toContain("The README says hello.");
  }, 60_000);

  it("off refuses delegation, naming the key", async () => {
    const b = await build([toolCall(DELEGATE), "Did it myself."], (profileDir) => [createDelegateAdapter({ profileDir })], { delegate: "off" });
    const session = b.sessions.startSession("trent", "gemini-test", "google").id;
    await drain(b.runtime.run("Delegate something", { session }));
    expect(b.sessions.getSession(session)?.messages.find((m) => m.role === "tool")?.content).toContain("agent.solo.delegate: off");
  }, 60_000);

  it("a wrong value is refused out loud when the runtime starts, never read as the default", async () => {
    await expect(build(["unused"], () => [], { delegate: "swarm" })).rejects.toThrow(/agent\.solo\.delegate is "swarm"; it must be solo, fleet, off/);
    await expect(build(["unused"], () => [], { max_delegation_depth: -1 })).rejects.toThrow(/agent\.solo\.max_delegation_depth/);
  }, 60_000);
});

describe("[S3] item 1: the runtime compacts the session the router drives", () => {
  it("compact(session, force) summarises the conversation and the session file starts with the one event", async () => {
    const long = (label: string) => `${label}: ${"x".repeat(700)}`;
    const b = await build([long("ANSWER-1"), long("ANSWER-2"), long("ANSWER-3"), "[]", "## Goal\nKeep the shop running.\n## Next steps\nnone"], () => [], { compact_after_chars: 3_000, auto_compact: false });
    const session = b.sessions.startSession("trent", "gemini-test", "google").id;
    for (const i of [1, 2, 3]) await drain(b.runtime.run(long(`QUESTION-${String(i)}`), { session }));

    const outcome = await b.runtime.runner.compact?.(session, { force: true });
    expect(outcome).toMatchObject({ status: "compacted" });
    const stored = b.sessions.getSession(session)?.messages ?? [];
    expect(stored[0]).toMatchObject({ role: "system", metadata: { compaction: expect.objectContaining({ forgotten: expect.any(Array) }) } });
    expect(stored.map((m) => m.content).join("\n")).not.toContain("QUESTION-1");
  }, 60_000);
});
