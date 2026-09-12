import { exec } from "node:child_process";
import type { TerminalBackend, TerminalCommandOptions, TerminalExecutionResult } from "./types.js";

export class DockerBackend implements TerminalBackend {
  public id = "docker";
  public name = "Docker Sandbox Backend";
  private containerName: string;
  private image: string;

  constructor(options?: { containerName?: string; image?: string }) {
    this.containerName = options?.containerName || `trent-sandbox-${Date.now()}`;
    this.image = options?.image || "node:22-alpine";
  }

  public async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      exec("docker info", { timeout: 3000 }, (err) => {
        resolve(!err);
      });
    });
  }

  public async execute(
    command: string,
    options?: TerminalCommandOptions
  ): Promise<TerminalExecutionResult> {
    const startTime = Date.now();
    const isDockerRunning = await this.isAvailable();

    if (!isDockerRunning) {
      return {
        exitCode: 127,
        stdout: "",
        stderr: "Docker daemon is not running or docker CLI is not installed. Please start Docker or switch backend to 'local' or 'e2b'.",
        durationMs: Date.now() - startTime,
      };
    }

    const envFlags: string[] = [];
    if (options?.env) {
      for (const [k, v] of Object.entries(options.env)) {
        envFlags.push(`-e ${k}="${v.replace(/"/g, '\\"')}"`);
      }
    }
    if (options?.proxyToken) {
      envFlags.push(`-e TRENT_PROXY_TOKEN="${options.proxyToken}"`);
    }

    const cwdFlag = options?.cwd ? `-w "${options.cwd}" -v "${options.cwd}:${options.cwd}"` : "";
    const dockerCmd = `docker run --rm ${cwdFlag} ${envFlags.join(" ")} ${this.image} sh -c "${command.replace(/"/g, '\\"')}"`;

    return new Promise((resolve) => {
      exec(
        dockerCmd,
        {
          timeout: options?.timeoutMs || 120000,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          resolve({
            exitCode: error ? error.code || 1 : 0,
            stdout: stdout || "",
            stderr: stderr || "",
            durationMs: Date.now() - startTime,
          });
        }
      );
    });
  }
}
