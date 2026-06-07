import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  PREVIEW_PID_FILENAME,
  parsePreviewPidFile,
  reapAllOrphanedPreviews,
  reapOrphanedPreview,
} from "@/lib/workbench-preview-reaper";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "reaper-test-"));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

async function writeSidecar(dir: string, record: unknown): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, PREVIEW_PID_FILENAME),
    typeof record === "string" ? record : JSON.stringify(record),
    "utf8"
  );
}

async function sidecarExists(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, PREVIEW_PID_FILENAME));
    return true;
  } catch {
    return false;
  }
}

describe("parsePreviewPidFile", () => {
  it("parses a valid record", () => {
    const rec = parsePreviewPidFile(JSON.stringify({ pid: 1234, port: 4100, startedAt: "2026-06-07T00:00:00.000Z" }));
    expect(rec).toEqual({ pid: 1234, port: 4100, startedAt: "2026-06-07T00:00:00.000Z" });
  });

  it("returns undefined on malformed JSON", () => {
    expect(parsePreviewPidFile("{not json")).toBeUndefined();
  });

  it("returns undefined when fields are missing or wrong type", () => {
    expect(parsePreviewPidFile(JSON.stringify({ port: 4100, startedAt: "x" }))).toBeUndefined();
    expect(parsePreviewPidFile(JSON.stringify({ pid: "1234", port: 4100, startedAt: "x" }))).toBeUndefined();
    expect(parsePreviewPidFile(JSON.stringify({ pid: 1234, port: "4100", startedAt: "x" }))).toBeUndefined();
    expect(parsePreviewPidFile(JSON.stringify({ pid: 1234, port: 4100 }))).toBeUndefined();
    expect(parsePreviewPidFile(JSON.stringify({ pid: 0, port: 4100, startedAt: "x" }))).toBeUndefined();
    expect(parsePreviewPidFile(JSON.stringify({ pid: 1.5, port: 4100, startedAt: "x" }))).toBeUndefined();
  });

  it("returns undefined for non-object JSON", () => {
    expect(parsePreviewPidFile("42")).toBeUndefined();
    expect(parsePreviewPidFile("null")).toBeUndefined();
    expect(parsePreviewPidFile('"a string"')).toBeUndefined();
  });
});

describe("reapOrphanedPreview", () => {
  it("returns no_sidecar when none present", async () => {
    const dir = path.join(tmpRoot, "s1");
    await fs.mkdir(dir, { recursive: true });
    const result = await reapOrphanedPreview(dir, { isAlive: () => true, kill: () => {} });
    expect(result).toEqual({ reaped: false, reason: "no_sidecar" });
  });

  it("kills and removes when owning process is gone", async () => {
    const dir = path.join(tmpRoot, "s2");
    await writeSidecar(dir, { pid: 9999, port: 4101, startedAt: new Date().toISOString() });
    const killed: number[] = [];
    const result = await reapOrphanedPreview(dir, {
      isAlive: () => false,
      kill: (pid) => killed.push(pid),
    });
    expect(result.reaped).toBe(true);
    expect(result.pid).toBe(9999);
    expect(result.reason).toBe("owner_gone");
    // Owner already gone — we don't kill, just clean the sidecar.
    expect(killed).toEqual([]);
    expect(await sidecarExists(dir)).toBe(false);
  });

  it("leaves a live, recent preview running", async () => {
    const dir = path.join(tmpRoot, "s3");
    await writeSidecar(dir, { pid: 4321, port: 4102, startedAt: new Date().toISOString() });
    const killed: number[] = [];
    const result = await reapOrphanedPreview(dir, {
      isAlive: () => true,
      kill: (pid) => killed.push(pid),
      maxAgeMs: 6 * 60 * 60 * 1000,
    });
    expect(result.reaped).toBe(false);
    expect(result.reason).toBe("alive_and_recent");
    expect(killed).toEqual([]);
    expect(await sidecarExists(dir)).toBe(true);
  });

  it("kills a live but too-old preview and removes the sidecar", async () => {
    const dir = path.join(tmpRoot, "s4");
    const startedAt = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    await writeSidecar(dir, { pid: 5555, port: 4103, startedAt });
    const killed: number[] = [];
    const result = await reapOrphanedPreview(dir, {
      isAlive: () => true,
      kill: (pid) => killed.push(pid),
      maxAgeMs: 6 * 60 * 60 * 1000,
    });
    expect(result.reaped).toBe(true);
    expect(result.pid).toBe(5555);
    expect(result.reason).toBe("killed_stale_aged");
    expect(killed).toEqual([5555]);
    expect(await sidecarExists(dir)).toBe(false);
  });

  it("kills a live preview when maxAgeMs is 0 (stale-on-restart path)", async () => {
    const dir = path.join(tmpRoot, "s5");
    await writeSidecar(dir, { pid: 7777, port: 4104, startedAt: new Date().toISOString() });
    const killed: number[] = [];
    const result = await reapOrphanedPreview(dir, {
      isAlive: () => true,
      kill: (pid) => killed.push(pid),
      maxAgeMs: 0,
    });
    expect(result.reaped).toBe(true);
    expect(killed).toEqual([7777]);
    expect(await sidecarExists(dir)).toBe(false);
  });

  it("removes a malformed sidecar without killing", async () => {
    const dir = path.join(tmpRoot, "s6");
    await writeSidecar(dir, "{garbage");
    const killed: number[] = [];
    const result = await reapOrphanedPreview(dir, {
      isAlive: () => true,
      kill: (pid) => killed.push(pid),
    });
    expect(result.reaped).toBe(false);
    expect(result.reason).toBe("malformed_sidecar");
    expect(killed).toEqual([]);
    expect(await sidecarExists(dir)).toBe(false);
  });
});

describe("reapAllOrphanedPreviews", () => {
  it("returns 0 when the sessions root does not exist", async () => {
    const count = await reapAllOrphanedPreviews(path.join(tmpRoot, "nope"), { isAlive: () => false, kill: () => {} });
    expect(count).toBe(0);
  });

  it("counts only reaped sessions across the root", async () => {
    // s-dead: owner gone -> reaped
    await writeSidecar(path.join(tmpRoot, "s-dead"), { pid: 1, port: 4100, startedAt: new Date().toISOString() });
    // s-alive: live + recent -> not reaped
    await writeSidecar(path.join(tmpRoot, "s-alive"), { pid: 2, port: 4101, startedAt: new Date().toISOString() });
    // s-none: directory with no sidecar
    await fs.mkdir(path.join(tmpRoot, "s-none"), { recursive: true });
    // a stray file at root should be ignored (not a directory)
    await fs.writeFile(path.join(tmpRoot, "stray.txt"), "x", "utf8");

    const killed: number[] = [];
    const count = await reapAllOrphanedPreviews(tmpRoot, {
      isAlive: (pid) => pid === 2,
      kill: (pid) => killed.push(pid),
      maxAgeMs: 6 * 60 * 60 * 1000,
    });
    expect(count).toBe(1);
    expect(killed).toEqual([]); // s-dead's owner was already gone
    expect(await sidecarExists(path.join(tmpRoot, "s-dead"))).toBe(false);
    expect(await sidecarExists(path.join(tmpRoot, "s-alive"))).toBe(true);
  });
});
