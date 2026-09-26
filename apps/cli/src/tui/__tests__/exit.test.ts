/**
 * [P2-10] The TUI's `/exit` and `/quit` leave the way the REPL's `/exit` does (P2-5a,
 * `../../repl/__tests__/exit.test.ts`): through the session's own way out, which releases this
 * process's writer registration on the profile (`../../repl/__tests__/writer-lock.test.ts`) before
 * the binary exits 0, not a bare `process.exit(0)` from inside the key handler.
 *
 * `runTui` is driven with fake streams and a stand-in orchestrator that is never asked for a run:
 * no model, no provider and no terminal.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import { liveWriters, profileLockPath } from "@trent/core/profile/locks.js";
import { runTui, type TuiOptions } from "../index.js";

/** Keys as Ink reads them: `readable`, then `read()` until it returns null. */
class KeyStdin extends EventEmitter {
  isTTY = true;
  #chunks: string[] = [];
  setRawMode(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  read(): string | null {
    return this.#chunks.shift() ?? null;
  }
  type(text: string): void {
    this.#chunks.push(text);
    this.emit("readable");
  }
}

/** Frames as Ink writes them in debug mode: every write is one whole frame. */
class FrameStdout extends EventEmitter {
  columns = 160;
  rows = 50;
  frames: string[] = [];
  write(frame: string): boolean {
    this.frames.push(frame);
    return true;
  }
  get last(): string {
    return this.frames.at(-1) ?? "";
  }
}

const noRuns = (() => ({
  run: () => {
    throw new Error("the exit test never dispatches a run");
  },
  approve: async () => true,
  reject: async () => true,
})) as unknown as NonNullable<TuiOptions["createOrchestrator"]>;

let home = "";

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-tui-exit-"));
  vi.stubEnv("TRENT_HOME", home);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

async function until(done: () => boolean, what: string, stdout: FrameStdout): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen; the last frame:\n${stdout.last}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the TUI's /exit and /quit", () => {
  for (const command of ["/exit", "/quit"]) {
    it(`${command} releases the writer registration on the way out and returns to the binary, which exits 0`, async () => {
      const profile = "tui-exit";
      const profileDir = new ConfigManager({ profile }).getProfileDir();
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const stdin = new KeyStdin();
      const stdout = new FrameStdout();
      let returned = false;
      const session = runTui({
        profile,
        createOrchestrator: noRuns,
        renderOptions: { stdin: stdin as never, stdout: stdout as never, stderr: stdout as never, debug: true, exitOnCtrlC: false, patchConsole: false },
      }).then(() => {
        returned = true;
      });

      await until(() => stdout.last.includes("FLEET WORKSPACE"), "the first frame", stdout);
      // A live writer on its profile while it is up, as the REPL is, so maintenance refuses meanwhile.
      expect(liveWriters(profileDir)).toEqual([expect.objectContaining({ pid: process.pid, label: "tui" })]);

      stdin.type(command);
      await until(() => stdout.last.includes(command), "the typed command", stdout);
      stdin.type("\r");
      await until(() => returned, "runTui returning", stdout);
      await session;

      // The key handler does not end the process; the binary does, once `runTui` returns (../../index.ts).
      expect(exit).not.toHaveBeenCalled();
      expect(liveWriters(profileDir)).toEqual([]);
      expect(fs.existsSync(profileLockPath(profileDir, "writer"))).toBe(false);
    }, 30_000);
  }
});
