/**
 * [L0-3] `trent setup --provider ollama --pull`: the CLI hands `--pull` to the wizard, and the two
 * local stops (`runtime-unreachable`, `model-not-pulled`) keep the setup contract: exit 3, and under
 * `--json` exactly one JSON document on stdout carrying the reason.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT } from "@trent/core/errors/index.js";
import type { SetupSummary } from "../context.js";
import { runCli } from "../index.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-setup-local-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("[L0-3] trent setup on a local provider", () => {
  it("passes --provider, --model and --pull through to the wizard", async () => {
    let seen: Record<string, unknown> | undefined;
    const done: SetupSummary = { mode: "quick", success: true, message: "Quick setup complete.", secretsConfigured: [] };
    const result = await runCli(["setup", "--provider", "ollama", "--model", "qwen3.5:9b", "--pull", "--json"], {
      overrides: { runSetup: async (_mode, opts) => ((seen = opts), done) },
    });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(seen).toMatchObject({ provider: "ollama", model: "qwen3.5:9b", pull: true });
  });

  it("model-not-pulled and runtime-unreachable exit 3 with one JSON document naming the reason", async () => {
    for (const reason of ["model-not-pulled", "runtime-unreachable"] as const) {
      const summary: SetupSummary = { mode: "quick", success: false, reason, message: "Run: ollama pull qwen3.6:27b", secretsConfigured: [] };
      const result = await runCli(["setup", "--provider", "ollama", "--json"], { overrides: { runSetup: async () => summary } });
      expect(result.exitCode, reason).toBe(EXIT.CONFIG);
      const doc = JSON.parse(result.stdout) as SetupSummary;
      expect(doc.reason, reason).toBe(reason);
      expect(doc.success, reason).toBe(false);
    }
  });
});
