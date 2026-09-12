/**
 * Typed artifact capture helpers for workbench sessions.
 *
 * Each function serialises structured data and calls provider.captureArtifact()
 * so the record lands in the store and audit trail. Works with any provider.
 */

import * as path from "path";
import { getWorkbenchProvider } from "@/lib/workbench-provider";
import type { WorkbenchArtifact, WorkbenchEvent, WorkbenchSession } from "@/lib/types";

// ── HAR types (HTTP Archive format subset) ────────────────────────────────────

export type HarEntry = {
  startedDateTime: string;
  method: string;
  url: string;
  status: number;
  mimeType: string;
  requestBodySize: number;
  responseBodySize: number;
  /** Timing breakdown in ms. */
  timings: { send: number; wait: number; receive: number };
};

export type HarDocument = {
  log: {
    version: "1.2";
    creator: { name: "trent"; version: "1.0" };
    entries: HarEntry[];
  };
};

// ── Perf trace types ──────────────────────────────────────────────────────────

export type PerfTraceEntry = {
  name: string;
  startMs: number;
  durationMs: number;
  phase?: string;
  metadata?: Record<string, unknown>;
};

export type PerfTraceDocument = {
  sessionId: string;
  capturedAt: string;
  entries: PerfTraceEntry[];
};

// ── MIME helpers ──────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  ".ts": "text/plain", ".tsx": "text/plain", ".js": "text/javascript",
  ".json": "application/json", ".md": "text/markdown", ".txt": "text/plain",
  ".html": "text/html", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".zip": "application/zip", ".log": "text/plain", ".yml": "text/yaml",
  ".yaml": "text/yaml", ".sh": "text/plain",
};

function mimeForPath(filePath: string): string {
  return MIME_MAP[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

// ── Capture helpers ───────────────────────────────────────────────────────────

/**
 * Read a file from the session workdir and store it as a "file" artifact.
 */
export async function captureFileArtifact(
  session: WorkbenchSession,
  filePath: string
): Promise<{ artifact: WorkbenchArtifact; event: WorkbenchEvent }> {
  const provider = getWorkbenchProvider(session.provider);
  let content = "";
  try {
    content = await provider.readFile(session, filePath);
  } catch (err: unknown) {
    content = `[read error: ${(err as Error).message}]`;
  }

  return provider.captureArtifact(session, {
    title: `file: ${path.basename(filePath)}`,
    kind: "file",
    mimeType: mimeForPath(filePath),
    content: content.slice(0, 8_000),
    sizeBytes: content.length,
  });
}

/**
 * Build and store an HTTP Archive (HAR) artifact from collected network entries.
 */
export async function captureHarArtifact(
  session: WorkbenchSession,
  entries: HarEntry[]
): Promise<{ artifact: WorkbenchArtifact; event: WorkbenchEvent }> {
  const doc: HarDocument = {
    log: { version: "1.2", creator: { name: "trent", version: "1.0" }, entries },
  };
  const content = JSON.stringify(doc, null, 2);

  const provider = getWorkbenchProvider(session.provider);
  return provider.captureArtifact(session, {
    title: "network.har",
    kind: "har",
    mimeType: "application/json",
    content: content.slice(0, 8_000),
    sizeBytes: content.length,
  });
}

/**
 * Store a performance trace as a "perf_trace" artifact.
 */
export async function capturePerfTraceArtifact(
  session: WorkbenchSession,
  entries: PerfTraceEntry[]
): Promise<{ artifact: WorkbenchArtifact; event: WorkbenchEvent }> {
  const doc: PerfTraceDocument = {
    sessionId: session.id,
    capturedAt: new Date().toISOString(),
    entries,
  };
  const content = JSON.stringify(doc, null, 2);

  const provider = getWorkbenchProvider(session.provider);
  return provider.captureArtifact(session, {
    title: "perf-trace.json",
    kind: "perf_trace",
    mimeType: "application/json",
    content: content.slice(0, 8_000),
    sizeBytes: content.length,
  });
}

/**
 * Capture a directory listing or a set of files as an "export" artifact manifest.
 * For a real implementation the provider would zip the files; here we store the manifest.
 */
export async function captureExportArtifact(
  session: WorkbenchSession,
  paths?: string[]
): Promise<{ artifact: WorkbenchArtifact; event: WorkbenchEvent }> {
  const provider = getWorkbenchProvider(session.provider);
  const files = paths ?? (await provider.listFiles(session)).map((f) => f.path);
  const manifest = { sessionId: session.id, exportedAt: new Date().toISOString(), files };
  const content = JSON.stringify(manifest, null, 2);

  return provider.captureArtifact(session, {
    title: "export-manifest.json",
    kind: "export",
    mimeType: "application/json",
    content,
    sizeBytes: content.length,
  });
}

/**
 * Capture terminal output (stdout + stderr) as a "terminal_log" artifact.
 */
export async function captureTerminalLog(
  session: WorkbenchSession,
  stdout: string,
  stderr: string,
  command?: string
): Promise<{ artifact: WorkbenchArtifact; event: WorkbenchEvent }> {
  const combined = [
    command ? `$ ${command}` : "",
    stdout,
    stderr ? `[stderr]\n${stderr}` : "",
  ].filter(Boolean).join("\n");

  const provider = getWorkbenchProvider(session.provider);
  return provider.captureArtifact(session, {
    title: command ? `log: ${command.slice(0, 60)}` : "terminal.log",
    kind: "terminal_log",
    mimeType: "text/plain",
    content: combined.slice(0, 8_000),
    sizeBytes: combined.length,
  });
}
