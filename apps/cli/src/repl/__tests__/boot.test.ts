/**
 * The boot sequence runs before the first prompt (ui/boot.ts, wired in repl/index.ts).
 *
 * Ctrl+C during the boot is a clean exit with code 130 and no prompt is ever shown; any other
 * key skips to the final frame and the REPL proceeds to its prompt.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTheme } from "../../ui/index.js";
import { PROMPT } from "../engine.js";
import { ClassicRepl } from "../index.js";

class ScriptedStdin extends EventEmitter {
  isTTY = true;
  raw = false;
  setRawMode(mode: boolean): this {
    this.raw = mode;
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

let home = "";
const savedHome = process.env.TRENT_HOME;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-boot-"));
  process.env.TRENT_HOME = home;
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.TRENT_HOME;
  else process.env.TRENT_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

function session(): { repl: ClassicRepl; stdin: ScriptedStdin; out: string[]; exit: ReturnType<typeof vi.fn> } {
  const stdin = new ScriptedStdin();
  const out: string[] = [];
  const exit = vi.fn();
  const repl = new ClassicRepl({
    profile: "boot-test",
    io: {
      write: (text: string) => void out.push(text),
      isTTY: true,
      stdin: stdin as never,
      exit: (code: number) => void exit(code),
      theme: createTheme("ansi16"),
      width: 80,
    },
  });
  return { repl, stdin, out, exit };
}

describe("the boot sequence before the first prompt", () => {
  it("Ctrl+C at 100ms exits 130 without ever showing a prompt", async () => {
    const s = session();
    setTimeout(() => s.stdin.emit("data", "\x03"), 100);
    await s.repl.start();

    expect(s.exit).toHaveBeenCalledWith(130);
    expect(s.out.some((chunk) => chunk.includes(PROMPT))).toBe(false);
  }, 20_000);

  it("any other key skips the animation and the REPL proceeds to its prompt", async () => {
    const s = session();
    setTimeout(() => s.stdin.emit("data", "x"), 100);
    const started = s.repl.start();

    const deadline = Date.now() + 15_000;
    while (!s.out.some((chunk) => chunk.includes(PROMPT))) {
      if (Date.now() > deadline) throw new Error("no prompt appeared");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    s.stdin.emit("end");
    await started;

    expect(s.exit).not.toHaveBeenCalledWith(130);
    // The final banner frame is on screen before the prompt: the OPERATING state.
    const everything = s.out.join("");
    expect(everything.indexOf("OPERATING")).toBeGreaterThan(-1);
    expect(everything.indexOf("OPERATING")).toBeLessThan(everything.indexOf(PROMPT));
  }, 20_000);
});
