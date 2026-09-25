/**
 * The REPL is a live writer on its profile from boot to exit (packages/trent-core/src/profile/
 * locks.ts): the maintenance commands refuse while it is up. It registers before it opens the
 * conversation, because the session transcript is the first thing it writes, and it releases on
 * the way out. A recording orchestrator stands in for the model; no provider, Docker or proxy.
 */

import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "@trent/core";
import type { Orchestrator } from "@trent/core/orchestrator/index.js";
import { liveWriters } from "@trent/core/profile/locks.js";
import { createTheme } from "../../ui/index.js";
import { PROMPT } from "../engine.js";
import { ClassicRepl } from "../index.js";

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
const savedHome = process.env.TRENT_HOME;

beforeAll(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "trent-repl-writer-"));
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

describe("the REPL and the profile's writers", () => {
  it("is registered as a writer labelled repl while it is up, and released when stdin ends", async () => {
    const profile = "writer-lock";
    const configManager = new ConfigManager({ profile });
    const config = configManager.loadConfig();
    config.terminal.backend = "local";
    config.egress.enabled = false;
    configManager.saveConfig(config);

    const stdin = new ScriptedStdin();
    const out: string[] = [];
    const repl = new ClassicRepl({
      profile,
      io: { write: (text) => void out.push(text), isTTY: false, stdin: stdin as never, exit: vi.fn(), theme: createTheme("none"), width: 80 },
      deps: {
        createOrchestrator: (() =>
          ({
            ensureCompany: async () => "cmp_writer",
            run: () => Object.assign((async function* () {})(), { runId: "r", started: Promise.resolve("r"), cancel: async () => true }),
            snapshot: async () => undefined,
            approve: async () => true,
            reject: async () => true,
          }) as unknown as Orchestrator) as never,
        buildAdapters: () => [],
        probeDocker: async () => ({ daemon: false, imagePresent: false }),
      },
    });
    const started = repl.start();
    await until(() => out.some((chunk) => chunk === `${PROMPT}\n`));
    expect(liveWriters(configManager.getProfileDir())).toEqual([expect.objectContaining({ pid: process.pid, label: "repl" })]);
    stdin.emit("end");
    await started;
    expect(liveWriters(configManager.getProfileDir())).toEqual([]);
  }, 60_000);
});
