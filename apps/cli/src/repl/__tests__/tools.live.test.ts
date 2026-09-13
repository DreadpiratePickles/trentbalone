/**
 * The live proof for the wired REPL: the actual `ClassicRepl`, scripted stdin, the default
 * toolsets, the session egress proxy, and a real seat on gemini-3.5-flash-lite choosing
 * `file_ops` to answer "print the name field of package.json". The transcript is printed as
 * evidence. Opt in with TRENT_TEST_LIVE=1; the key comes from <repo>/gem.env and is never printed.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigManager } from "@trent/core";
import { createTheme } from "../../ui/index.js";
import { PROMPT } from "../engine.js";
import { ClassicRepl } from "../index.js";
import type { EgressHandle } from "../tools.js";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const LIVE = process.env.TRENT_TEST_LIVE === "1";
const LIVE_MODEL = process.env.GOOGLE_MODEL_DEFAULT ?? "gemini-3.5-flash-lite";

function readGeminiKey(): string | undefined {
  const fromEnv = process.env.GEMINI_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    for (const line of readFileSync(path.join(REPO_ROOT, "gem.env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/.exec(line);
      if (match) {
        const value = match[1]!.trim().replace(/^["']|["']$/g, "");
        if (value !== "") return value;
      }
    }
  } catch {
    /* no gem.env */
  }
  return undefined;
}
const GEMINI_API_KEY = readGeminiKey();
if (LIVE && GEMINI_API_KEY === undefined) console.error("[repl tools live] SKIPPED: no GEMINI_API_KEY in <repo>/gem.env. A skip is NOT a pass.");

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

function atPrompt(out: string[]): boolean {
  return out.some((chunk) => chunk === `${PROMPT}\n`);
}

async function until(predicate: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the REPL");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const ENV_KEYS = ["NODE_ENV", "DATABASE_URL", "REDIS_URL", "TRENT_QUEUE_FALLBACK", "TRENT_EVAL_SYNC_QUEUE",
  "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;
const savedEnv: Record<string, string | undefined> = {};
let home = "";
const savedHome = process.env.TRENT_HOME;

describe.skipIf(!LIVE || GEMINI_API_KEY === undefined)("the wired REPL, live on gemini-3.5-flash-lite", () => {
  beforeAll(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = "production";
    home = mkdtempSync(path.join(os.tmpdir(), "trent-tools-live-"));
    process.env.TRENT_HOME = home;
    const manager = new ConfigManager({ profile: "live" });
    const config = manager.loadConfig();
    config.provider = "google";
    config.model = LIVE_MODEL;
    manager.saveConfig(config);
    // The profile's .env is where the REPL reads the key from; the value never reaches stdout.
    writeFileSync(manager.getSecretsPath(), `GEMINI_API_KEY=${GEMINI_API_KEY}\n`, { mode: 0o600 });
  });
  afterAll(() => {
    if (savedHome === undefined) delete process.env.TRENT_HOME;
    else process.env.TRENT_HOME = savedHome;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("reads package.json through file_ops and reports the real name; the proxy listens during and not after", async () => {
    const objective = "print the name field of package.json";
    const expectedName = (JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { name: string }).name;
    const handles: EgressHandle[] = [];
    const stdin = new ScriptedStdin();
    const out: string[] = [];
    const repl = new ClassicRepl({
      profile: "live",
      io: { write: (text) => void out.push(text), isTTY: false, stdin: stdin as never, exit: () => undefined, theme: createTheme("none"), width: 100 },
      deps: {
        workspace: REPO_ROOT,
        startEgress: async (input) => {
          const { startEgressProxy } = await import("../tools.js");
          const handle = await startEgressProxy(input);
          handles.push(handle);
          return handle;
        },
      },
    });
    const started = repl.start();
    await until(() => atPrompt(out), 60_000);
    expect(handles[0]?.isListening()).toBe(true);

    stdin.emit("data", `${objective}\r`);
    await until(() => out.some((chunk) => chunk.includes("Run complete") || chunk.includes("Run failed")), 240_000);
    stdin.emit("data", "/tools\r");
    await until(() => out.some((chunk) => chunk.includes("TOOLS")), 10_000);
    stdin.emit("end");
    await started;

    const transcript = out.join("").replace(new RegExp(GEMINI_API_KEY!, "g"), "<redacted>");
    console.log(`\n===== live REPL transcript (${LIVE_MODEL}) =====\n${transcript}\n===== end =====`);

    expect(handles[0]?.isListening()).toBe(false);
    expect(transcript).toContain("Run complete");
    expect(transcript).toMatch(/file_ops[^\n]*read_file/);
    expect(transcript).toContain(expectedName);
    expect(transcript).not.toContain("<redacted>");
  }, 360_000);
});
