/**
 * The trust record: `<profileDir>/workspace-trust.json`, mode 0600, keyed by the realpath of the
 * workspace root.
 *
 * A workspace is untrusted until it is in this file, and an untrusted workspace is never read. The
 * entry keeps the content hash trust was granted over (`trustedHash`) and the hash of the last
 * load (`lastHash`): a change after the fact does not revoke trust — that would make every edit a
 * prompt — but it is visible in `trent workspace status` as "changed since trusted".
 *
 * Writes are temp-file-then-rename with the mode re-asserted, the same way the cron store and the
 * secrets file are written, so a crash mid-write leaves the previous record whole.
 */
import fs from "node:fs";
import path from "node:path";
import { NODE_IO, atomicWriteFileSync } from "../config/atomic-fs.js";

export const WORKSPACE_TRUST_FILE = "workspace-trust.json";
export const WORKSPACE_TRUST_FILE_MODE = 0o600;
const TRUST_FILE_VERSION = 1;

export interface WorkspaceTrustEntry {
  /** ISO timestamp of the moment a human said yes. */
  readonly trustedAt: string;
  /** Content hash at that moment. */
  readonly trustedHash: string;
  /** Content hash of the most recent load. */
  readonly lastHash: string;
  readonly lastSeenAt: string;
}

export interface WorkspaceTrustFile {
  readonly version: number;
  readonly workspaces: Record<string, WorkspaceTrustEntry>;
}

export function workspaceTrustPath(profileDir: string): string {
  return path.join(profileDir, WORKSPACE_TRUST_FILE);
}

const EMPTY: WorkspaceTrustFile = { version: TRUST_FILE_VERSION, workspaces: {} };

function isEntry(value: unknown): value is WorkspaceTrustEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.trustedAt === "string" && typeof entry.trustedHash === "string";
}

/**
 * The record on disk. A missing, unreadable or malformed file reads as "nothing is trusted": the
 * failure mode of a corrupt trust file must be no context, never blanket trust.
 */
export function readWorkspaceTrustFile(profileDir: string): WorkspaceTrustFile {
  const file = workspaceTrustPath(profileDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ...EMPTY, workspaces: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY, workspaces: {} };
  }
  const workspaces: Record<string, WorkspaceTrustEntry> = {};
  const source = (parsed as { workspaces?: unknown })?.workspaces;
  if (source && typeof source === "object") {
    for (const [root, entry] of Object.entries(source as Record<string, unknown>)) {
      if (!isEntry(entry)) continue;
      workspaces[root] = {
        trustedAt: entry.trustedAt,
        trustedHash: entry.trustedHash,
        lastHash: typeof entry.lastHash === "string" ? entry.lastHash : entry.trustedHash,
        lastSeenAt: typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : entry.trustedAt,
      };
    }
  }
  return { version: TRUST_FILE_VERSION, workspaces };
}

export function writeWorkspaceTrustFile(profileDir: string, file: WorkspaceTrustFile): void {
  fs.mkdirSync(profileDir, { recursive: true });
  atomicWriteFileSync(
    NODE_IO,
    workspaceTrustPath(profileDir),
    `${JSON.stringify({ version: TRUST_FILE_VERSION, workspaces: file.workspaces }, null, 2)}\n`,
    WORKSPACE_TRUST_FILE_MODE,
  );
}

/** The entry for this root, or null when the workspace has never been trusted. */
export function readWorkspaceTrustEntry(profileDir: string, workspaceRoot: string): WorkspaceTrustEntry | null {
  return readWorkspaceTrustFile(profileDir).workspaces[workspaceRoot] ?? null;
}

export function putWorkspaceTrustEntry(profileDir: string, workspaceRoot: string, entry: WorkspaceTrustEntry): void {
  const file = readWorkspaceTrustFile(profileDir);
  writeWorkspaceTrustFile(profileDir, { ...file, workspaces: { ...file.workspaces, [workspaceRoot]: entry } });
}

/** False when there was nothing to remove, so the CLI can say so instead of claiming a change. */
export function removeWorkspaceTrustEntry(profileDir: string, workspaceRoot: string): boolean {
  const file = readWorkspaceTrustFile(profileDir);
  if (!(workspaceRoot in file.workspaces)) return false;
  const workspaces = { ...file.workspaces };
  delete workspaces[workspaceRoot];
  writeWorkspaceTrustFile(profileDir, { ...file, workspaces });
  return true;
}

/**
 * Stamps what a load actually read. Trust is not re-granted and `trustedHash` is not touched, so
 * the "changed since trusted" comparison keeps its meaning.
 */
export function recordWorkspaceLoad(profileDir: string, workspaceRoot: string, contentHash: string, at: string): void {
  const entry = readWorkspaceTrustEntry(profileDir, workspaceRoot);
  if (entry === null) return;
  if (entry.lastHash === contentHash) return;
  putWorkspaceTrustEntry(profileDir, workspaceRoot, { ...entry, lastHash: contentHash, lastSeenAt: at });
}
