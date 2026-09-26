/**
 * [S3] The two REPL affordances S2 left, at the runner (item 6).
 *
 * 1. A park left by a killed REPL session is resumed by the next launch's `/resume`: the runner's
 *    `resume` re-raises the gate, the REPL opens the card and blocks on it, and a yes taken while the
 *    reader holds that gate continues the SAME stream to the answer (as `drive` already does for a
 *    gate it raised itself). Before, the stream ended at the gate and the yes was lost to it.
 * 2. A solo answer carries the run's cost, so the stored message has `cost_cents` and the session's
 *    `total_cost_cents` (what `trent sessions`, `/sessions` and the `-c` ticker read) is the meter's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../config/ConfigManager.js";
import { SessionManager } from "../sessions/SessionManager.js";
import { FIXED_NOW, collect, fakeAdapter, fakeMemory, fakeMeter, kinds, memoryState, scriptedGateway, sequentialIds, toolCall } from "./fakes.test-helpers.js";
import { createSoloRunner } from "./runner.js";
import { memorySoloSession, profileSoloSession } from "./session-store.js";
import type { SoloSession, SoloStateStore } from "./types.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-solo-s3-repl-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const POST = 'social_post {"platform": "bluesky", "text": "Autumn catalogue is out."}';

function runnerOn(script: string[], session: SoloSession, options: { state?: SoloStateStore; centsPerCall?: number } = {}) {
  const social = fakeAdapter({ name: "social", tools: ["social_post"], approval: () => true });
  const runner = createSoloRunner({
    gateway: scriptedGateway(script),
    tools: { adapters: [social] },
    session,
    memory: fakeMemory().memory,
    meter: fakeMeter({ centsPerCall: options.centsPerCall ?? 1 }),
    now: FIXED_NOW,
    newId: sequentialIds(),
    ...(options.state === undefined ? {} : { state: options.state, sessionId: "sess_resume" }),
  });
  return { runner, social };
}

describe("[S3] /resume: a yes taken while the reader holds the re-raised gate continues the same stream", () => {
  it("after a restart, resume re-raises the gate, and an approve before the next pull runs the call to the answer", async () => {
    const session = memorySoloSession();
    const state = memoryState();
    const killed = runnerOn([toolCall(POST)], session, { state });
    expect(kinds(await collect(killed.runner.run({ objective: "Announce the catalogue" }))).at(-1)).toBe("run_awaiting_approval");

    const next = runnerOn(["Posted."], session, { state });
    const [park] = next.runner.parked();
    const seen: string[] = [];
    // The REPL's shape: read the gate frame, answer the card, then pull again.
    for await (const event of next.runner.resume(park?.runId ?? "")) {
      seen.push(event.kind);
      if (event.kind === "run_awaiting_approval") expect(await next.runner.approve(park?.runId ?? "", park?.stepId ?? "")).toBe(true);
    }
    expect(seen).toEqual(["step_awaiting_approval", "run_awaiting_approval", "step_approved", "step_output", "step_output", "step_end", "run_done"]);
    expect(next.social.calls).toHaveLength(1);
    expect(next.runner.parked()).toEqual([]);
  });
});

describe("[S3] a solo answer carries the run's cost into the session", () => {
  it("stores cost_cents, tokens and the model on the answer, and the session total adds it up", async () => {
    const sessions = new SessionManager(new ConfigManager({ baseDir: dir }));
    const id = sessions.startSession("trent", "gemini-test", "google").id;
    const answering = createSoloRunner({
      gateway: scriptedGateway(["The launch is Tuesday.", "Still Tuesday."]),
      tools: { adapters: [] },
      session: profileSoloSession(sessions, id),
      memory: fakeMemory().memory,
      meter: fakeMeter({ centsPerCall: 3 }),
      now: FIXED_NOW,
      newId: sequentialIds(),
    });
    await collect(answering.run({ objective: "When is the launch?" }));
    await collect(answering.run({ objective: "Sure?" }));

    const stored = new SessionManager(new ConfigManager({ baseDir: dir })).getSession(id);
    const answers = (stored?.messages ?? []).filter((message) => message.role === "assistant");
    expect(answers.map((message) => message.metadata?.cost_cents)).toEqual([3, 3]);
    expect(answers[0]?.metadata).toMatchObject({ tokens_total: 120, model: "gemini-test" });
    expect(stored?.total_cost_cents).toBe(6);
  });
});
