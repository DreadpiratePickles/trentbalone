/**
 * P2-5a item 9: the REPL had no `/exit`. P2-A2 met `Unknown command: /exit`
 * (docs/sessions/2026-09-25-p2a2-first-run.md); only Ctrl+D or stdin closing ended a session.
 *
 * `/exit` is Ctrl+D typed as a command: the same `exit(0)`, so the same cleanup of the proxy and
 * the sandboxes before the process goes. Ctrl+D is ignored while a run is in flight, and so is
 * `/exit`: it says to stop the run first rather than abandon it half way.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import { createTheme } from "../../ui/index.js";
import { ApprovalGate } from "../approvals.js";
import { BudgetLedger } from "../budget.js";
import { commandNames, runCommand } from "../commands.js";
import { PROMPT } from "../engine.js";
import { ClassicRepl } from "../index.js";
import type { ReplContext, ReplSessionControl } from "../types.js";
import { MemoryStore } from "./harness.js";

function context(session?: ReplSessionControl): ReplContext {
  const store = new MemoryStore();
  const config = structuredClone(DEFAULT_CONFIG);
  return {
    theme: createTheme("none"),
    config,
    store,
    companyId: "cmp_exit",
    traces: { query: async () => [], byRun: async () => [] },
    budget: new BudgetLedger({ capCents: config.budget.daily_cap, thresholds: config.budget.alert_thresholds }),
    approvals: new ApprovalGate(store, "cmp_exit"),
    degraded: false,
    ...(session === undefined ? {} : { session }),
  };
}

describe("/exit", () => {
  it("is a registered command, so /help lists it and it completes", () => {
    expect(commandNames()).toContain("exit");
  });

  it("ends the session when nothing is running", async () => {
    const end = vi.fn(() => "ended" as const);
    const out = await runCommand("exit", [], context({ end }));
    expect(end).toHaveBeenCalledTimes(1);
    expect(out).toContain("Session ended.");
  });

  it("refuses while a run is in flight and names the ways to stop it", async () => {
    const out = await runCommand("exit", [], context({ end: () => "busy" }));
    expect(out).toContain("A run is in flight");
    expect(out).toContain("/stop");
    expect(out).toContain("Ctrl+C");
  });

  it("without a session to end, says Ctrl+D does it instead of pretending", async () => {
    expect(await runCommand("exit", [], context())).toContain("Ctrl+D");
  });
});

class ScriptedStdin extends EventEmitter {
  isTTY = false;
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

describe("/exit typed into a real REPL", () => {
  let home = "";
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "trent-repl-exit-"));
    vi.stubEnv("TRENT_HOME", home);
    // Not a key: it only keeps the REPL out of the degraded first-run path. No turn is sent.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-not-a-key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it("exits 0 through the session's own exit path", async () => {
    const stdin = new ScriptedStdin();
    const out: string[] = [];
    const exit = vi.fn();
    const repl = new ClassicRepl({
      profile: "exit-test",
      io: { write: (text: string) => void out.push(text), isTTY: false, stdin: stdin as never, exit: (code: number) => void exit(code), theme: createTheme("ansi16"), width: 100 },
    });
    const started = repl.start();
    const until = async (done: () => boolean, what: string): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (!done()) {
        if (Date.now() > deadline) throw new Error(`${what} did not happen:\n${out.join("")}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    await until(() => out.some((chunk) => chunk.includes(PROMPT)), "the prompt");
    stdin.emit("data", "/exit\r");
    await until(() => exit.mock.calls.length > 0, "exit");
    expect(exit).toHaveBeenCalledWith(0);
    expect(out.join("")).not.toContain("Unknown command");
    stdin.emit("end");
    await started;
  }, 30_000);
});
