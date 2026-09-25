/**
 * P2-5a item 3: the REPL printed "the SQLite store needs Bun" whenever the store did not open,
 * including under Bun when the generated Prisma client was what was missing. The store module is
 * made to fail to load exactly as Bun 1.4.2 fails on a clone whose client was never generated; the
 * runtime is Bun or Node by `process.versions.bun`. The REPL boots for real to its first prompt.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTheme } from "../../ui/index.js";
import { PROMPT } from "../engine.js";
import { ClassicRepl } from "../index.js";

vi.mock("@trent/core/store/index.js", () => {
  throw Object.assign(new Error("Cannot find module './generated/client' imported from /repo/packages/trent-core/src/store/createStore.ts"), {
    name: "ResolveMessage",
    code: "ERR_MODULE_NOT_FOUND",
  });
});

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

let home = "";
beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-repl-durability-"));
  vi.stubEnv("TRENT_HOME", home);
  // Not a key: it only keeps the REPL out of the degraded first-run path. No turn is sent.
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-not-a-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** Boots the REPL to its first prompt as Bun or as Node and returns what it printed. */
async function bootAs(bun: boolean): Promise<string> {
  const versions = process.versions as Record<string, string | undefined>;
  const saved = versions.bun;
  if (bun) versions.bun = "1.4.2";
  else delete versions.bun;
  try {
    const stdin = new ScriptedStdin();
    const out: string[] = [];
    const repl = new ClassicRepl({
      profile: "durability-test",
      io: { write: (text: string) => void out.push(text), isTTY: false, stdin: stdin as never, exit: () => undefined, theme: createTheme("ansi16"), width: 100 },
    });
    const started = repl.start();
    const deadline = Date.now() + 15_000;
    while (!out.some((chunk) => chunk.includes(PROMPT))) {
      if (Date.now() > deadline) throw new Error(`no prompt appeared:\n${out.join("")}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stdin.emit("end");
    await started;
    // eslint-disable-next-line no-control-regex
    return out.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\s+/g, " ");
  } finally {
    if (saved === undefined) delete versions.bun;
    else versions.bun = saved;
  }
}

describe("the REPL's not-durable line", () => {
  it("under Bun with no generated client names the client and `npm run postinstall`, not Bun", async () => {
    const text = await bootAs(true);
    expect(text).toContain("This session is not durable: the store's client is not generated: run `npm run postinstall`");
    expect(text).not.toMatch(/needs Bun/);
  }, 30_000);

  it("under Node says the store needs Bun and how to run under it", async () => {
    const text = await bootAs(false);
    expect(text).toContain("This session is not durable: the SQLite store needs Bun");
    expect(text).toContain("npm run cli:bun");
  }, 30_000);
});
