/**
 * The gateway's agent handler: one inbound chat message becomes one orchestrated run, and the reply
 * is the run's own consolidated summary. The runtime is a fake that replays a scripted event
 * stream, so what is under test is the extraction, not the model.
 */

import { describe, expect, it } from "vitest";
import type { InboundMessage } from "@trent/core/gateway/index.js";
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
  calls: Array<{ objective: string; trigger: string | undefined }>;
}

function fakeRuntime(events: OrcEvent[]): FakeRuntime {
  const calls: FakeRuntime["calls"] = [];
  return {
    calls,
    run: (objective, options) => {
      calls.push({ objective, trigger: options?.trigger });
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

describe("createAgentHandler", () => {
  it("runs the message text as a manual objective and replies with the run's consolidated summary", async () => {
    const runtime = fakeRuntime([
      ev("run_start", { run: { objective: "draft the launch note" } }),
      ev("consolidate_end", { run: { summary: "Launch note drafted: three paragraphs, one call to action." } }),
      ev("run_done", { run: { status: "completed", summary: "Launch note drafted: three paragraphs, one call to action." } }),
    ]);
    const handler = createAgentHandler(runtime);

    const reply = await handler("ceo", message);

    expect(runtime.calls).toEqual([{ objective: "draft the launch note", trigger: "manual" }]);
    expect(reply).toBe("Launch note drafted: three paragraphs, one call to action.");
  });

  it("a later run_done summary supersedes the consolidate_end one", async () => {
    const runtime = fakeRuntime([
      ev("consolidate_end", { run: { summary: "first brief" } }),
      ev("run_done", { run: { status: "completed", summary: "final brief" } }),
    ]);
    expect(await createAgentHandler(runtime)("ceo", message)).toBe("final brief");
  });

  it("on run_failed the reply is the failure reason carried by the event, nothing invented", async () => {
    const runtime = fakeRuntime([
      ev("run_start"),
      ev("run_failed", { detail: "every model call failed: provider returned 401", run: { status: "failed" } }),
    ]);
    expect(await createAgentHandler(runtime)("ceo", message)).toBe("Run failed: every model call failed: provider returned 401");
  });

  it("a stream that ends with no summary yields silence rather than a made-up line", async () => {
    const runtime = fakeRuntime([ev("run_start"), ev("run_cancelled")]);
    expect(await createAgentHandler(runtime)("ceo", message)).toBeNull();
  });

  it("every event is handed to the observer, in order, before the reply is produced", async () => {
    const events = [ev("run_start"), ev("step_awaiting_approval", { step: { id: "s1" } }), ev("run_done", { run: { summary: "ok" } })];
    const seen: OrcEvent["kind"][] = [];
    const handler = createAgentHandler(fakeRuntime(events), { observe: (event) => seen.push(event.kind) });
    await handler("ceo", message);
    expect(seen).toEqual(["run_start", "step_awaiting_approval", "run_done"]);
  });
});
