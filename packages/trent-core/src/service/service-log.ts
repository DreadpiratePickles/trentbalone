/**
 * The service's own log, `<profile>/logs/service.log`: one line per component start and stop,
 * timestamped and tagged with the daemon's pid, so a restart loop reads as one in the file.
 *
 * It is capped by size: a line that would take the file past `maxBytes` first moves it to
 * `service.log.1` (replacing the previous one), so the two files never hold much more than twice
 * the cap however long the service runs. The same line goes to stderr through `echo`, which under
 * launchd lands in `service.stderr.log` beside it; that stream is kept apart from this file so
 * no line is written twice into one place.
 *
 * Writing the log never fails the service: a line that cannot be appended is still echoed.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

/** 1 MiB: several years of start and stop lines at one restart a day. */
export const SERVICE_LOG_MAX_BYTES = 1_048_576;

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface ServiceLogPaths {
  readonly dir: string;
  /** The supervisor's lines (this module). */
  readonly service: string;
  /** launchd's `StandardOutPath` / `StandardErrorPath`: everything the daemon prints. */
  readonly stdout: string;
  readonly stderr: string;
}

export function serviceLogPaths(profileDir: string): ServiceLogPaths {
  const dir = path.join(profileDir, "logs");
  return {
    dir,
    service: path.join(dir, "service.log"),
    stdout: path.join(dir, "service.stdout.log"),
    stderr: path.join(dir, "service.stderr.log"),
  };
}

export interface ServiceLogOptions {
  readonly file: string;
  readonly echo?: ((line: string) => void) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly pid?: number | undefined;
  readonly maxBytes?: number | undefined;
}

export class ServiceLog {
  private readonly file: string;
  private readonly echo: ((line: string) => void) | undefined;
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly maxBytes: number;

  constructor(options: ServiceLogOptions) {
    // An empty path resolves against the cwd, and its rotation would be a file named `.1` there.
    if (options.file.trim() === "") throw new Error("ServiceLog needs a file path; an empty one would write into the working directory");
    this.file = options.file;
    this.echo = options.echo;
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? process.pid;
    this.maxBytes = options.maxBytes ?? SERVICE_LOG_MAX_BYTES;
  }

  public get path(): string {
    return this.file;
  }

  public line(text: string): void {
    const line = `${this.now().toISOString()} service[${this.pid}] ${text}`;
    this.echo?.(line);
    try {
      this.append(`${line}\n`);
    } catch {
      // The echo already carried it; a full disk or a bad permission must not stop the service.
    }
  }

  private append(text: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: DIR_MODE });
    const bytes = Buffer.byteLength(text);
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (size > 0 && size + bytes > this.maxBytes) fs.renameSync(this.file, `${this.file}.1`);
    fs.appendFileSync(this.file, text, { mode: FILE_MODE });
  }
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((line) => line !== "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** The newest `count` lines, reaching into `service.log.1` when the current file is shorter. */
export function tailServiceLog(file: string, count: number): string[] {
  const current = readLines(file);
  if (current.length >= count) return current.slice(current.length - count);
  const rotated = readLines(`${file}.1`);
  return [...rotated.slice(Math.max(0, rotated.length - (count - current.length))), ...current];
}
