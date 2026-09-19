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
import { isCompactionEvent, transcriptChars } from "@trent/core/sessions/index.js";
import { contextLimits, createSessionCompactor, personalitySuffix } from "../compact.js";
import { historySeed } from "../conversation.js";
import { wireFleetMemory } from "../fleet-memory.js";
import type { ReplConfig } from "../types.js";

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
