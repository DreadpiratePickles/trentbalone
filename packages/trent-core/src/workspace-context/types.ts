/**
 * A2.1 workspace context files: the shapes, and the two caps that bound them.
 *
 * Pure data and no I/O, so `config/schema.ts` and the loader can both import it without a cycle.
 */

/** Per-file cap, `workspace.max_file_chars`. A file over it is cut with a marker, never dropped silently. */
export const DEFAULT_WORKSPACE_MAX_FILE_CHARS = 12_000;
/** Cap over every loaded file together, `workspace.max_total_chars`. */
export const DEFAULT_WORKSPACE_MAX_TOTAL_CHARS = 24_000;

/** The command a user runs to let Trent read a workspace's instruction files. */
export const WORKSPACE_TRUST_COMMAND = "trent workspace trust";

/**
 * The caps, as `config.yaml` carries them. Declared structurally rather than imported from
 * `config/schema.ts` so the loader stays free of the config module, and so a caller may pass the
 * whole `TrentConfig` (it satisfies this shape) or nothing at all.
 */
export interface WorkspaceContextConfig {
  readonly max_file_chars?: number | undefined;
  readonly max_total_chars?: number | undefined;
}

export interface WorkspaceConfigHolder {
  readonly workspace?: WorkspaceContextConfig | undefined;
}

/**
 * One instruction file, ready for the prelude.
 *
 * `path` is POSIX and relative to `workspaceRoot`, which is what a reader recognises and what the
 * refusals are keyed by. `chars` is the number of the file's own characters that were loaded, which
 * is the number charged against both caps; when a cap cut the file, `content` carries one extra
 * marker line beyond that so the model and the user can see the cut happened.
 */
export interface WorkspaceBlock {
  readonly path: string;
  readonly content: string;
  readonly chars: number;
}

/** A candidate that was found and not loaded, with the reason, for the REPL banner and `workspace status`. */
export interface WorkspaceRefusal {
  readonly path: string;
  readonly reason: string;
}

/** The result of reading a workspace without consulting the trust record. */
export interface WorkspaceScan {
  readonly workspaceRoot: string;
  readonly blocks: WorkspaceBlock[];
  readonly refused: WorkspaceRefusal[];
  /** sha256 over every candidate's path and bytes, refused ones included. */
  readonly contentHash: string;
  readonly totalChars: number;
}

/**
 * What `loadWorkspaceContext` hands its caller. An untrusted workspace returns `trusted: false`,
 * no blocks, no refusals, an empty `contentHash` (nothing was read) and a one-line `instruction`.
 */
export interface WorkspaceContext {
  readonly trusted: boolean;
  readonly blocks: WorkspaceBlock[];
  readonly refused: WorkspaceRefusal[];
  readonly workspaceRoot: string;
  /** Present only when untrusted: one line naming the command that would trust this root. */
  readonly instruction: string | null;
  readonly contentHash: string;
  readonly changedSinceTrusted: boolean;
}

export interface WorkspaceStatusFile {
  readonly path: string;
  readonly chars: number;
  readonly truncated: boolean;
}

/** `trent workspace status`: everything without loading anything into a prompt. */
export interface WorkspaceStatus {
  readonly workspaceRoot: string;
  readonly cwd: string;
  readonly trusted: boolean;
  readonly trustedAt: string | null;
  readonly changedSinceTrusted: boolean;
  readonly files: WorkspaceStatusFile[];
  readonly refused: WorkspaceRefusal[];
  readonly totalChars: number;
  readonly maxFileChars: number;
  readonly maxTotalChars: number;
  readonly trustFile: string;
  readonly instruction: string | null;
}

export interface WorkspaceCaps {
  readonly maxFileChars: number;
  readonly maxTotalChars: number;
}

/** A cap given in config wins; anything absent or unusable falls back to the shipped default. */
export function workspaceCaps(config?: WorkspaceConfigHolder | undefined): WorkspaceCaps {
  const block = config?.workspace;
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
  return {
    maxFileChars: positive(block?.max_file_chars, DEFAULT_WORKSPACE_MAX_FILE_CHARS),
    maxTotalChars: positive(block?.max_total_chars, DEFAULT_WORKSPACE_MAX_TOTAL_CHARS),
  };
}

/** The one line an untrusted workspace returns, naming the command that would trust it. */
export function trustInstruction(workspaceRoot: string): string {
  return (
    `This workspace is not trusted, so none of its instruction files were read. ` +
    `Run: ${WORKSPACE_TRUST_COMMAND} ${workspaceRoot}`
  );
}
