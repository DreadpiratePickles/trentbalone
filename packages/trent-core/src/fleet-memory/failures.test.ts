/**
 * [C5] Failures get a channel.
 *
 * `01_discovery/output/fleet-brain-audit-2026-09-18.md` 3.5: "**Failures have no channel at all**
 * — they surface only as step outputs inside recall." A seat therefore repeats what another seat
 * already lost a step to. This suite is that channel: a compact record under the brain, tagged
 * `failure`, ranked for the next run's related objective and marked so a seat can see it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrain, type Brain } from "./brain.js";
import { FAILURE_MARKER, FAILURES_BLOCK, readFailures, recallFailures, recordFailure, renderFailureNote } from "./failures.js";

let profileDir = "";
let brain: Brain;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-failures-"));
  brain = createBrain({ profileDir, versioning: "off" });
  brain.ensure();
});
afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

const FAILED = {
  objective: "migrate the billing invoices to the new provider",
  seat: "finance",
  tool: "terminal",
  tags: ["repetitive_loop"],
  reason: "the provider CLI refused the batch import twice with the same argument",
  runId: "run-1",
  stepId: "step-a",
};

describe("renderFailureNote", () => {
  it("is one redacted line carrying the failure tag and the five fields", () => {
    const line = renderFailureNote({ ...FAILED, reason: "the import died on Authorization: Bearer abcdefgh12345678" });
    expect(line.startsWith(FAILURE_MARKER)).toBe(true);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("seat: finance");
    expect(line).toContain("tool: terminal");
    expect(line).toContain("tags: repetitive_loop");
    expect(line).toContain("billing invoices");
    expect(line).toContain("[REDACTED_SECRET]");
    expect(line).not.toContain("abcdefgh12345678");
    expect(FAILURES_BLOCK).toBe("failures");
  });
});

describe("recordFailure", () => {
  it("appends through the brain's own note API, so the entry is a dated episodic line", () => {
    const written = recordFailure(brain, FAILED);
    expect(written.relativePath).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);
    const body = brain.readFile(written.relativePath) ?? "";
    expect(body).toContain(FAILURE_MARKER);
    expect(body).toContain("[finance run run-1]");
    expect(readFailures(brain)).toHaveLength(1);
    expect(readFailures(brain)[0]!.seat).toBe("finance");
    expect(readFailures(brain)[0]!.tool).toBe("terminal");
  });

  it("does not tag an ordinary note, so a step that succeeded is never recalled as a failure", () => {
    brain.appendNote({ text: "the billing invoices migration finished in 40 seconds", writer: "finance", runId: "run-2" });
    expect(readFailures(brain)).toEqual([]);
  });
});

describe("recallFailures", () => {
  it("ranks a related failure for the next run and marks it, and stays silent on an unrelated one", async () => {
    recordFailure(brain, FAILED);
    const related = await recallFailures({ brain, objective: "finish migrating the billing invoices to the new provider" });
    expect(related.items).toHaveLength(1);
    expect(related.block).toContain(FAILURE_MARKER);
    expect(related.block).toContain("the provider CLI refused the batch import");
    expect(related.chars).toBe(related.block.length);

    const unrelated = await recallFailures({ brain, objective: "draft the launch announcement for the newsletter" });
    expect(unrelated.block).toBe("");
    expect(unrelated.items).toEqual([]);
  });

  it("returns nothing at all when the brain holds no failures", async () => {
    const empty = await recallFailures({ brain, objective: "migrate the billing invoices to the new provider" });
    expect(empty.block).toBe("");
  });
});
