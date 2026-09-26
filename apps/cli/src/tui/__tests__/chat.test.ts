/**
 * [C13] The chat pane appends a streamed answer as it arrives and shows it once when it lands.
 *
 * `streamedAnswer` is the fold a pane keeps over the run's frames: each `step_delta` appends its text, and any
 * other frame ends the live text (the model call it belonged to is over; the answer itself arrives as a message
 * from `run_done`, `../events.ts`). `Chat` draws the live text after the messages. Rendered by Ink in debug
 * mode into a fake stdout: every write is one whole frame. No model, no terminal.
 */
import { EventEmitter } from "node:events";
import React from "react";
import { render } from "ink";
import { describe, expect, it } from "vitest";
import type { SessionData } from "@trent/core";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { Chat, streamedAnswer } from "../Chat.js";

class FrameStdout extends EventEmitter {
  columns = 120;
  rows = 40;
  frames: string[] = [];
  write(frame: string): boolean {
    this.frames.push(frame);
    return true;
  }
  get last(): string {
    return this.frames.at(-1) ?? "";
  }
}

class QuietStdin extends EventEmitter {
  isTTY = true;
  setRawMode(): this { return this; }
  setEncoding(): this { return this; }
  ref(): this { return this; }
  unref(): this { return this; }
  resume(): this { return this; }
  pause(): this { return this; }
  read(): null { return null; }
}

const at = "2026-09-26T09:00:00.000Z";
const step = { id: "solo_1-trent", title: "Plan", agentRole: "trent", status: "running" as const };
const ev = (kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent => ({ kind, runId: "solo_1", at, ...extra });

function session(messages: SessionData["messages"] = []): SessionData {
  return { schemaVersion: 1, id: "s1", title: "t", created_at: at, updated_at: at, agent: "trent", model: "m", provider: "p", messages, status: "active", total_cost_cents: 0, total_cost: 0, total_duration_ms: 0 };
}

const count = (frame: string, text: string): number => frame.split(text).length - 1;

describe("[C13] the chat pane and a streamed answer", () => {
  it("folds deltas into the live text and ends it on the next frame of any other kind", () => {
    let live = "";
    const frames = [
      ev("step_start", { step }),
      ev("step_delta", { step, detail: "Let me" }),
      ev("step_delta", { step, detail: " look." }),
      ev("step_note", { step, detail: "Let me look." }),
      ev("step_delta", { step, detail: "Five" }),
      ev("step_delta", { step, detail: " days." }),
    ];
    const seen = frames.map((event) => (live = streamedAnswer(live, event)));
    expect(seen).toEqual(["", "Let me", "Let me look.", "", "Five", "Five days."]);
    expect(streamedAnswer(live, ev("step_output", { step: { ...step, output: "Five days." } }))).toBe("");
    expect(streamedAnswer("Five", ev("run_failed", { detail: "boom" }))).toBe("");
  });

  it("draws the live text as it grows, and the landed answer once", async () => {
    const stdout = new FrameStdout();
    const options = { stdout: stdout as never, stdin: new QuietStdin() as never, stderr: stdout as never, debug: true, exitOnCtrlC: false, patchConsole: false };
    const onSendMessage = (): void => undefined;
    const app = render(React.createElement(Chat, { session: session(), onSendMessage, isActive: false, streaming: "The oak tables" }), options);
    expect(stdout.last).toContain("The oak tables");
    app.rerender(React.createElement(Chat, { session: session(), onSendMessage, isActive: false, streaming: "The oak tables ship on Tuesday." }));
    expect(stdout.last).toContain("The oak tables ship on Tuesday.");
    const landed = session([{ id: "m1", role: "assistant", agent: "trent", content: "The oak tables ship on Tuesday.", timestamp: at }]);
    app.rerender(React.createElement(Chat, { session: landed, onSendMessage, isActive: false, streaming: "" }));
    expect(count(stdout.last, "The oak tables ship on Tuesday.")).toBe(1);
    app.unmount();
  });
});
