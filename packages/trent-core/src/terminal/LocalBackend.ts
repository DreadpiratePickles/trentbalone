import { exec } from "node:child_process";
import { scrubChildEnv } from "./env-scrub.js";
import type { TerminalBackend, TerminalCommandOptions, TerminalExecutionResult } from "./types.js";

export class LocalBackend implements TerminalBackend {
  public id = "local";
  public name = "Local Execution Backend (Development Only)";

  public async isAvailable(): Promise<boolean> {
    return true;
  }

  public async execute(
    command: string,
    options?: TerminalCommandOptions
  ): Promise<TerminalExecutionResult> {
    const startTime = Date.now();
    const timeout = options?.timeoutMs || 60000;

    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: options?.cwd || process.cwd(),
          // Never the whole process.env: the CLI loads every provider key into it. See env-scrub.ts.
          env: {
            ...scrubChildEnv(process.env),
            ...options?.env,
            ...(options?.proxyToken ? { TRENT_PROXY_TOKEN: options.proxyToken } : {}),
          },
          timeout,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - startTime;
          const exitCode = error ? error.code || 1 : 0;
          resolve({
            exitCode,
            stdout: stdout || "",
            stderr: stderr || (error ? error.message : ""),
            durationMs,
          });
        }
      );
    });
  }
}
