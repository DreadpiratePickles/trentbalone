import { spawn } from "node:child_process";

export type ProcessWatchdogInput = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type ProcessWatchdogResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export async function runProcessWithTimeout(input: ProcessWatchdogInput): Promise<ProcessWatchdogResult> {
  const started = Date.now();
  const maxOutputBytes = input.maxOutputBytes ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args ?? [], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const append = (current: string, chunk: Buffer) =>
      (current + chunk.toString("utf8")).slice(-maxOutputBytes);

    const timer = setTimeout(() => {
      timedOut = true;
      stderr = append(stderr, Buffer.from(`Process timed out after ${input.timeoutMs}ms\n`));
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000).unref();
    }, input.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout = append(stdout, chunk);
      input.onStdout?.(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr = append(stderr, chunk);
      input.onStderr?.(text);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}
