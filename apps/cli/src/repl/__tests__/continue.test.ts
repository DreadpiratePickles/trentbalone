/**
 * A.2 — `trent --continue` restores the conversation, and every REPL turn is written to a session.
 *
 * Before this, `ClassicRepl` called `resumeLastSession()` and threw the result away, and never
 * called `startSession` or `appendMessage` at all: the flag was accepted, plumbed through three
 * files and did nothing. Here the session on disk is the fixture and the assertion — a recording
 * orchestrator stands in for the model, so no provider, no Docker and no proxy are involved.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager, SessionManager } from "@trent/core";
import type { OrcEvent, Orchestrator, OrchestratorRunOptions } from "@trent/core/orchestrator/index.js";
import { createTheme } from "../../ui/index.js";
import { PROMPT } from "../engine.js";
import { ClassicRepl, type ReplDeps } from "../index.js";

const SUMMARY = "Renewal risk sits with the two accounts whose usage fell in the last 30 days.";
const SEEDED_ASK = "which accounts are at renewal risk";
const SEEDED_ANSWER = "Two accounts: Northwind and Contoso, both down on usage.";

class ScriptedStdin extends EventEmitter {
  isTTY = true;
  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

let home = "";
const savedHome = process.env.TRENT_HOME;
let profileN = 0;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-continue-"));
  process.env.TRENT_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function events(objective: string): OrcEvent[] {
  const at = "2026-09-18T00:00:00.000Z";
  return [
    { kind: "run_start", runId: "run_cont", at, run: { objective } },
    { kind: "step_end", runId: "run_cont", at, step: { id: "s1", title: "Read the accounts", agentRole: "sales-csm", costCents: 6, tokens: 90, model: "scripted-seat" } },
    { kind: "consolidate_end", runId: "run_cont", at, run: { summary: SUMMARY } },
    { kind: "run_done", runId: "run_cont", at, run: { status: "completed", summary: SUMMARY } },
  ];
}

/** An orchestrator that records what each run was asked for and streams a completed run back. */
function recordingOrchestrator(recorded: OrchestratorRunOptions[]): ReplDeps["createOrchestrator"] {
  return () =>
    ({
      ensureCompany: async () => "cmp_continue",
      run: (options: OrchestratorRunOptions) => {
        recorded.push(options);
        const stream = (async function* () {
          for (const event of events(options.objective)) yield event;
        })();
        return Object.assign(stream, {
          runId: "run_cont",
          started: Promise.resolve("run_cont"),
          result: async () => ({ id: "run_cont", status: "completed" }),
          cancel: async () => true,
        });
      },
      snapshot: async () => undefined,
      approve: async () => true,
      reject: async () => true,
      answer: async () => true,
    }) as unknown as Orchestrator;
}

interface Session {
  repl: ClassicRepl;
  stdin: ScriptedStdin;
  out: string[];
  profile: string;
  sessions: SessionManager;
}

function session(options: { continueSession?: boolean; seed?: boolean }, deps: ReplDeps): Session {
  profileN += 1;
  const profile = `continue-${profileN}`;
  const configManager = new ConfigManager({ profile });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.egress.enabled = false;
  configManager.saveConfig(config);

  const sessions = new SessionManager(configManager);
  if (options.seed === true) {
    const seeded = sessions.startSession("ceo", config.model, config.provider);
    sessions.appendMessage(seeded.id, { role: "user", content: SEEDED_ASK });
    sessions.appendMessage(seeded.id, {
      role: "assistant",
      agent: "ceo",
      content: SEEDED_ANSWER,
      metadata: { cost_cents: 41 },
    });
  }

  const stdin = new ScriptedStdin();
  const out: string[] = [];
  const repl = new ClassicRepl({
    profile,
    ...(options.continueSession === true ? { continueSession: true } : {}),
    io: { write: (text) => void out.push(text), isTTY: false, stdin: stdin as never, exit: vi.fn(), theme: createTheme("none"), width: 80 },
    deps,
  });
  return { repl, stdin, out, profile, sessions: new SessionManager(new ConfigManager({ profile })) };
}

async function until(predicate: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the REPL");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function atPrompt(out: string[]): boolean {
  return out.some((chunk) => chunk === `${PROMPT}\n`);
}

describe("trent --continue", () => {
  it("prints a recap of the resumed session and hands its messages to the next run", async () => {
    const recorded: OrchestratorRunOptions[] = [];
    const s = session({ continueSession: true, seed: true }, { createOrchestrator: recordingOrchestrator(recorded) });
    const started = s.repl.start();
    await until(() => atPrompt(s.out));
    const recap = s.out.join("");
    s.stdin.emit("data", "and which one renews first\r");
    await until(() => recorded.length > 0);
    await until(() => s.out.filter((chunk) => chunk === `${PROMPT}\n`).length >= 2);
    s.stdin.emit("end");
    await started;

    // The recap is on screen before the first prompt, in plain text.
    expect(recap).toContain(SEEDED_ASK);
    expect(recap).toContain(SEEDED_ANSWER.slice(0, 20));
    // The resumed transcript rides alongside the new objective, which stays the raw line.
    expect(recorded[0]?.objective).toBe("and which one renews first");
    expect(recorded[0]?.history).toEqual([
      { role: "user", content: SEEDED_ASK },
      { role: "assistant", content: SEEDED_ANSWER },
    ]);
  }, 60_000);

  it("seeds the budget ledger with what the resumed session already spent", async () => {
    const recorded: OrchestratorRunOptions[] = [];
    const s = session({ continueSession: true, seed: true }, { createOrchestrator: recordingOrchestrator(recorded) });
    const started = s.repl.start();
    await until(() => atPrompt(s.out));
    s.stdin.emit("data", "and which one renews first\r");
    await until(() => s.out.filter((chunk) => chunk === `${PROMPT}\n`).length >= 2);
    s.stdin.emit("data", "/budget\r");
    await until(() => s.out.filter((chunk) => chunk === `${PROMPT}\n`).length >= 3);
    s.stdin.emit("end");
    await started;

    // 41 cents were spent before this process existed and 6 in the turn just run: the ticker is
    // the sum, not the session's own spend.
    expect(s.out.join("")).toContain("$0.47");
  }, 60_000);

  it("appends the user line and the run's own output to the session, with the run id", async () => {
    const recorded: OrchestratorRunOptions[] = [];
    const s = session({ seed: false }, { createOrchestrator: recordingOrchestrator(recorded) });
    const started = s.repl.start();
    await until(() => atPrompt(s.out));
    s.stdin.emit("data", "who is at renewal risk\r");
    await until(() => recorded.length > 0);
    await until(() => s.out.filter((chunk) => chunk === `${PROMPT}\n`).length >= 2);
    s.stdin.emit("end");
    await started;

    const stored = s.sessions.listSessions();
    expect(stored).toHaveLength(1);
    const messages = stored[0]?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.content).toBe("who is at renewal risk");
    expect(messages[1]?.content).toBe(SUMMARY);
    expect(messages[1]?.metadata?.run_id).toBe("run_cont");
    expect(messages[1]?.metadata?.cost_cents).toBe(6);
    expect(stored[0]?.total_cost_cents).toBe(6);
  }, 60_000);
});
