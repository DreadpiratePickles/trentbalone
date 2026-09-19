/**
 * The CLI's half of context management: the config keys that bound a prompt, the personality that
 * reaches the volatile tier, and the compactor that keeps a long session's stored transcript from
 * growing without end.
 *
 * Offline: a fake gateway, a real memory adapter on a temp profile, a real `SessionManager`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager, SessionManager } from "@trent/core";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import { isCompactionEvent, transcriptChars } from "@trent/core/sessions/index.js";
import { createTheme } from "../../ui/index.js";
import { ApprovalGate } from "../approvals.js";
import { BudgetLedger } from "../budget.js";
import { runCommand } from "../commands.js";
import { contextLimits, createSessionCompactor, personalitySuffix } from "../compact.js";
import { historySeed } from "../conversation.js";
import { wireFleetMemory } from "../fleet-memory.js";
import type { ReplConfig, ReplContext } from "../types.js";
import { MemoryStore, makeHarness } from "./harness.js";

let home = "";
const savedHome = process.env.TRENT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-context-cli-"));
  process.env.TRENT_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("context limits from config", () => {
  it("reads context.ceiling_chars and repl.history_chars, and defaults compact_after to twice the history", () => {
    const config = { context: { ceiling_chars: 12_000 }, repl: { history_chars: 500 } } as unknown as ReplConfig;
    expect(contextLimits(config)).toEqual({ ceilingChars: 12_000, historyChars: 500, compactAfterChars: 1000 });
  });

  it("takes an explicit compact_after_chars over the doubled history budget", () => {
    const config = { context: { ceiling_chars: 100, compact_after_chars: 321 }, repl: { history_chars: 500 } } as unknown as ReplConfig;
    expect(contextLimits(config).compactAfterChars).toBe(321);
  });

  it("falls back to the shipped defaults when the profile sets neither", () => {
    const limits = contextLimits({} as unknown as ReplConfig);
    expect(limits.ceilingChars).toBe(60_000);
    expect(limits.historyChars).toBe(6000);
    expect(limits.compactAfterChars).toBe(12_000);
  });
});

describe("the personality the wrapper injects", () => {
  it("resolves the active personality's suffix from the profile", () => {
    const manager = new ConfigManager();
    const config = manager.loadConfig();
    config.personality = "pirate";
    manager.saveConfig(config);
    const suffix = personalitySuffix(manager);
    expect(suffix).toBeTypeOf("string");
    expect(suffix).toContain("pirate");
  });

  it("hands the ceiling and the suffix to the fleet-memory hook", async () => {
    const profileDir = path.join(home, "profile");
    fs.mkdirSync(path.join(profileDir, "memories"), { recursive: true });
    fs.writeFileSync(path.join(profileDir, "memories", "MEMORY.md"), "One durable fact.");
    const hook = wireFleetMemory({ profileDir, ceilingChars: 50_000, personalitySuffix: "Tone stance: be direct." });
    let injected = "";
    const seat = hook.wrapSeatModel(async (input: { subtask: { id: string; seat: string; objective: string }; dynamicPrompt?: string }) => {
      injected = input.dynamicPrompt ?? "";
      return {};
    });
    hook.runStarted({ runId: "r1", companyId: "co", objective: "ship it" });
    await seat({ subtask: { id: "s1", seat: "engineer", objective: "ship it" } });
    expect(injected).toContain("One durable fact.");
    expect(injected.trimEnd().endsWith("Tone stance: be direct.")).toBe(true);
    expect(hook.contextFor("r1", "engineer")?.ceilingChars).toBe(50_000);
  });
});

describe("the session compactor", () => {
  function session(sessions: SessionManager, turns: number): string {
    const id = sessions.startSession("ceo", "m", "p").id;
    for (let i = 0; i < turns; i += 1) {
      sessions.appendMessage(id, { role: "user", content: `question ${i} `.padEnd(200, "x") });
      sessions.appendMessage(id, { role: "assistant", content: `answer ${i} `.padEnd(200, "y") });
    }
    return id;
  }

  it("leaves a short session alone", async () => {
    const sessions = new SessionManager();
    const id = session(sessions, 1);
    const compact = createSessionCompactor({
      sessions,
      companyId: "co",
      limits: { ceilingChars: 60_000, historyChars: 6000, compactAfterChars: 12_000 },
      gateway: async () => ({ complete: async () => ({ text: "never called", costCents: 0 }) }),
    });
    expect((await compact(id)).status).toBe("not_needed");
    expect(sessions.getSession(id)?.messages).toHaveLength(2);
  });

  it("compacts a long session once, records the forgotten ids, and persists the result", async () => {
    const sessions = new SessionManager();
    const id = session(sessions, 10);
    const before = sessions.getSession(id)!;
    const beforeChars = transcriptChars(before.messages);
    const calls: string[] = [];
    const written: string[] = [];
    const compact = createSessionCompactor({
      sessions,
      companyId: "co",
      memory: { execute: async (action) => { written.push(action); return { status: "completed", summary: "ok" }; } },
      limits: { ceilingChars: 60_000, historyChars: 600, compactAfterChars: 1200 },
      gateway: async () => ({
        complete: async (request: { messages: Array<{ content: string }> }) => {
          calls.push(request.messages.map((m) => m.content).join("\n"));
          // First call is the memory flush (JSON), second is the summary (prose).
          return calls.length === 1
            ? { text: JSON.stringify(["The billing webhook must be idempotent by event id."]), costCents: 0 }
            : { text: "Earlier: the founder asked ten questions about the billing webhook.", costCents: 0 };
        },
      }),
    });

    const result = await compact(id);
    expect(result.status).toBe("compacted");
    if (result.status !== "compacted") return;
    expect(result.forgotten.length).toBeGreaterThan(0);

    const after = sessions.getSession(id)!;
    expect(after.messages.filter(isCompactionEvent)).toHaveLength(1);
    expect(transcriptChars(after.messages)).toBeLessThan(beforeChars);
    expect(after.messages.some((m) => result.forgotten.includes(m.id))).toBe(false);
    expect(after.messages.at(-1)?.content).toBe(before.messages.at(-1)?.content);
    // Both halves ran: the memory flush was offered the dropped turns, then the summariser.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("question 0");
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("idempotent by event id");
  });

  it("changes nothing when no gateway can be built", async () => {
    const sessions = new SessionManager();
    const id = session(sessions, 10);
    const before = sessions.getSession(id)!.messages.length;
    const compact = createSessionCompactor({
      sessions,
      companyId: "co",
      limits: { ceilingChars: 60_000, historyChars: 600, compactAfterChars: 1200 },
      gateway: async () => undefined,
    });
    const result = await compact(id);
    expect(result.status).toBe("skipped");
    expect(sessions.getSession(id)?.messages).toHaveLength(before);
  });
});

describe("what a resumed session threads into the next run", () => {
  it("keeps the compaction summary, drops an interrupted fragment, and keeps the order", () => {
    const seed = historySeed([
      { id: "m0", role: "user", content: "the first question", timestamp: "t" },
      { id: "m1", role: "assistant", content: "half an answer", timestamp: "t", metadata: { status: "interrupted" } },
      {
        id: "m2",
        role: "system",
        content: "Compacted transcript. 4 message(s) forgotten.\nEarlier: we agreed on integer cents.",
        timestamp: "t",
        metadata: { compaction: { at: "t", forgotten: ["a", "b", "c", "d"], summary: "Earlier: we agreed on integer cents.", chars_before: 100, chars_after: 20 } },
      },
      { id: "m3", role: "assistant", content: "the whole answer", timestamp: "t" },
    ]);
    expect(seed.map((m) => m.role)).toEqual(["user", "system", "assistant"]);
    expect(seed[1]?.content).toContain("integer cents");
    expect(seed.some((m) => m.content === "half an answer")).toBe(false);
  });

  it("drops a plain system message that is not a compaction event", () => {
    const seed = historySeed([{ id: "m0", role: "system", content: "a note nobody said", timestamp: "t" }]);
    expect(seed).toEqual([]);
  });
});

// ── A1.2: the `/context` inspector ──────────────────────────────────────────

describe("the /context inspector", () => {
  /** One real hook, one real seat call: the numbers below are the ones the seat was handed. */
  async function assembled(ceilingChars: number): Promise<{ hook: ReturnType<typeof wireFleetMemory>; injected: string }> {
    const profileDir = path.join(home, `ctx-${String(ceilingChars)}`);
    fs.mkdirSync(path.join(profileDir, "memories"), { recursive: true });
    fs.writeFileSync(path.join(profileDir, "memories", "MEMORY.md"), "Billing is idempotent by event id.".repeat(40));
    const hook = wireFleetMemory({ profileDir, ceilingChars, personalitySuffix: "Tone stance: be direct." });
    let injected = "";
    const seat = hook.wrapSeatModel(async (input: { subtask: { id: string; seat: string; objective: string }; dynamicPrompt?: string }) => {
      injected = input.dynamicPrompt ?? "";
      return {};
    });
    hook.runStarted({
      runId: "run_ctx",
      companyId: "cmp_ctx",
      objective: "ship the billing webhook",
      history: [{ role: "user", content: "what did we decide about billing" }],
    });
    await seat({ subtask: { id: "s1", seat: "engineer", objective: "ship the billing webhook" } });
    return { hook, injected };
  }

  function contextFor(hook: ReturnType<typeof wireFleetMemory>, compactions: number): ReplContext {
    const store = new MemoryStore();
    const config = structuredClone(DEFAULT_CONFIG);
    return {
      theme: createTheme("none"),
      config: config as unknown as ReplConfig,
      store,
      companyId: "cmp_ctx",
      traces: { query: async () => [], byRun: async () => [] },
      budget: new BudgetLedger({ capCents: config.budget.daily_cap, thresholds: config.budget.alert_thresholds }),
      approvals: new ApprovalGate(store, "cmp_ctx"),
      degraded: false,
      contextInspector: hook,
      contextRuns: [{ runId: "run_ctx", seats: ["engineer"] }],
      compactions,
    };
  }

  it("lists the three tiers with sizes that add up to the prelude the seat was handed", async () => {
    const { hook, injected } = await assembled(60_000);
    const measured = hook.contextFor("run_ctx", "engineer");
    expect(measured).toBeDefined();
    expect(measured?.chars).toBe(injected.length);

    const out = await runCommand("context", [], contextFor(hook, 0));
    for (const tier of ["stable", "context", "volatile"]) expect(out).toContain(tier);
    expect(out).toContain(String(measured?.stableChars));
    expect(out).toContain(String(measured?.volatileChars));
    expect(out).toContain(String(injected.length));
    expect(out).toContain(String(measured?.estimatedTokens));
    expect(out).toContain("60000");
  });

  it("names what the ceiling dropped, and the session's compaction count", async () => {
    // A ceiling under the stable tier alone: everything trimmable is dropped and named.
    const { hook } = await assembled(400);
    const measured = hook.contextFor("run_ctx", "engineer");
    expect(measured?.dropped.length).toBeGreaterThan(0);

    const out = await runCommand("context", [], contextFor(hook, 3));
    for (const name of measured?.dropped ?? []) expect(out).toContain(name);
    expect(out).toMatch(/compact\w*\D+3/i);
  });

  it("says plainly that nothing has been assembled when no run has happened yet", async () => {
    const { hook } = await assembled(60_000);
    const ctx = { ...contextFor(hook, 0), contextRuns: [] };
    const out = await runCommand("context", [], ctx);
    expect(out).toMatch(/no run/i);
  });
});

describe("the engine's own context state", () => {
  it("tracks the run and the seats it saw, so /context can ask the hook about them", async () => {
    const harness = makeHarness();
    await harness.engine.submit("plan the launch");
    expect(harness.engine.context.contextRuns).toEqual([{ runId: "run_h", seats: ["eng-ai-engineer"] }]);
  });

  it("shows each session notice exactly once, however many turns run", async () => {
    const lines = ['The session_start hook /bin/echo has not been consented to. Run "trent hooks consent" to allow it.'];
    const harness = makeHarness({ notices: () => lines });
    await harness.engine.submit("first");
    await harness.engine.submit("second");
    const shown = harness.out.filter((line) => line.includes("has not been consented to"));
    expect(shown).toHaveLength(1);
  });
});
