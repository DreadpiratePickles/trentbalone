/**
 * [S3] The REPL in solo, through `ClassicRepl` itself: `/compact` compacts the session through the solo
 * runner; a park left by a killed REPL session is offered on the next launch and `/resume` continues it
 * to the answer; `/rollback` undoes a solo write and tells the conversation; a solo turn's cost lands in
 * the session (`trent sessions`, the `-c` ticker). Scripted model; the orchestrator must never run.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager, SessionManager } from "@trent/core";
import type { Orchestrator } from "@trent/core/orchestrator/index.js";
import { fakeAdapter, scriptedGateway, toolCall, type ScriptStep } from "@trent/core/solo/fakes.test-helpers.js";
import { createFileOpsAdapter } from "@trent/core/tools/file_ops/index.js";
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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-s3-repl-"));
  process.env.TRENT_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function newProfile(solo: Record<string, unknown> = {}): string {
  profileN += 1;
  const profile = `s3-repl-${String(profileN)}`;
  const configManager = new ConfigManager({ profile });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.egress.enabled = false;
  config.provider = "google";
  config.model = "gemini-test";
  (config as unknown as { agent: Record<string, unknown> }).agent = { solo };
  configManager.saveConfig(config);
  return profile;
}

function launch(profile: string, script: ScriptStep[], adapters: (profileDir: string) => TrentToolAdapter[], options: { continueSession?: boolean; workspace?: string } = {}) {
  const createOrchestrator = (): Orchestrator =>
    ({
      ensureCompany: async () => "cmp_s3_repl",
      run: () => {
        throw new Error("the fleet must not run in solo mode");
      },
      snapshot: async () => undefined,
      approve: async () => false,
      reject: async () => false,
    }) as unknown as Orchestrator;
  const stdin = new ScriptedStdin();
  const out: string[] = [];
  const gateway = scriptedGateway(script);
  const profileDir = new ConfigManager({ profile }).getProfileDir();
  const repl = new ClassicRepl({
    profile,
    mode: "solo",
    ...(options.continueSession === true ? { continueSession: true } : {}),
    io: { write: (text) => void out.push(text), isTTY: false, stdin: stdin as never, exit: vi.fn(), theme: createTheme("none"), width: 100 },
    deps: { createOrchestrator, buildAdapters: () => adapters(profileDir), solo: { gateway, audit: async () => undefined }, ...(options.workspace === undefined ? {} : { workspace: options.workspace }) },
  });
  return { repl, stdin, out, gateway, sessions: () => new SessionManager(new ConfigManager({ profile })) };
}

async function until(predicate: () => boolean, ms = 45_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the REPL");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const prompts = (out: string[]) => out.filter((chunk) => chunk === `${PROMPT}\n`).length;
const cards = (out: string[]) => out.join("").split("APPROVAL REQUIRED").length - 1;
const long = (label: string) => `${label}: ${"x".repeat(700)}`;

describe("[S3] /compact in a solo REPL session", () => {
  it("compacts the session through the solo runner and says what it did", async () => {
    const profile = newProfile({ compact_after_chars: 3_000, auto_compact: false });
    const s = launch(profile, [long("ANSWER-1"), long("ANSWER-2"), long("ANSWER-3"), "[]", "## Goal\nShip it.\n## Next steps\nnone"], () => []);
    const running = s.repl.start();
    await until(() => prompts(s.out) >= 1);
    for (const i of [1, 2, 3]) {
      s.stdin.emit("data", `${long(`QUESTION-${String(i)}`)}\r`);
      await until(() => prompts(s.out) >= i + 1);
    }
    s.stdin.emit("data", "/compact\r");
    await until(() => s.out.join("").includes("Compacted this conversation"));
    s.stdin.emit("end");
    await running;
    const stored = s.sessions().listSessions()[0]?.messages ?? [];
    expect(stored[0]?.role).toBe("system");
    expect(stored.map((m) => m.content).join("\n")).not.toContain("QUESTION-1");
  }, 90_000);
});

describe("[S3] a park left by a killed REPL session is offered on the next launch, and /resume continues it", () => {
  it("names the waiting approval at launch; /resume opens its card; a yes runs the call and the answer is printed", async () => {
    const profile = newProfile();
    const POST = 'social_post {"platform": "bluesky", "text": "Autumn catalogue is out."}';
    const first = fakeAdapter({ name: "social", tools: ["social_post"], approval: () => true });
    const killed = launch(profile, [toolCall(POST)], () => [first]);
    const running = killed.repl.start();
    await until(() => prompts(killed.out) >= 1);
    killed.stdin.emit("data", "announce the catalogue\r");
    await until(() => cards(killed.out) >= 1);
    killed.stdin.emit("end"); // killed while the card was open
    await running;
    expect(first.calls).toEqual([]);

    const social = fakeAdapter({ name: "social", tools: ["social_post"], approval: () => true });
    const next = launch(profile, ["The catalogue is announced."], () => [social], { continueSession: true });
    const again = next.repl.start();
    await until(() => prompts(next.out) >= 1);
    expect(next.out.join("")).toMatch(/A run is waiting on approval appr_test; \/resume to continue\./);
    next.stdin.emit("data", "/resume\r");
    await until(() => cards(next.out) >= 1);
    next.stdin.emit("data", "y");
    await until(() => next.out.join("").includes("The catalogue is announced."));
    next.stdin.emit("end");
    await again;
    expect(social.calls.map((call) => call.action)).toEqual([POST]);
  }, 90_000);
});

describe("[S3] /rollback in a solo REPL session", () => {
  it("undoes the solo write byte-exact and tells the conversation, which the next turn reads", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-s3-repl-ws-"));
    fs.writeFileSync(path.join(workspace, "notes.md"), "original notes\n");
    const profile = newProfile();
    const WRITE = 'write_file {"path": "notes.md", "content": "agent rewrote the notes\\n"}';
    const s = launch(profile, [toolCall(WRITE), "Rewrote them.", "They are the original notes again."], (profileDir) => [createFileOpsAdapter({ workspace, profileDir, backend: "local", autoApproveWrites: true })], { workspace });
    const running = s.repl.start();
    await until(() => prompts(s.out) >= 1);
    s.stdin.emit("data", "rewrite the notes\r");
    await until(() => prompts(s.out) >= 2);
    expect(fs.readFileSync(path.join(workspace, "notes.md"), "utf8")).toBe("agent rewrote the notes\n");
    s.stdin.emit("data", "/rollback\r");
    await until(() => prompts(s.out) >= 3);
    expect(fs.readFileSync(path.join(workspace, "notes.md"), "utf8")).toBe("original notes\n");
    s.stdin.emit("data", "what do the notes say\r");
    await until(() => prompts(s.out) >= 4);
    s.stdin.emit("end");
    await running;
    const told = (s.gateway.requests.at(-1)?.messages ?? []).map((m) => m.content).join("\n");
    expect(told).toMatch(/\/rollback undid turn 1 and after: notes\.md restored/);
    const stored = s.sessions().listSessions()[0]?.messages ?? [];
    expect(stored.some((m) => m.role === "system" && m.content.includes("notes.md restored"))).toBe(true);
    fs.rmSync(workspace, { recursive: true, force: true });
  }, 90_000);
});

describe("[S3] a solo turn's cost lands in the session", () => {
  it("the answer carries cost_cents and the session total adds it up", async () => {
    const profile = newProfile();
    const s = launch(profile, ["The launch is Tuesday."], () => []);
    const running = s.repl.start();
    await until(() => prompts(s.out) >= 1);
    s.stdin.emit("data", "when is the launch\r");
    await until(() => prompts(s.out) >= 2);
    s.stdin.emit("end");
    await running;
    const session = s.sessions().listSessions()[0];
    expect(session?.messages.find((m) => m.role === "assistant")?.metadata?.cost_cents).toBe(1);
    expect(session?.total_cost_cents).toBe(1);
  }, 90_000);
});
