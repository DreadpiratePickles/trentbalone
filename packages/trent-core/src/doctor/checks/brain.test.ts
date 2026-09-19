/**
 * [C2] The doctor's brain line. The one thing it must never do is call a brain without git a
 * failure: a brain of plain files works, and the operator is told versioning is off so they can
 * decide whether they mind.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ConfigManager } from "../../config/ConfigManager.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import { createBrain, type BrainExec } from "../../fleet-memory/brain.js";
import type { DoctorContext } from "../types.js";
import { checkBrain } from "./brain.js";

let home: string;
let configManager: ConfigManager;
const noGit: BrainExec = () => ({ code: 127, stdout: "", stderr: "git: command not found" });

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "trent-doctor-brain-")));
  configManager = new ConfigManager({ baseDir: home });
  configManager.ensureDirs();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function context(overrides: Partial<{ enabled: boolean; versioning: "auto" | "off" }> = {}): DoctorContext {
  configManager.saveConfig({ ...DEFAULT_CONFIG, brain: { enabled: true, versioning: "auto", ...overrides } });
  return { baseDir: home, profile: "default", configManager };
}

describe("the brain doctor check", () => {
  it("reports versioning off, as a warning and not a failure, when git is missing", async () => {
    const ctx = context();
    const brain = createBrain({ profileDir: ctx.configManager.getProfileDir(), exec: noGit });
    brain.ensure();
    brain.appendNote({ text: "a note", writer: "ceo" });

    const result = await checkBrain.run({ ...ctx, execImpl: async () => ({ code: 127, stdout: "", stderr: "not found" }) });
    expect(result.status).toBe("warn");
    expect(result.message.toLowerCase()).toContain("versioning is off");
    expect(result.fixHint).toBeDefined();
    expect(result.details?.versioning).toBe(false);
  });

  it("skips when the brain is switched off in config", async () => {
    const result = await checkBrain.run(context({ enabled: false }));
    expect(result.status).toBe("skip");
    expect(result.details?.enabled).toBe(false);
  });

  it("reports the layout it found and never a note body", async () => {
    const ctx = context({ versioning: "off" });
    const brain = createBrain({ profileDir: ctx.configManager.getProfileDir(), versioning: "off", exec: noGit });
    brain.ensure();
    brain.appendNote({ text: "a secret-looking note body", writer: "ceo" });
    brain.recordDecision({ title: "One truth rule", body: "brain files win.", writer: "human" });

    const result = await checkBrain.run(ctx);
    expect(JSON.stringify(result)).not.toContain("a secret-looking note body");
    expect(result.details?.decisions).toBe(1);
    expect(result.details?.notes).toBe(1);
  });

  it("says the brain has not been created yet, without creating it", async () => {
    const ctx = context();
    const result = await checkBrain.run(ctx);
    expect(result.status).toBe("skip");
    expect(fs.existsSync(path.join(ctx.configManager.getProfileDir(), "brain"))).toBe(false);
  });
});
