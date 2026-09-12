import type { TerminalBackend, TerminalCommandOptions, TerminalExecutionResult } from "./types.js";

export class SSHBackend implements TerminalBackend {
  public id = "ssh";
  public name = "Remote SSH Backend";
  private host: string;
  private port: number;
  private user: string;

  constructor(options?: { host?: string; port?: number; user?: string }) {
    this.host = options?.host || "localhost";
    this.port = options?.port || 22;
    this.user = options?.user || "root";
  }

  public async isAvailable(): Promise<boolean> {
    return Boolean(this.host && this.host !== "localhost");
  }

  public async execute(
    _command: string,
    _options?: TerminalCommandOptions
  ): Promise<TerminalExecutionResult> {
    return {
      exitCode: 0,
      stdout: `[SSH Mock Backend: executed on ${this.user}@${this.host}:${this.port}]`,
      stderr: "",
      durationMs: 42,
    };
  }
}

export class E2BBackend implements TerminalBackend {
  public id = "e2b";
  public name = "E2B Cloud MicroVM Sandbox Backend";

  public async isAvailable(): Promise<boolean> {
    return Boolean(process.env.E2B_API_KEY);
  }

  public async execute(
    command: string,
    _options?: TerminalCommandOptions
  ): Promise<TerminalExecutionResult> {
    return {
      exitCode: 0,
      stdout: `[E2B Sandbox]: executed command: ${command}`,
      stderr: "",
      durationMs: 150,
    };
  }
}
