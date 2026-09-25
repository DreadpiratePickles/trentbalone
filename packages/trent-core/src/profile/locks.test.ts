/**
 * The profile locks: one gateway per profile, and a shared set of live writers that maintenance
 * commands consult before they touch the profile. Everything here runs against a scratch profile
 * directory and real files; the cross-process cases spawn real Node processes that import this
 * module, because a pid lock that only works inside one process proves nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT, TrentError } from "../errors/index.js";
import {
  acquireProfileLock,
  acquireProfileWriter,
  liveGatewayHolder,
  liveWriters,
  profileLockPath,
  refuseUnderLiveWriters,
  UNREADABLE_LOCK_GRACE_MS,
} from "./locks.js";

/** No process has this pid on macOS (max 99999) or Linux (max 4194304): kill(pid, 0) says ESRCH. */
const DEAD_PID = 2_147_483_646;

let profileDir: string;
const releases: Array<() => void> = [];
const children: ChildProcess[] = [];

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-profile-locks-"));
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  fs.rmSync(profileDir, { recursive: true, force: true });
});

function hold(result: ReturnType<typeof acquireProfileLock>): void {
  if (result.ok) releases.push(result.release);
}

function writeHolder(file: string, holder: { pid: number; label: string; startedAt?: string; hostname?: string }): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ startedAt: "2026-09-25T08:00:00.000Z", hostname: "elsewhere", ...holder }));
}

/** A real, live process that is not this one: a plain Node sleeper. */
function sleeper(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  children.push(child);
  return child.pid!;
}

describe("the gateway lock", () => {
  it("is <profileDir>/locks/gateway.lock, written with pid, startedAt, label and hostname, owner-only", () => {
    const result = acquireProfileLock({ profileDir, role: "gateway", label: "gateway" });
    hold(result);
    expect(result.ok).toBe(true);
    const file = path.join(profileDir, "locks", "gateway.lock");
    expect(result.path).toBe(file);
    expect(profileLockPath(profileDir, "gateway")).toBe(file);
    const body = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(body).toEqual({ pid: process.pid, startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), label: "gateway", hostname: os.hostname() });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("a second acquire on the same profile refuses and names the holder", () => {
    hold(acquireProfileLock({ profileDir, role: "gateway", label: "first" }));
    const second = acquireProfileLock({ profileDir, role: "gateway", label: "second" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.holder).toMatchObject({ pid: process.pid, label: "first" });
    expect(liveGatewayHolder(profileDir)).toMatchObject({ pid: process.pid, label: "first" });
  });

  it("release removes the file, is idempotent, and a later acquire succeeds", () => {
    const first = acquireProfileLock({ profileDir, role: "gateway", label: "first" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    first.release();
    first.release();
    expect(fs.existsSync(first.path)).toBe(false);
    expect(liveGatewayHolder(profileDir)).toBeNull();
    const again = acquireProfileLock({ profileDir, role: "gateway", label: "again" });
    hold(again);
    expect(again.ok).toBe(true);
  });

  it("a lock naming a dead pid is stale and taken over", () => {
    writeHolder(profileLockPath(profileDir, "gateway"), { pid: DEAD_PID, label: "crashed" });
    expect(liveGatewayHolder(profileDir)).toBeNull();
    const result = acquireProfileLock({ profileDir, role: "gateway", label: "fresh" });
    hold(result);
    expect(result.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(profileLockPath(profileDir, "gateway"), "utf8"))).toMatchObject({ pid: process.pid, label: "fresh" });
  });

  it("a lock naming a live process that is not this one refuses; EPERM (pid 1, another user's) counts as alive", () => {
    const pid = sleeper();
    writeHolder(profileLockPath(profileDir, "gateway"), { pid, label: "other" });
    const refused = acquireProfileLock({ profileDir, role: "gateway", label: "mine" });
    expect(refused).toMatchObject({ ok: false, holder: { pid, label: "other", hostname: "elsewhere" } });

    writeHolder(profileLockPath(profileDir, "gateway"), { pid: 1, label: "init" });
    expect(acquireProfileLock({ profileDir, role: "gateway", label: "mine" })).toMatchObject({ ok: false, holder: { pid: 1 } });
  });

  it("a lock naming THIS pid that this process does not hold is stale (a pid reused after a restart)", () => {
    writeHolder(profileLockPath(profileDir, "gateway"), { pid: process.pid, label: "previous boot" });
    const result = acquireProfileLock({ profileDir, role: "gateway", label: "this boot" });
    hold(result);
    expect(result.ok).toBe(true);
  });

  it("an unreadable lock is held while it is young, and taken over once it is old", () => {
    const file = profileLockPath(profileDir, "gateway");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
    expect(acquireProfileLock({ profileDir, role: "gateway", label: "mine" })).toMatchObject({ ok: false, holder: { pid: 0 } });
    const old = (Date.now() - UNREADABLE_LOCK_GRACE_MS - 60_000) / 1000;
    fs.utimesSync(file, old, old);
    const result = acquireProfileLock({ profileDir, role: "gateway", label: "mine" });
    hold(result);
    expect(result.ok).toBe(true);
  });

  it("two profile directories lock independently", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "trent-profile-locks-other-"));
    try {
      const a = acquireProfileLock({ profileDir, role: "gateway", label: "a" });
      const b = acquireProfileLock({ profileDir: other, role: "gateway", label: "b" });
      hold(a);
      hold(b);
      expect([a.ok, b.ok]).toEqual([true, true]);
    } finally {
      for (const release of releases.splice(0)) release();
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("the writers set", () => {
  it("one file per pid under locks/writers/; its label lists each distinct holder; it goes when the last releases", () => {
    const repl = acquireProfileWriter(profileDir, "repl");
    const runtime = acquireProfileWriter(profileDir, "repl");
    const cron = acquireProfileWriter(profileDir, "cron");
    const file = path.join(profileDir, "locks", "writers", `${process.pid}.lock`);
    expect(profileLockPath(profileDir, "writer")).toBe(file);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ pid: process.pid, label: "repl+cron" });
    expect(liveWriters(profileDir)).toEqual([expect.objectContaining({ pid: process.pid, label: "repl+cron" })]);
    cron();
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ label: "repl" });
    repl();
    repl();
    expect(fs.existsSync(file)).toBe(true);
    runtime();
    expect(fs.existsSync(file)).toBe(false);
    expect(liveWriters(profileDir)).toEqual([]);
  });

  it("the generic acquire with role writer never refuses: many writers are fine", () => {
    const a = acquireProfileLock({ profileDir, role: "writer", label: "a" });
    const b = acquireProfileLock({ profileDir, role: "writer", label: "b" });
    hold(a);
    hold(b);
    expect([a.ok, b.ok]).toEqual([true, true]);
  });

  it("lists live writer files and skips the dead; a new writer prunes the dead ones", () => {
    const live = sleeper();
    writeHolder(profileLockPath(profileDir, "writer", live), { pid: live, label: "gateway" });
    writeHolder(profileLockPath(profileDir, "writer", DEAD_PID), { pid: DEAD_PID, label: "crashed repl" });
    expect(liveWriters(profileDir).map((w) => [w.pid, w.label])).toEqual([[live, "gateway"]]);
    releases.push(acquireProfileWriter(profileDir, "run"));
    expect(fs.existsSync(profileLockPath(profileDir, "writer", DEAD_PID))).toBe(false);
    expect(liveWriters(profileDir).map((w) => w.pid).sort()).toEqual([live, process.pid].sort());
  });

  it("refuseUnderLiveWriters throws EXIT.CONFIG naming every OTHER live writer, and deletes nothing", () => {
    const live = sleeper();
    writeHolder(profileLockPath(profileDir, "writer", live), { pid: live, label: "gateway" });
    releases.push(acquireProfileWriter(profileDir, "this process"));
    const warn = vi.fn();
    let thrown: unknown;
    try {
      refuseUnderLiveWriters({ profileDirs: [profileDir], operation: "sessions.prune", force: false, warn });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TrentError);
    const error = thrown as TrentError;
    expect(error.code).toBe(EXIT.CONFIG);
    expect(error.operation).toBe("sessions.prune");
    expect(error.message).toContain(`pid ${live} (gateway)`);
    expect(error.message).not.toContain(`pid ${process.pid}`);
    expect(error.message).toContain("--force");
    expect(warn).not.toHaveBeenCalled();
    expect(fs.existsSync(profileLockPath(profileDir, "writer", live))).toBe(true);
  });

  it("with only this process writing, or with force, it does not throw; force warns exactly once", () => {
    releases.push(acquireProfileWriter(profileDir, "this process"));
    const warn = vi.fn();
    expect(refuseUnderLiveWriters({ profileDirs: [profileDir], operation: "sessions.prune", force: false, warn })).toEqual([]);
    const live = sleeper();
    writeHolder(profileLockPath(profileDir, "writer", live), { pid: live, label: "repl" });
    const forced = refuseUnderLiveWriters({ profileDirs: [profileDir], operation: "sessions.prune", force: true, warn });
    expect(forced.map((w) => w.pid)).toEqual([live]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toMatch(new RegExp(`^warning: .*pid ${live} \\(repl\\)`));
  });
});

describe("across processes", () => {
  const moduleUrl = new URL("./locks.ts", import.meta.url).href;

  /** A Node process that takes the gateway lock through this module, says "ready", then waits or exits. */
  function holder(mode: "wait" | "exit"): Promise<{ child: ChildProcess; line: string }> {
    const script =
      `import { acquireProfileLock } from ${JSON.stringify(moduleUrl)};\n` +
      `const r = acquireProfileLock({ profileDir: ${JSON.stringify(profileDir)}, role: "gateway", label: "child" });\n` +
      `console.log(r.ok ? "ready" : "refused");\n` +
      (mode === "exit" ? "process.exit(0);\n" : "setInterval(() => {}, 1000);\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    return new Promise((resolve, reject) => {
      let out = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        if (out.includes("\n")) resolve({ child, line: out.trim() });
      });
      child.once("exit", (code) => { if (!out.includes("\n")) reject(new Error(`holder exited ${String(code)} before it said anything`)); });
    });
  }

  function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  }

  it("another process's lock refuses naming its pid; SIGTERM still ends that process, and its handler removes the file", async () => {
    const { child, line } = await holder("wait");
    expect(line).toBe("ready");
    const refused = acquireProfileLock({ profileDir, role: "gateway", label: "parent" });
    expect(refused).toMatchObject({ ok: false, holder: { pid: child.pid, label: "child" } });
    child.kill("SIGTERM");
    const end = await exited(child);
    expect(end.code !== null || end.signal !== null).toBe(true);
    expect(fs.existsSync(profileLockPath(profileDir, "gateway"))).toBe(false);
    const mine = acquireProfileLock({ profileDir, role: "gateway", label: "parent" });
    hold(mine);
    expect(mine.ok).toBe(true);
  }, 30_000);

  it("process.exit releases the lock; a SIGKILLed holder leaves a stale file the next acquire takes over", async () => {
    const clean = await holder("exit");
    expect(clean.line).toBe("ready");
    await exited(clean.child);
    expect(fs.existsSync(profileLockPath(profileDir, "gateway"))).toBe(false);

    const { child } = await holder("wait");
    child.kill("SIGKILL");
    await exited(child);
    expect(JSON.parse(fs.readFileSync(profileLockPath(profileDir, "gateway"), "utf8"))).toMatchObject({ pid: child.pid });
    const mine = acquireProfileLock({ profileDir, role: "gateway", label: "parent" });
    hold(mine);
    expect(mine.ok).toBe(true);
  }, 30_000);
});
