/**
 * workbench-upload.ts — safe expansion of user uploads into a Workbench
 * workspace (Fix Plan Slice 4, RC1).
 *
 * Testers showed agents asking for files the founder had already uploaded.
 * This module turns raw uploads (single files, folders via relative paths,
 * and .zip archives) into a validated write plan:
 *   - path traversal blocked (`../secrets.env`, absolute paths, drive letters)
 *   - file count / per-file / total byte limits enforced
 *   - zip archives expanded server-side preserving directory structure
 *   - binary files skipped with an explicit reason (provider writes are text)
 *
 * Pure module: callers (the uploads API route) do the provider writes and
 * event recording. No store, no provider, fully unit-testable.
 */

import { unzipSync } from "fflate";

export type UploadFileInput = {
  /** Original filename (basename or browser-relative path). */
  name: string;
  /** Optional folder-upload relative path (webkitRelativePath). */
  relativePath?: string;
  bytes: Uint8Array;
};

export type UploadEntry = {
  path: string;
  size: number;
  status: "ok" | "skipped";
  reason?: string;
  /** UTF-8 content for ok entries. */
  content?: string;
  /** Where the entry came from (direct upload or a zip member). */
  source: "file" | "zip";
};

export type UploadLimits = {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
};

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxFiles: 200,
  maxFileBytes: 5 * 1024 * 1024,    // 5 MB per file
  maxTotalBytes: 25 * 1024 * 1024,  // 25 MB per upload batch
};

/**
 * Normalize and validate a workspace-relative path.
 * Returns null for traversal attempts, absolute paths, or empty paths.
 */
export function sanitizeUploadPath(raw: string): string | null {
  if (!raw) return null;
  const normalized = raw.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("/")) return null;
  if (/^[A-Za-z]:/.test(normalized)) return null;
  const segments = normalized.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  for (const segment of segments) {
    if (segment === ".." || segment === ".") return null;
    if (segment.includes("\0")) return null;
  }
  return segments.join("/");
}

const TEXT_EXTENSIONS = /\.(md|txt|csv|tsv|json|jsonl|yml|yaml|toml|xml|html|css|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|sh|sql|env|gitignore|svg|lock|cfg|ini|conf|log)$/i;

/** Heuristic text detection: known text extension, or no NUL bytes in the head. */
export function isProbablyText(bytes: Uint8Array, name: string): boolean {
  if (TEXT_EXTENSIONS.test(name)) return true;
  const head = bytes.subarray(0, Math.min(bytes.length, 4096));
  for (let i = 0; i < head.length; i++) {
    if (head[i] === 0) return false;
  }
  return true;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function entryFor(
  path: string,
  bytes: Uint8Array,
  source: "file" | "zip",
  limits: UploadLimits,
): UploadEntry {
  if (bytes.length > limits.maxFileBytes) {
    return {
      path, size: bytes.length, status: "skipped", source,
      reason: `file exceeds per-file limit (${bytes.length} > ${limits.maxFileBytes} bytes)`,
    };
  }
  if (!isProbablyText(bytes, path)) {
    return {
      path, size: bytes.length, status: "skipped", source,
      reason: "binary file — workbench providers accept text files only (upload data as csv/json/md)",
    };
  }
  return { path, size: bytes.length, status: "ok", source, content: decodeText(bytes) };
}

/**
 * Expand raw uploads into a validated write plan.
 * Zip archives are extracted (directories preserved); everything else is
 * written at its sanitized relative path.
 */
export function expandUploads(
  files: UploadFileInput[],
  limits: UploadLimits = DEFAULT_UPLOAD_LIMITS,
): { entries: UploadEntry[]; errors: string[] } {
  const entries: UploadEntry[] = [];
  const errors: string[] = [];
  let totalBytes = 0;

  const push = (path: string, bytes: Uint8Array, source: "file" | "zip") => {
    if (entries.filter((e) => e.status === "ok").length >= limits.maxFiles) {
      errors.push(`file count limit reached (${limits.maxFiles}); remaining entries skipped`);
      return false;
    }
    totalBytes += bytes.length;
    if (totalBytes > limits.maxTotalBytes) {
      errors.push(`total upload size limit exceeded (${limits.maxTotalBytes} bytes); remaining entries skipped`);
      return false;
    }
    entries.push(entryFor(path, bytes, source, limits));
    return true;
  };

  for (const file of files) {
    const rawPath = file.relativePath?.trim() || file.name;

    if (/\.zip$/i.test(rawPath)) {
      let unzipped: Record<string, Uint8Array>;
      try {
        unzipped = unzipSync(file.bytes);
      } catch (err) {
        errors.push(`${rawPath}: could not extract zip (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      for (const [memberPath, memberBytes] of Object.entries(unzipped)) {
        if (memberPath.endsWith("/")) continue; // directory marker
        const safe = sanitizeUploadPath(memberPath);
        if (!safe) {
          entries.push({
            path: memberPath, size: memberBytes.length, status: "skipped", source: "zip",
            reason: "unsafe path (traversal or absolute) — rejected",
          });
          continue;
        }
        if (!push(safe, memberBytes, "zip")) break;
      }
      continue;
    }

    const safe = sanitizeUploadPath(rawPath);
    if (!safe) {
      entries.push({
        path: rawPath, size: file.bytes.length, status: "skipped", source: "file",
        reason: "unsafe path (traversal or absolute) — rejected",
      });
      continue;
    }
    if (!push(safe, file.bytes, "file")) break;
  }

  return { entries, errors };
}

/** One-line summary for events/UI: counts only, never file contents. */
export function summarizeUpload(entries: UploadEntry[], errors: string[]): string {
  const ok = entries.filter((e) => e.status === "ok");
  const skipped = entries.filter((e) => e.status === "skipped");
  const bytes = ok.reduce((sum, e) => sum + e.size, 0);
  const parts = [`${ok.length} file${ok.length === 1 ? "" : "s"} written (${bytes} bytes)`];
  if (skipped.length) parts.push(`${skipped.length} skipped`);
  if (errors.length) parts.push(`${errors.length} error${errors.length === 1 ? "" : "s"}`);
  return parts.join(", ");
}
