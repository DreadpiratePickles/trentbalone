/**
 * Workbench Provider Abstraction
 *
 * Defines the WorkbenchProviderAdapter interface and the provider registry.
 * Add new providers (E2B, Daytona, Fly Machines, Modal) by registering them here.
 */

import type { WorkbenchArtifact, WorkbenchEvent, WorkbenchSession } from "@/lib/types";

// ── Result types ──────────────────────────────────────────────────────────────

export type WorkbenchExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** True when the command was blocked by the allowlist */
  blocked?: boolean;
  blockedReason?: string;
};

export type WorkbenchFileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  sizeBytes: number;
  modifiedAt: string;
};

export type WorkbenchScreenshotResult = {
  /** Data URI (png) or empty string for placeholder */
  dataUri: string;
  width: number;
  height: number;
  storageKey: string;
};

export type WorkbenchTestResult = {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  output: string;
  exitCode: number;
};

export type WorkbenchSandboxHandle = {
  provider: WorkbenchSession["provider"];
  providerSessionId?: string;
  workdir?: string;
  previewMode: "local_port" | "provider_url" | "proxy" | "none";
  providerUrl?: string;
  expiresAt?: string;
};

export type WorkbenchPreviewRun = {
  command: string;
  url?: string;
  port?: number;
  result: WorkbenchExecResult;
};

export type WorkbenchFileTreeOptions = {
  depth?: number;
  includeIgnored?: boolean;
};

export type WorkbenchFileDiff = {
  changedPaths: string[];
  summary: string;
  patch?: string;
  fromHash?: string;
  toHash?: string;
};

export type WorkbenchSandboxSnapshot = {
  id: string;
  fileTreeHash: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type WorkbenchExportResult = {
  artifact: WorkbenchArtifact;
  event: WorkbenchEvent;
};

export type WorkbenchPreviewInspection = {
  url: string;
  httpStatus?: number;
  screenshot: WorkbenchScreenshotResult;
  domText: string;
  visibleElements: number;
  consoleErrors: string[];
  pageErrors: string[];
};

// ── Provider adapter interface ────────────────────────────────────────────────

export type WorkbenchCaptureArtifactInput = {
  title: string;
  kind: WorkbenchArtifact["kind"];
  mimeType?: string;
  content?: string;
  sizeBytes?: number;
  createdByAgent?: WorkbenchArtifact["createdByAgent"];
  sourceEventId?: string;
  path?: string;
  previewUrl?: string;
  metadata?: WorkbenchArtifact["metadata"];
};

export type WorkbenchExecOptions = {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
};

export interface WorkbenchProviderAdapter {
  readonly name: string;

  /** Provision / warm up a sandbox for the session. */
  start(session: WorkbenchSession): Promise<WorkbenchSandboxHandle | void>;

  /** Reattach to a previously persisted sandbox. */
  restore?(session: WorkbenchSession, handle: WorkbenchSandboxHandle): Promise<WorkbenchSandboxHandle>;

  /** Stop and clean up the sandbox. */
  stop(session: WorkbenchSession): Promise<void>;

  /** Run a shell command inside the sandbox. */
  exec(session: WorkbenchSession, command: string, options?: WorkbenchExecOptions): Promise<WorkbenchExecResult>;

  /** Read a file from the sandbox workdir. Returns raw text. */
  readFile(session: WorkbenchSession, path: string): Promise<string>;

  /** Write / overwrite a file in the sandbox workdir. */
  writeFile(session: WorkbenchSession, path: string, content: string): Promise<void>;

  /** List files at path (relative to workdir). */
  listFiles(session: WorkbenchSession, path?: string): Promise<WorkbenchFileEntry[]>;

  /** Run the project's test suite and return structured results. */
  runTests(session: WorkbenchSession, command?: string): Promise<WorkbenchTestResult>;

  /** Capture a screenshot of the preview URL or active browser. */
  screenshot(session: WorkbenchSession, options?: { url?: string; width?: number; height?: number }): Promise<WorkbenchScreenshotResult>;

  /** Return the preview URL (local port or remote URL). */
  getPreviewUrl(session: WorkbenchSession): Promise<string | undefined>;

  /** Start a long-running preview server and return its managed URL. */
  startPreview?(session: WorkbenchSession, command: string, portHint?: number): Promise<WorkbenchPreviewRun>;

  /** Return a recursive file tree optimized for model context and UI panes. */
  getFileTree?(session: WorkbenchSession, options?: WorkbenchFileTreeOptions): Promise<WorkbenchFileEntry[]>;

  /** Return changes since a persisted checkpoint or provider snapshot. */
  diffSinceCheckpoint?(session: WorkbenchSession, checkpointHash?: string): Promise<WorkbenchFileDiff>;

  /** Persist provider-native snapshot metadata when available. */
  snapshot?(session: WorkbenchSession): Promise<WorkbenchSandboxSnapshot>;

  /**
   * Capture a restorable workspace checkpoint covering binaries and nested
   * directories, while preserving excluded dependency/cache directories.
   *
   * Providers that implement both checkpoint methods can advertise and perform
   * full-workspace rollback instead of text-files-only repair snapshots.
   */
  captureWorkspaceCheckpoint?(session: WorkbenchSession, options?: { replace?: boolean }): Promise<{ id: string }>;

  /** Restore the workspace to a previously captured checkpoint. */
  restoreWorkspaceCheckpoint?(
    session: WorkbenchSession,
    checkpointId: string,
  ): Promise<{ restored: boolean; detail?: string }>;

  /** Export build outputs and logs as an artifact bundle. */
  exportArtifacts?(session: WorkbenchSession): Promise<WorkbenchExportResult>;

  /** Browser-level preview inspection with screenshot, DOM, and console state. */
  inspectPreview?(session: WorkbenchSession, url: string): Promise<WorkbenchPreviewInspection>;

  /**
   * Capture an artifact record. Implementations should write to store.
   * Returns the created artifact and event.
   */
  captureArtifact(
    session: WorkbenchSession,
    input: WorkbenchCaptureArtifactInput
  ): Promise<{ artifact: WorkbenchArtifact; event: WorkbenchEvent }>;
}

// ── Registry ──────────────────────────────────────────────────────────────────

const registry = new Map<string, WorkbenchProviderAdapter>();

export function registerWorkbenchProvider(adapter: WorkbenchProviderAdapter): void {
  registry.set(adapter.name, adapter);
}

export function getWorkbenchProvider(name?: string): WorkbenchProviderAdapter {
  const key = name ?? (process.env.NODE_ENV === "production" ? undefined : "mock_local");
  if (!key) {
    throw new Error("Workbench provider is required in production. Configure WORKBENCH_DEFAULT_PROVIDER, DAYTONA_API_KEY, or E2B_API_KEY.");
  }
  const adapter = registry.get(key);
  if (!adapter) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(`Unknown Workbench provider "${key}". Production cannot fall back to mock_local.`);
    }
    // Fallback: always return mock_local if an unknown provider is requested.
    const fallback = registry.get("mock_local");
    if (!fallback) throw new Error("mock_local workbench provider not registered");
    return fallback;
  }
  return adapter;
}
