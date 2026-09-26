/**
 * `<profile>/logs/service.log`: one timestamped line per component start and stop, the same line
 * on stderr, capped by size with one rotation so a service that restarts for months cannot fill
 * the disk. `trent service status` reads the last lines back, across the rotation.
 *
 * Every case works in its own temp dir. A fixture once wrote `${file}.1` with `file` empty, which
 * put a rotated log named `.1` into the repo root (the cwd under vitest): fixture writes go through
 * `inTemp`, `ServiceLog` refuses an empty path, and each case checks the cwd holds no log file.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ServiceLog, serviceLogPaths, tailServiceLog } from "./service-log.js";

let profileDir: string;

beforeEach(() => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-service-log-"));
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
  for (const name of [".1", "service.log", "service.log.1"]) expect(fs.existsSync(path.join(process.cwd(), name)), `${name} written into the cwd`).toBe(false);
});

/** A fixture path, refused unless it is absolute and inside this case's temp dir. */
function inTemp(file: string): string {
  if (!path.isAbsolute(file) || !file.startsWith(`${profileDir}${path.sep}`)) throw new Error(`fixture path ${JSON.stringify(file)} is outside the case's temp dir`);
  return file;
}

const at = (): Date => new Date("2026-09-25T09:00:00.000Z");

describe("serviceLogPaths", () => {
  it("puts every service log under <profile>/logs, the supervisor's apart from launchd's streams", () => {
    expect(serviceLogPaths(profileDir)).toEqual({
      dir: path.join(profileDir, "logs"),
      service: path.join(profileDir, "logs", "service.log"),
      stdout: path.join(profileDir, "logs", "service.stdout.log"),
      stderr: path.join(profileDir, "logs", "service.stderr.log"),
    });
  });
});

describe("ServiceLog", () => {
  it("appends one timestamped line per call to the file and echoes the same line", () => {
    const echoed: string[] = [];
    const log = new ServiceLog({ file: serviceLogPaths(profileDir).service, echo: (line) => echoed.push(line), now: at, pid: 4242 });
    log.line("gateway started: telegram");
    log.line("cron started");
    const expected = ["2026-09-25T09:00:00.000Z service[4242] gateway started: telegram", "2026-09-25T09:00:00.000Z service[4242] cron started"];
    expect(echoed).toEqual(expected);
    expect(fs.readFileSync(serviceLogPaths(profileDir).service, "utf8")).toBe(`${expected.join("\n")}\n`);
  });

  it("creates the logs directory 0700 and the file 0600", () => {
    new ServiceLog({ file: serviceLogPaths(profileDir).service, now: at }).line("cron started");
    expect(fs.statSync(serviceLogPaths(profileDir).dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(serviceLogPaths(profileDir).service).mode & 0o777).toBe(0o600);
  });

  it("rotates to service.log.1 when a line would take the file past its cap, keeping one old file", () => {
    const file = serviceLogPaths(profileDir).service;
    const log = new ServiceLog({ file, now: at, pid: 1, maxBytes: 200 });
    for (let i = 0; i < 12; i += 1) log.line(`line ${String(i).padStart(2, "0")}`);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(200);
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.existsSync(`${file}.2`)).toBe(false);
    expect(fs.readFileSync(file, "utf8").trimEnd().split("\n").at(-1)).toContain("line 11");
  });

  it("refuses an empty path, which would resolve against the working directory", () => {
    for (const file of ["", "   "]) expect(() => new ServiceLog({ file, now: at }), JSON.stringify(file)).toThrow(/empty/);
  });

  it("a write that fails does not throw: the echo still carries the line", () => {
    const echoed: string[] = [];
    // A directory where the file should be: every append fails.
    const file = path.join(profileDir, "logs", "service.log");
    fs.mkdirSync(inTemp(file), { recursive: true });
    const log = new ServiceLog({ file, echo: (line) => echoed.push(line), now: at, pid: 1 });
    expect(() => log.line("cron started")).not.toThrow();
    expect(echoed).toHaveLength(1);
  });
});

describe("tailServiceLog", () => {
  it("returns the last N lines, reaching into the rotated file when the current one is short", () => {
    const file = serviceLogPaths(profileDir).service;
    fs.mkdirSync(inTemp(path.dirname(file)), { recursive: true });
    fs.writeFileSync(inTemp(`${file}.1`), "a\nb\nc\nd\n");
    fs.writeFileSync(inTemp(file), "e\nf\n");
    expect(tailServiceLog(file, 5)).toEqual(["b", "c", "d", "e", "f"]);
    expect(tailServiceLog(file, 1)).toEqual(["f"]);
  });

  it("is empty when there is no log yet", () => {
    expect(tailServiceLog(serviceLogPaths(profileDir).service, 5)).toEqual([]);
  });
});
