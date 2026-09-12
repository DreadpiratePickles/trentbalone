export interface TerminalCommandOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  proxyToken?: string;
}

export interface TerminalExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface TerminalBackend {
  id: string;
  name: string;
  execute(command: string, options?: TerminalCommandOptions): Promise<TerminalExecutionResult>;
  isAvailable(): Promise<boolean>;
  cleanup?(): Promise<void>;
}
