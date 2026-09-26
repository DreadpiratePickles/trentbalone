/**
 * [C13] The REPL prints a streamed answer as it arrives (`step_delta`, `solo/events.ts`) and the transcript it
 * leaves is byte for byte the one a non-streamed turn leaves: the answer frame prints only what the deltas did
 * not, a note that confirms streamed words prints nothing twice, and streamed words a frame does not confirm
 * are never lost. The REPL writes whole lines (`index.ts` writeLine), so a streamed line is printed when the
 * model finishes it. The end-to-end half drives `ClassicRepl` in solo mode over a fake gateway that streams
 * 50 tokens 100 ms apart; no model is called.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import { collectCompletion } from "@trent/core/model-gateway/complete.js";
import type { GatewayStreamEvent, GatewayStreamRequest } from "@trent/core/model-gateway/types.js";
import type { OrcEvent, Orchestrator } from "@trent/core/orchestrator/index.js";
import type { SoloGateway } from "@trent/core/solo/types.js";
import { createTheme } from "../../ui/index.js";
import { PROMPT } from "../engine.js";
import { ClassicRepl } from "../index.js";
import { renderTranscript, TranscriptRenderer } from "../render.js";

const theme = createTheme("none");
const STEP = { id: "solo_1-trent", title: "Say the lines", agentRole: "trent" };
const at = "2026-09-26T09:00:00.000Z";
const ev = (kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent => ({ kind, runId: "solo_1", at, ...extra });
const delta = (text: string): OrcEvent => ev("step_delta", { step: { ...STEP, status: "running" }, detail: text });

/** A solo turn's frames, without deltas: what a non-streamed turn emits. */
function turn(answer: string, before: OrcEvent[] = []): OrcEvent[] {
  return [
    ev("run_start", { run: { id: "solo_1", objective: "Say the lines", status: "running" } }),
    ev("step_start", { step: { ...STEP, status: "running" } }),
    ...before,
    ev("step_output", { step: { ...STEP, status: "running", output: answer } }),
    ev("step_end", { step: { ...STEP, status: "completed", costCents: 1 } }),
    ev("run_done", { run: { id: "solo_1", status: "completed", summary: answer } }),
  ];
}

/** The same frames with the answer's deltas inserted after step_start, cut as given. */
function streamedTurn(answer: string, cuts: readonly string[]): OrcEvent[] {
  const frames = turn(answer);
  return [...frames.slice(0, 2), ...cuts.map(delta), ...frames.slice(2)];
}

const bytes = (lines: readonly string[]): string => lines.map((line) => `${line}\n`).join("");

describe("[C13] the transcript renderer and step_delta", () => {
  const ANSWER = "First line of the answer.\nSecond line.\n\nA last paragraph.";
  const CUTS = ["First ", "line of the", " answer.", "\nSecond", " line.\n", "\nA last", " paragraph."];

  it("prints each line as a delta completes it, and the whole is byte-identical to the non-streamed transcript", () => {
    const renderer = new TranscriptRenderer({ theme });
    const printed: string[][] = streamedTurn(ANSWER, CUTS).map((event) => renderer.handle(event));
    // run_start, step_start, then the deltas: a line is printed by the delta that ends it, not before.
    expect(printed.slice(2, 9)).toEqual([[], [], [], ["    First line of the answer."], ["Second line."], [""], []]);
    expect(bytes(renderer.lines)).toBe(bytes(renderTranscript(turn(ANSWER), { theme })));
    expect(bytes(renderer.lines).split(ANSWER.split("\n")[0]!).length - 1).toBe(1);
  });

  it("a note that confirms the streamed words beside a call prints nothing twice", () => {
    const note = ev("step_note", { step: { ...STEP, status: "running" }, detail: "Let me look." });
    const tools = ev("step_output", { step: { ...STEP, status: "running", toolCalls: [{ adapter: "file_ops", action: "read_file {}", status: "completed", summary: "ok" }] } as OrcEvent["step"] });
    const plain = turn("Done.", [note, tools]);
    const streamed = [...plain.slice(0, 2), delta("Let me"), delta(" look."), note, tools, delta("Done."), ...plain.slice(4)];
    expect(bytes(renderTranscript(streamed, { theme }))).toBe(bytes(renderTranscript(plain, { theme })));
  });

  it("an answer the deltas do not lead to is printed whole: streamed words never replace it", () => {
    const lines = renderTranscript(streamedTurn("The real answer.", ["A draft\nthat was", " retracted"]), { theme });
    expect(lines).toContain("    A draft");
    expect(lines).toContain("that was retracted");
    expect(lines).toContain("    The real answer.");
  });

  it("a stream cut by a failure keeps the words it showed, before the failure line", () => {
    const frames = [
      ...turn("unused").slice(0, 2),
      delta("Half an"),
      delta(" answer"),
      ev("step_end", { step: { ...STEP, status: "failed" } }),
      ev("run_failed", { detail: "the provider dropped the connection" }),
    ];
    const lines = renderTranscript(frames, { theme });
    expect(lines.indexOf("    Half an answer")).toBeGreaterThan(-1);
    expect(lines.indexOf("    Half an answer")).toBeLessThan(lines.findIndex((line) => line.includes("Run failed")));
  });
});

// ── ClassicRepl, end to end ─────────────────────────────────────────────────

class ScriptedStdin extends EventEmitter {
  isTTY = true;
  setRawMode(): this { return this; }
  setEncoding(): this { return this; }
  resume(): this { return this; }
  pause(): this { return this; }
}

/** Five lines of ten words: 50 tokens, the first of each later line carrying its newline. */
const TOKENS = Array.from({ length: 50 }, (_, i) => `${i === 0 ? "" : i % 10 === 0 ? "\n" : " "}w${String(i + 1)}`);
const LINES = Array.from({ length: 5 }, (_, l) => Array.from({ length: 10 }, (_, w) => `w${String(l * 10 + w + 1)}`).join(" "));

function fakeGateway(streams: boolean): SoloGateway & { readonly tokenAt: number[] } {
  const tokenAt: number[] = [];
  async function* stream(request: GatewayStreamRequest): AsyncGenerator<GatewayStreamEvent> {
    for (const content of TOKENS) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (request.signal?.aborted) return;
      tokenAt.push(Date.now());
      yield { type: "token", content, provider: "google", model: "gemini-test" };
    }
    yield { type: "usage", provider: "google", model: "gemini-test", modelTier: "sonnet", inputTokens: 100, outputTokens: 50, cachedInputTokens: 0, costCents: 1, estimated: false, priced_as_default: false, unpriced: false };
    yield { type: "finish", reason: "stop", provider: "google", model: "gemini-test" };
  }
  const complete = (request: GatewayStreamRequest) => collectCompletion(stream(request));
  return streams ? { tokenAt, complete, stream } : { tokenAt, complete };
}

let home = "";
const savedHome = process.env.TRENT_HOME;
let profileN = 0;
beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-c13-repl-"));
  process.env.TRENT_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

async function until(predicate: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the REPL");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** One solo turn through the real REPL; every write is kept with the time it was made. */
async function oneTurn(streams: boolean) {
  profileN += 1;
  const profile = `c13-repl-${String(profileN)}`;
  const configManager = new ConfigManager({ profile });
  const config = configManager.loadConfig();
  config.terminal.backend = "local";
  config.egress.enabled = false;
  config.provider = "google";
  config.model = "gemini-test";
  configManager.saveConfig(config);
  const createOrchestrator = (): Orchestrator => ({ ensureCompany: async () => "cmp_c13", run: () => { throw new Error("the fleet must not run in solo mode"); } }) as unknown as Orchestrator;
  const stdin = new ScriptedStdin();
  const writes: Array<{ readonly text: string; readonly at: number }> = [];
  const gateway = fakeGateway(streams);
  const repl = new ClassicRepl({
    profile,
    mode: "solo",
    io: { write: (text) => void writes.push({ text, at: Date.now() }), isTTY: false, stdin: stdin as never, exit: vi.fn(), theme, width: 100 },
    deps: { createOrchestrator, buildAdapters: () => [], solo: { gateway, audit: async () => undefined } },
  });
  const prompts = () => writes.filter((w) => w.text === `${PROMPT}\n`).length;
  const running = repl.start();
  await until(() => prompts() >= 1);
  stdin.emit("data", "say the lines\r");
  await until(() => prompts() >= 2);
  stdin.emit("end");
  await running;
  const from = writes.findIndex((w) => w.text.includes("Objective: say the lines"));
  return { writes: writes.slice(from), tokenAt: gateway.tokenAt };
}

describe("[C13] the REPL in solo mode prints the answer while the model writes it", () => {
  it("50 tokens 100 ms apart: each line is on screen within 300 ms of the token that ends it, before step_end, and the transcript is byte-identical", async () => {
    const streamed = await oneTurn(true);
    const stepEnd = streamed.writes.findIndex((w) => w.text.startsWith("✓ [Trent]"));
    expect(stepEnd).toBeGreaterThan(-1);
    const firstLine = streamed.writes.findIndex((w) => w.text.includes(LINES[0]!));
    expect(firstLine).toBeGreaterThan(-1);
    expect(firstLine).toBeLessThan(stepEnd);
    // Lines 1-4 are ended by the tokens that open lines 2-5 (indexes 10, 20, 30, 40).
    for (let l = 0; l < 4; l++) {
      const write = streamed.writes.find((w) => w.text.includes(LINES[l]!));
      expect(write, `line ${String(l + 1)}`).toBeDefined();
      expect(write!.at - streamed.tokenAt[(l + 1) * 10]!, `line ${String(l + 1)}`).toBeLessThan(300);
    }
    expect(streamed.writes[stepEnd]!.at - streamed.writes[firstLine]!.at).toBeGreaterThan(3_000);
    expect(streamed.writes.map((w) => w.text).join("")).not.toContain('{"answer"');

    const whole = await oneTurn(false);
    expect(streamed.writes.map((w) => w.text).join("")).toBe(whole.writes.map((w) => w.text).join(""));
    expect(whole.writes.map((w) => w.text).join("").split(LINES[0]!).length - 1).toBe(1);
  }, 60_000);
});
