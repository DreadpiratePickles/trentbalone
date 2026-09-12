import type { ConfigManager } from "../config/ConfigManager.js";

/**
 * `fail` is the canonical failing status. `error` is retained only so that surfaces written
 * against the previous shape keep compiling; no check in this package ever produces it.
 */
export type CheckStatus = "ok" | "warn" | "fail" | "skip" | "error";

export interface CheckResult {
  category: string;
  name: string;
  status: CheckStatus;
  message: string;
  /** What the operator should do. Mandatory for anything that is not `ok`. */
  fixHint?: string;
  /** Never put a credential, an environment value, or a request body in here. */
  details?: Record<string, unknown>;
  /** True when `trent doctor --fix` can remediate this safely and without touching user data. */
  autoFixable?: boolean;
}

export interface DoctorReport {
  timestamp: string;
  total: number;
  passed: number;
  warnings: number;
  errors: number;
  skipped: number;
  durationMs: number;
  results: CheckResult[];
}

export interface DoctorCheck {
  id: string;
  name: string;
  category: string;
  run(context: DoctorContext): Promise<CheckResult>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type ExecResult = { code: number; stdout: string; stderr: string };
export type ExecLike = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<ExecResult>;

/** Standalone runs against a local SQLite file; connected runs against the deployed web app. */
export type DoctorMode = "standalone" | "connected";

export interface DoctorContext {
  baseDir: string;
  profile: string;
  configManager: ConfigManager;
  /** Deadline for any single outbound request a check makes. Default 5s. */
  probeTimeoutMs?: number;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injected in tests; defaults to spawning the real binary. */
  execImpl?: ExecLike;
  mode?: DoctorMode;
  /** Connected mode only: the health endpoint of the deployed app. */
  healthUrl?: string;
}
