/**
 * Background processes for `terminal(background=true)` and `process_manage`, the subset of
 * Hermes's `process_registry.py` a non-PTY sandbox supports: list / poll / log / wait / kill.
 * Each process writes to its own log inside the sandbox and appends an exit marker, so its
 * status is observable through the same `sandbox.run` path as everything else.
 */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { shellQuote, type Sandbox } from "../sandbox.js";

export interface BackgroundProcess {
  readonly id: string;
  readonly pid: number;
  readonly command: string;
  readonly cwd: string;
  readonly logPath: string;
  readonly startedAt: string;
}

export interface ProcessStatus {
  readonly running: boolean;
  readonly exitCode?: number;
  readonly log: string;
}

const EXIT_MARKER = "__TRENT_EXIT__";

export class ProcessRegistry {
  private readonly processes = new Map<string, BackgroundProcess>();
  private readonly dir: string;

  constructor(private readonly sandbox: Sandbox, profileDir: string) {
    this.dir = sandbox.kind === "docker" ? "/tmp/trent-bg" : path.join(profileDir, "cache", "bg");
  }

  list(): BackgroundProcess[] {
    return [...this.processes.values()];
  }

  get(id: string): BackgroundProcess | undefined {
    return this.processes.get(id);
  }

  async start(command: string, cwd: string, network: boolean): Promise<BackgroundProcess> {
    const id = `bg-${randomBytes(3).toString("hex")}`;
    const logPath = `${this.dir}/${id}.log`;
    const inner = `${command}\necho "${EXIT_MARKER}$?"`;
    const script =
      `mkdir -p ${shellQuote(this.dir)} && cd ${shellQuote(cwd)} && ` +
      `nohup sh -c ${shellQuote(inner)} > ${shellQuote(logPath)} 2>&1 & echo $!`;
    const res = await this.sandbox.run(script, { cwd, network, timeoutMs: 30_000 });
    const pid = Number.parseInt(res.stdout.trim().split("\n").pop() ?? "", 10);
    if (res.exitCode !== 0 || !Number.isFinite(pid)) {
      throw new Error(`could not start background process: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.exitCode}`}`);
    }
    const proc: BackgroundProcess = { id, pid, command, cwd, logPath, startedAt: new Date().toISOString() };
    this.processes.set(id, proc);
    return proc;
  }

  async status(proc: BackgroundProcess): Promise<ProcessStatus> {
    const res = await this.sandbox.run(
      `if kill -0 ${proc.pid} 2>/dev/null; then echo __ALIVE__; else echo __DEAD__; fi; cat ${shellQuote(proc.logPath)} 2>/dev/null`,
      { timeoutMs: 30_000 },
    );
    const [first = "", ...rest] = res.stdout.split("\n");
    let log = rest.join("\n");
    let exitCode: number | undefined;
    const marker = new RegExp(`${EXIT_MARKER}(\\d+)\\s*$`).exec(log);
    if (marker) {
      exitCode = Number(marker[1]);
      log = log.slice(0, marker.index).replace(/\n$/, "");
    }
    return { running: first.trim() === "__ALIVE__" && exitCode === undefined, exitCode, log };
  }

  async wait(proc: BackgroundProcess, timeoutMs: number): Promise<ProcessStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.status(proc);
      if (!status.running || Date.now() >= deadline) return status;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  async kill(proc: BackgroundProcess): Promise<void> {
    await this.sandbox.run(`kill ${proc.pid} 2>/dev/null; sleep 1; kill -9 ${proc.pid} 2>/dev/null; true`, { timeoutMs: 15_000 });
    this.processes.delete(proc.id);
  }

  async killAll(): Promise<void> {
    for (const proc of this.processes.values()) await this.kill(proc).catch(() => undefined);
  }
}
