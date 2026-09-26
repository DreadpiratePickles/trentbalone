/**
 * [S2] The REPL in solo mode, through `ClassicRepl` itself: the runner is chosen by mode, the banner
 * names the mode and the model, the solo runner is the approval target and the ONLY writer of the
 * session (council A1: the REPL's own sink is off), and every held call gets its own card (A3).
 * The model is a scripted gateway and the orchestrator a fake that must never run.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager, SessionManager } from "@trent/core";
import type { Orchestrator } from "@trent/core/orchestrator/index.js";
import { fakeAdapter, scriptedGateway, toolCall, type ScriptStep } from "@trent/core/solo/fakes.test-helpers.js";
import type { TrentToolAdapter } from "@trent/core/tools/index.js";
import { createTheme } from "../../ui/index.js";
import { PROMPT } from "../engine.js";
import { ClassicRepl } from "../index.js";

class ScriptedStdin extends EventEmitter {
  isTTY = true;
  setRawMode(): this { return this; }
  setEncoding(): this { return this; }
  resume(): this { return this; }
  pause(): this { return this; }
}

let home = "";
const savedHome = process.env.TRENT_HOME;
let profileN = 0;
beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-solo-repl-"));
  process.env.TRENT_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

const POST = (n: number) => `social_post {"platform": "bluesky", "text": "Post number ${String(n)}."}`;
const READ = 'read_file {"path": "README.md"}';

function start(script: ScriptStep[], adapters: TrentToolAdapter[]) {
  profileN += 1;
  const profile = `solo-repl-${profileN}`;
  const configManager = new ConfigManager({ profile });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.egress.enabled = false;
  config.provider = "google";
  config.model = "gemini-test";
  configManager.saveConfig(config);
  const orchestratorRuns: string[] = [];
  const createOrchestrator = (): Orchestrator =>
    ({
      ensureCompany: async () => "cmp_solo_repl",
      run: (options: { objective: string }) => {
        orchestratorRuns.push(options.objective);
        throw new Error("the fleet must not run in solo mode");
      },
      snapshot: async () => undefined,
      approve: async () => { throw new Error("the orchestrator is not the approval target in solo"); },
      reject: async () => { throw new Error("the orchestrator is not the approval target in solo"); },
    }) as unknown as Orchestrator;
  const stdin = new ScriptedStdin();
  const out: string[] = [];
  const gateway = scriptedGateway(script);
  const repl = new ClassicRepl({
    profile,
    mode: "solo",
    io: { write: (text) => void out.push(text), isTTY: false, stdin: stdin as never, exit: vi.fn(), theme: createTheme("none"), width: 100 },
    deps: { createOrchestrator, buildAdapters: () => adapters, solo: { gateway, audit: async () => undefined } },
  });
  return { repl, stdin, out, gateway, orchestratorRuns, sessions: () => new SessionManager(new ConfigManager({ profile })) };
}

async function until(predicate: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the REPL");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const prompts = (out: string[]) => out.filter((chunk) => chunk === `${PROMPT}\n`).length;
const cards = (out: string[]) => out.join("").split("APPROVAL REQUIRED").length - 1;

describe("[S2] the REPL in solo mode", () => {
  it("renders a solo turn under a banner naming the mode and the model; the fleet never runs", async () => {
    const s = start(["The launch is on Tuesday."], []);
    const running = s.repl.start();
    await until(() => prompts(s.out) >= 1);
    expect(s.out.join("")).toContain("solo · gemini-test");
    s.stdin.emit("data", "when is the launch\r");
    await until(() => prompts(s.out) >= 2);
    s.stdin.emit("end");
    await running;
    expect(s.out.join("")).toContain("The launch is on Tuesday.");
    expect(s.orchestratorRuns).toEqual([]);
    expect(s.gateway.requests).toHaveLength(1);
  }, 60_000);

  it("A1: the runner is the only writer: one turn with one tool call is [user, assistant, tool, assistant] on disk", async () => {
    const files = fakeAdapter({ name: "file_ops", tools: ["read_file"], result: () => ({ status: "completed", summary: "README: hello" }) });
    const s = start([toolCall(READ), "It says hello.", "Still hello."], [files]);
    const running = s.repl.start();
    await until(() => prompts(s.out) >= 1);
    s.stdin.emit("data", "what does the readme say\r");
    await until(() => prompts(s.out) >= 2);
    s.stdin.emit("data", "and now\r");
    await until(() => prompts(s.out) >= 3);
    s.stdin.emit("end");
    await running;
    const stored = s.sessions().listSessions();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant"]);
    // No history was threaded by the REPL: the second request carries the first turn exactly once.
    const told = (s.gateway.requests[2]?.messages ?? []).map((m) => m.content).join("\n");
    expect(told.split("what does the readme say").length - 1).toBe(1);
  }, 60_000);

  it("A3: two held calls in one run open two cards; each yes releases its call; the run ends with the answer", async () => {
    const social = fakeAdapter({ name: "social", tools: ["social_post"], approval: (action) => action.startsWith("social_post") });
    const s = start([toolCall(POST(1)), toolCall(POST(2)), "Both posts are out."], [social]);
    const running = s.repl.start();
    await until(() => prompts(s.out) >= 1);
    s.stdin.emit("data", "post both announcements\r");
    await until(() => cards(s.out) >= 1);
    s.stdin.emit("data", "y");
    await until(() => cards(s.out) >= 2);
    s.stdin.emit("data", "y");
    await until(() => prompts(s.out) >= 2);
    s.stdin.emit("end");
    await running;
    expect(social.calls.map((call) => call.action)).toEqual([POST(1), POST(2)]);
    expect(cards(s.out)).toBe(2);
    expect(s.out.join("")).toContain("Both posts are out.");
  }, 60_000);
});
