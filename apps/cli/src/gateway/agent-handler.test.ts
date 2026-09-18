/**
 * The gateway's agent handler: one inbound chat message becomes one orchestrated run, and the reply
 * is the run's own consolidated summary. The runtime is a fake that replays a scripted event
 * stream, so what is under test is the extraction, not the model.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager, SessionManager } from "@trent/core";
import { MemoryGatewayStore, type InboundMessage } from "@trent/core/gateway/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { createAgentHandler, type AgentRuntime } from "./agent-handler.js";

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_gw", at: "2026-09-15T00:00:00.000Z", ...extra } as OrcEvent;
}

const message: InboundMessage = {
  id: "m1",
  platform: "telegram",
  channelId: "555",
  senderId: "555",
  content: "draft the launch note",
  timestamp: "2026-09-15T00:00:00.000Z",
  scope: "dm",
};

interface FakeRuntime extends AgentRuntime {
  calls: Array<{ objective: string; trigger: string | undefined; history: Array<{ role: string; content: string }> }>;
}

function fakeRuntime(events: OrcEvent[]): FakeRuntime {
  const calls: FakeRuntime["calls"] = [];
  return {
    calls,
    run: (objective, options) => {
      calls.push({ objective, trigger: options?.trigger, history: [...(options?.history ?? [])] });
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

describe("createAgentHandler", () => {
  let tempDir: string;
  let deps: { store: MemoryGatewayStore; sessions: SessionManager };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-gateway-handler-"));
    deps = { store: new MemoryGatewayStore(), sessions: new SessionManager(new ConfigManager({ baseDir: tempDir })) };
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs the message text as a manual objective and replies with the run's consolidated summary", async () => {
    const runtime = fakeRuntime([
      ev("run_start", { run: { objective: "draft the launch note" } }),
      ev("consolidate_end", { run: { summary: "Launch note drafted: three paragraphs, one call to action." } }),
      ev("run_done", { run: { status: "completed", summary: "Launch note drafted: three paragraphs, one call to action." } }),
    ]);
    const handler = createAgentHandler(runtime, deps);

    const reply = await handler("ceo", message);

    // The first message on a thread has nothing before it.
    expect(runtime.calls).toEqual([{ objective: "draft the launch note", trigger: "manual", history: [] }]);
    expect(reply).toBe("Launch note drafted: three paragraphs, one call to action.");
  });

  it("a later run_done summary supersedes the consolidate_end one", async () => {
    const runtime = fakeRuntime([
      ev("consolidate_end", { run: { summary: "first brief" } }),
      ev("run_done", { run: { status: "completed", summary: "final brief" } }),
    ]);
    expect(await createAgentHandler(runtime, deps)("ceo", message)).toBe("final brief");
  });

  it("on run_failed the reply is the failure reason carried by the event, nothing invented", async () => {
    const runtime = fakeRuntime([
      ev("run_start"),
      ev("run_failed", { detail: "every model call failed: provider returned 401", run: { status: "failed" } }),
    ]);
    expect(await createAgentHandler(runtime, deps)("ceo", message)).toBe("Run failed: every model call failed: provider returned 401");
  });

  it("a stream that ends with no summary yields silence rather than a made-up line", async () => {
    const runtime = fakeRuntime([ev("run_start"), ev("run_cancelled")]);
    expect(await createAgentHandler(runtime, deps)("ceo", message)).toBeNull();
  });
});

describe("createAgentHandler threads are sessions", () => {
  let tempDir: string;
  let sessions: SessionManager;
  let store: MemoryGatewayStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-gateway-sessions-"));
    sessions = new SessionManager(new ConfigManager({ baseDir: tempDir }));
    store = new MemoryGatewayStore();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function events(summary: string): OrcEvent[] {
    return [ev("run_start"), ev("run_done", { run: { status: "completed", summary } })];
  }

  it("two messages in one thread share a session and the second run sees the first turn", async () => {
    const scripted = fakeRuntime(events("first reply"));
    const seenAtRunStart: string[][] = [];
    const runtime: AgentRuntime = {
      run: (objective, options) => {
        const id = store.snapshot().conversations["slack:C1:171.5"]!;
        seenAtRunStart.push(sessions.getSession(id)!.messages.map((m) => m.content));
        return scripted.run(objective, options);
      },
    };
    const handler = createAgentHandler(runtime, { store, sessions });
    const threaded: InboundMessage = { ...message, platform: "slack", channelId: "C1", threadId: "171.5" };

    await handler("ceo", threaded);
    const first = store.snapshot().conversations["slack:C1:171.5"];
    expect(first).toBeDefined();

    await handler("ceo", { ...threaded, id: "m2", content: "and the follow-up" });
    expect(store.snapshot().conversations["slack:C1:171.5"]).toBe(first);
    expect(seenAtRunStart).toEqual([
      ["draft the launch note"],
      ["draft the launch note", "first reply", "and the follow-up"],
    ]);

    const transcript = sessions.getSession(first!)!.messages;
    expect(transcript.map((m) => [m.role, m.content])).toEqual([
      ["user", "draft the launch note"],
      ["assistant", "first reply"],
      ["user", "and the follow-up"],
      ["assistant", "first reply"],
    ]);
  });

  it("hands the second run the thread's earlier turns, as a message list, not as text in the objective", async () => {
    const runtime = fakeRuntime(events("Three paragraphs, one call to action."));
    const handler = createAgentHandler(runtime, { store, sessions });
    const threaded: InboundMessage = { ...message, platform: "slack", channelId: "C2", threadId: "180.0" };

    await handler("ceo", threaded);
    await handler("ceo", { ...threaded, id: "m2", content: "now shorten it" });

    expect(runtime.calls[0]?.history).toEqual([]);
    expect(runtime.calls[1]?.objective).toBe("now shorten it");
    expect(runtime.calls[1]?.history).toEqual([
      { role: "user", content: "draft the launch note" },
      { role: "assistant", content: "Three paragraphs, one call to action." },
    ]);
  });

  it("does not re-thread an assistant message the user interrupted", async () => {
    const runtime = fakeRuntime(events("complete answer"));
    const handler = createAgentHandler(runtime, { store, sessions });
    const threaded: InboundMessage = { ...message, platform: "slack", channelId: "C3", threadId: "190.0" };

    await handler("ceo", threaded);
    const sessionId = store.snapshot().conversations["slack:C3:190.0"]!;
    sessions.appendMessage(sessionId, {
      role: "assistant",
      content: "half an ans",
      metadata: { status: "interrupted" },
    });

    await handler("ceo", { ...threaded, id: "m2", content: "carry on" });
    expect(runtime.calls[1]?.history.map((m) => m.content)).toEqual(["draft the launch note", "complete answer"]);
  });

  it("a message in a different thread of the same chat gets its own session", async () => {
    const handler = createAgentHandler(fakeRuntime(events("ok")), { store, sessions });
    await handler("ceo", { ...message, platform: "slack", channelId: "C1", threadId: "171.5" });
    await handler("ceo", { ...message, id: "m2", platform: "slack", channelId: "C1", threadId: "172.0" });
    const { conversations } = store.snapshot();
    expect(conversations["slack:C1:171.5"]).toBeDefined();
    expect(conversations["slack:C1:172.0"]).toBeDefined();
    expect(conversations["slack:C1:172.0"]).not.toBe(conversations["slack:C1:171.5"]);
  });

  it("/new rotates the session for that key, runs nothing and replies with silence", async () => {
    const runtime = fakeRuntime(events("ok"));
    const handler = createAgentHandler(runtime, { store, sessions });
    await handler("ceo", message);
    const before = store.snapshot().conversations["telegram:555:root"];

    expect(await handler("ceo", { ...message, id: "m2", content: "/new" })).toBeNull();
    expect(runtime.calls).toHaveLength(1);

    await handler("ceo", { ...message, id: "m3", content: "start over" });
    const after = store.snapshot().conversations["telegram:555:root"];
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(sessions.getSession(after!)!.messages.map((m) => m.content)).toEqual(["start over", "ok"]);
  });
});
