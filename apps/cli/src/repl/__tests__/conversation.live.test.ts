/**
 * Phase A live proof — a REAL two-turn conversation through the wired REPL.
 *
 * The fast conversation test (`conversation.test.ts`) proves the ENGINE hands turn two the turn-one
 * messages, against a recording runner. It cannot prove the other half: that the threaded transcript
 * survives the whole road — `ClassicRepl` -> `createHeadlessRuntime` -> `createOrchestrator` ->
 * the fleet-memory prelude's `conversation` block -> the seat prompt -> a real model — and comes
 * back as an answer that could only have been produced by reading turn one. That is what this
 * suite does, on the real provider, and it is why a skip here is NOT a pass.
 *
 * Four claims, one session:
 *   1. the run behind turn two is HANDED turn one's user line and turn one's own answer
 *      (`OrchestratorRunOptions.history`), recorded off a pass-through orchestrator factory;
 *   2. turn two answers with a token that appears NOWHERE in turn two's own input, only in turn one;
 *   3. the profile's session file holds both turns, in order, as user/assistant pairs;
 *   4. a FRESH `ClassicRepl` started with `--continue` recaps them before its first prompt.
 *
 * Claim 1 is not decoration. Measured here (2026-09-18): with `history` stripped from every run and
 * everything else identical, turn two STILL answered with the token — the app's own company memory
 * and the cross-agent recall block carry the previous turn as well. So the content assertion alone
 * cannot say the transcript was threaded; the structural assertion is what pins that down, and the
 * pair together is the proof.
 *
 * Gated like every live suite: `TRENT_TEST_LIVE=1` AND a key in `GEMINI_API_KEY` or <repo>/gem.env.
 * The key is read into `process.env` for the run and never written to disk, never logged, and the
 * transcript printed as evidence is asserted not to contain it.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigManager, SessionManager } from "@trent/core";
import { createOrchestrator as realCreateOrchestrator } from "@trent/core/orchestrator/index.js";
import type { OrchestratorRunOptions } from "@trent/core/orchestrator/index.js";
import { createTheme } from "../../ui/index.js";
import { PROMPT } from "../engine.js";
import { ClassicRepl } from "../index.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const LIVE_MODEL = process.env.GOOGLE_MODEL_DEFAULT ?? "gemini-3.5-flash-lite";
const PROFILE = "live-conversation";

/** Seeded in turn one, absent from turn two's input: the only way to say it is to have read turn one. */
const TOKEN = "ZEPHYR-7712";
const TURN_ONE = `Remember this code word for later: ${TOKEN}. Answer with exactly the line CODEWORD=${TOKEN} and nothing else. Plan one step.`;
const TURN_TWO =
  "Repeat the code word I gave you earlier in this conversation. Answer with exactly one line, CODEWORD= followed by that code word, and nothing else. Plan one step.";

function readGeminiKey(): string | undefined {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  try {
    for (const line of readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/.exec(line);
      if (match === null) continue;
      const value = match[1]!.trim().replace(/^["']|["']$/g, "");
      if (value !== "") return value;
    }
  } catch {
    /* no gem.env on this machine: the suite skips, loudly */
  }
  return undefined;
}

const GEMINI_API_KEY = readGeminiKey();
const LIVE = process.env.TRENT_TEST_LIVE === "1" && GEMINI_API_KEY !== undefined;
if (!LIVE) {
  console.error(
    "[repl conversation.live] SKIPPED: needs TRENT_TEST_LIVE=1 and GEMINI_API_KEY (env or <repo>/gem.env). " +
      "This suite is the proof that turn two really reads turn one over a real model; a skip is NOT a pass.",
  );
}

class ScriptedStdin extends EventEmitter {
  isTTY = false;
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

interface Session {
  repl: ClassicRepl;
  stdin: ScriptedStdin;
  out: string[];
}

/** Every run this session launched, exactly as the REPL asked for it. Nothing is altered. */
const runOptions: OrchestratorRunOptions[] = [];

const ENV_KEYS = [
  "NODE_ENV",
  "DATABASE_URL",
  "REDIS_URL",
  "TRENT_QUEUE_FALLBACK",
  "TRENT_EVAL_SYNC_QUEUE",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "MISTRAL_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_MODEL_FAST",
  "GOOGLE_MODEL_DEFAULT",
  "GOOGLE_MODEL_STRONG",
  "MODEL_PREFERRED_PROVIDER",
  "MODEL_ALLOWED_PROVIDERS",
] as const;
const savedEnv: Record<string, string | undefined> = {};
const savedHome = process.env.TRENT_HOME;

let home = "";
let workspace = "";

function prompts(out: readonly string[]): number {
  return out.filter((chunk) => chunk === `${PROMPT}\n`).length;
}

function session(options: { continueSession?: boolean } = {}): Session {
  const stdin = new ScriptedStdin();
  const out: string[] = [];
  const repl = new ClassicRepl({
    profile: PROFILE,
    ...(options.continueSession === true ? { continueSession: true } : {}),
    io: {
      write: (text: string) => void out.push(text),
      isTTY: false,
      stdin: stdin as never,
      exit: () => undefined,
      theme: createTheme("none"),
      width: 400,
    },
    // An empty workspace: no repo instruction files ride into the prompt, so the transcript is
    // the only thing turn two could have read the code word from.
    deps: {
      workspace,
      // The REAL orchestrator, observed: every run's options are recorded and passed on unchanged,
      // so claim 1 is read off the same call the model ran on rather than off a double.
      createOrchestrator: (config) => {
        const real = realCreateOrchestrator(config);
        return {
          ...real,
          run: (options) => {
            runOptions.push(options);
            return real.run(options);
          },
        };
      },
    },
  });
  return { repl, stdin, out };
}

/**
 * Waits for the REPL to reach its Nth prompt. A live critic may escalate a step onto a founder
 * gate; answering it with `y` is what a human would do, and the count is reported as evidence
 * rather than hidden.
 */
async function toPrompt(s: Session, want: number, ms: number, approvals: { count: number }): Promise<void> {
  const deadline = Date.now() + ms;
  while (prompts(s.out) < want) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for prompt ${want}; transcript so far:\n${s.out.join("")}`);
    }
    const asked = s.out.join("").split("APPROVAL REQUIRED").length - 1;
    if (asked > approvals.count) {
      approvals.count = asked;
      s.stdin.emit("data", "y");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!LIVE)("a two-turn REPL conversation, live on the real model", () => {
  const approvals = { count: 0 };
  /** Everything the REPL wrote from the moment turn two was submitted. */
  let turnTwoOutput = "";
  let firstOutput = "";
  /** The `--continue` recap: what a fresh REPL printed before its first prompt. */
  let recap = "";
  let messages: ReadonlyArray<{ role: string; content: string; metadata?: { cost_cents?: number } }> = [];
  let totalCents = 0;
  let wallMs = 0;

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Not `test`: vitest's default disables the queue fallback on its own, which would make the
    // standalone contract vacuous here. Same choice as the other live suites.
    process.env.NODE_ENV = "production";
    process.env.GEMINI_API_KEY = GEMINI_API_KEY;
    home = mkdtempSync(path.join(os.tmpdir(), "trent-conv-live-home-"));
    workspace = mkdtempSync(path.join(os.tmpdir(), "trent-conv-live-ws-"));
    process.env.TRENT_HOME = home;

    const manager = new ConfigManager({ profile: PROFILE });
    const config = manager.loadConfig();
    config.provider = "google";
    config.model = LIVE_MODEL;
    // The proof is the conversation, not the tools: no toolsets, no proxy, no sandbox. Fewer
    // tokens per seat call, and nothing on the road that a missing Docker daemon could break.
    config.toolsets = [];
    config.disabled_toolsets = [];
    config.terminal.backend = "local";
    config.egress.enabled = false;
    manager.saveConfig(config);

    const started = Date.now();
    const s = session();
    const running = s.repl.start();
    await toPrompt(s, 1, 120_000, approvals);

    s.stdin.emit("data", `${TURN_ONE}\r`);
    await toPrompt(s, 2, 420_000, approvals);
    firstOutput = s.out.join("");
    const afterTurnOne = s.out.length;

    s.stdin.emit("data", `${TURN_TWO}\r`);
    await toPrompt(s, 3, 420_000, approvals);
    turnTwoOutput = s.out.slice(afterTurnOne).join("");
    s.stdin.emit("end");
    await running;
    wallMs = Date.now() - started;

    const stored = new SessionManager(new ConfigManager({ profile: PROFILE })).listSessions();
    messages = stored[0]?.messages ?? [];
    totalCents = stored[0]?.total_cost_cents ?? 0;

    // A fresh process would do exactly this: a new REPL over the same profile, with --continue.
    // Nothing is typed, so no model call is made; the recap is everything before the first prompt.
    const resumed = session({ continueSession: true });
    const resuming = resumed.repl.start();
    await toPrompt(resumed, 1, 120_000, approvals);
    const firstPrompt = resumed.out.indexOf(`${PROMPT}\n`);
    recap = resumed.out.slice(0, firstPrompt < 0 ? resumed.out.length : firstPrompt).join("");
    resumed.stdin.emit("end");
    await resuming;

    const redacted = `${firstOutput}${turnTwoOutput}`.replace(new RegExp(GEMINI_API_KEY!, "g"), "<redacted>");
    console.error(
      `\n===== live two-turn REPL transcript (${LIVE_MODEL}) =====\n${redacted}\n===== recap after --continue =====\n${recap}\n` +
        `===== end: ${totalCents} cent(s), ${wallMs} ms, ${approvals.count} approval(s) answered =====`,
    );
  }, 900_000);

  afterAll(() => {
    if (savedHome === undefined) delete process.env.TRENT_HOME;
    else process.env.TRENT_HOME = savedHome;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const dir of [home, workspace]) if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("the run behind turn two was handed turn one's line and turn one's answer", () => {
    expect(runOptions.map((options) => options.objective)).toEqual([TURN_ONE, TURN_TWO]);
    // Turn one has nothing to refer to.
    expect(runOptions[0]?.history ?? []).toEqual([]);
    const threaded = runOptions[1]?.history ?? [];
    expect(threaded, "the transcript threaded into turn two").toHaveLength(2);
    expect(threaded[0]).toEqual({ role: "user", content: TURN_ONE });
    expect(threaded[1]?.role).toBe("assistant");
    // The assistant turn threaded is turn one's OWN answer, byte for byte with what was persisted.
    expect(threaded[1]?.content).toBe(messages[1]?.content);
    expect((threaded[1]?.content ?? "").trim()).not.toBe("");
  });

  it("turn two answers with the code word only turn one carried", () => {
    // The assertion is on CONTENT, not on the absence of an error: TURN_TWO never contains the
    // token, so an answer that carries it can only have come from the threaded transcript.
    expect(TURN_TWO).not.toContain(TOKEN);
    expect(turnTwoOutput, "turn two's own output").toContain(TOKEN);
    // The two shapes a model with no memory of turn one produces.
    expect(turnTwoOutput).not.toMatch(/CODEWORD=<[^>]*>/);
    expect(turnTwoOutput).not.toContain("Trent proxy response");
  });

  it("turn one really ran on the model, and both turns completed", () => {
    expect(firstOutput).toContain(TOKEN);
    expect(firstOutput).not.toContain("DEGRADED MODE");
    expect(turnTwoOutput).not.toContain("Run failed");
  });

  it("the session file holds both turns, in order", () => {
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(messages[0]?.content).toBe(TURN_ONE);
    expect(messages[2]?.content).toBe(TURN_TWO);
    expect((messages[1]?.content ?? "").trim()).not.toBe("");
    expect((messages[3]?.content ?? "").trim()).not.toBe("");
    // Integer cents, and a real run costs something.
    expect(Number.isInteger(totalCents)).toBe(true);
    expect(totalCents).toBeGreaterThan(0);
  });

  it("--continue on a fresh REPL recaps both turns before its first prompt", () => {
    expect(recap).toContain("Resuming session");
    expect(recap).toContain(TOKEN);
    expect(recap).toContain(TURN_TWO.slice(0, 40));
  });

  it("the key never reaches the transcript", () => {
    expect(firstOutput).not.toContain(GEMINI_API_KEY!);
    expect(turnTwoOutput).not.toContain(GEMINI_API_KEY!);
    expect(recap).not.toContain(GEMINI_API_KEY!);
  });
});
