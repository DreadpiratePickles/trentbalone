/**
 * [C2] `brain_read`: the tool that turns a signpost in the stable tier into a file body.
 *
 * It is READ-ONLY and path-traversal protected. The paths it is asked for come from a model, which
 * means they come, transitively, from whatever the model has read — so the guard is the whole
 * point of the tool and gets most of the test.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createBrain, type BrainExec } from "../../fleet-memory/brain.js";
import { BRAIN_READ_ADAPTER_NAME, createBrainReadAdapter } from "./brain-read.js";

let profileDir: string;
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });

beforeEach(() => {
  profileDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-brain-read-")));
  const brain = createBrain({ profileDir, exec: noGit, now: () => new Date("2026-09-18T09:00:00.000Z") });
  brain.ensure();
  brain.recordDecision({ title: "Sales is the ninth seat", body: "browser becomes a toolset every seat may use.", writer: "human" });
  fs.writeFileSync(path.join(profileDir, "config.yaml"), "provider: gemini", "utf8");
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

const adapter = (): ReturnType<typeof createBrainReadAdapter> => createBrainReadAdapter({ profileDir });

describe("brain_read", () => {
  it("returns the body of a listed file", async () => {
    const record = await adapter().execute('brain_read {"path": "decisions/2026-09-18-sales-is-the-ninth-seat.md"}', {});
    expect(record.status).toBe("completed");
    expect(record.summary).toContain("browser becomes a toolset every seat may use.");
  });

  it("refuses every path that leaves the brain, and never reads the file", async () => {
    const outside = [
      "../config.yaml",
      "../../etc/passwd",
      "/etc/passwd",
      "decisions/../../config.yaml",
      "decisions/../../../../../../etc/hosts",
    ];
    for (const bad of outside) {
      const record = await adapter().execute(`brain_read {"path": ${JSON.stringify(bad)}}`, {});
      expect(record.status).toBe("blocked");
      expect(record.summary).not.toContain("provider: gemini");
    }
  });

  it("refuses a symlink that points out of the brain", async () => {
    const link = path.join(profileDir, "brain", "escape.md");
    fs.symlinkSync(path.join(profileDir, "config.yaml"), link);
    const record = await adapter().execute('brain_read {"path": "escape.md"}', {});
    expect(record.summary).not.toContain("provider: gemini");
    expect(["blocked", "failed"]).toContain(record.status);
  });

  it("says so for a file that is not there, and lists nothing it cannot read", async () => {
    const record = await adapter().execute('brain_read {"path": "decisions/no-such-decision.md"}', {});
    expect(record.status).toBe("failed");
    expect(record.summary).toContain("no-such-decision.md");
  });

  it("is a read-only adapter: it advertises one action and writes nothing", async () => {
    const tool = adapter();
    expect(tool.name).toBe(BRAIN_READ_ADAPTER_NAME);
    expect(tool.scopes).toContain("memory:read");
    expect(tool.scopes).not.toContain("memory:write");
    const before = fs.readdirSync(path.join(profileDir, "brain", "decisions"));
    await tool.execute('brain_read {"path": "system/identity.md"}', {});
    expect(fs.readdirSync(path.join(profileDir, "brain", "decisions"))).toEqual(before);
  });

  it("bounds what one call returns", async () => {
    fs.writeFileSync(path.join(profileDir, "brain", "memory", "2026-09-18.md"), "a".repeat(50_000), "utf8");
    const record = await adapter().execute('brain_read {"path": "memory/2026-09-18.md"}', {});
    expect(record.status).toBe("completed");
    expect(record.summary.length).toBeLessThan(20_000);
  });
});
