/**
 * A2.1 workspace context files.
 *
 * `loadWorkspaceContext({ cwd, profileDir, config })` is the whole seam: it returns the workspace's
 * instruction files as blocks, in the order the prelude renders them, or nothing at all with a line
 * telling the user how to trust the workspace. It assembles no prompt — task A1's prelude decides
 * where the blocks go — and it never reads a file outside the workspace root or the working
 * directory. See docs/configuration.md, "Workspace context files".
 */
export {
  loadWorkspaceContext,
  scanWorkspaceFiles,
  trustWorkspace,
  untrustWorkspace,
  workspaceStatus,
  type WorkspaceLoadOptions,
  type WorkspaceScanOptions,
} from "./load.js";
export {
  readWorkspaceTrustEntry,
  readWorkspaceTrustFile,
  workspaceTrustPath,
  WORKSPACE_TRUST_FILE,
  WORKSPACE_TRUST_FILE_MODE,
  type WorkspaceTrustEntry,
  type WorkspaceTrustFile,
} from "./trust.js";
export { resolveWorkspaceRoot, type ResolvedWorkspace } from "./discover.js";
export {
  DEFAULT_WORKSPACE_MAX_FILE_CHARS,
  DEFAULT_WORKSPACE_MAX_TOTAL_CHARS,
  WORKSPACE_TRUST_COMMAND,
  trustInstruction,
  workspaceCaps,
  type WorkspaceBlock,
  type WorkspaceCaps,
  type WorkspaceConfigHolder,
  type WorkspaceContext,
  type WorkspaceContextConfig,
  type WorkspaceRefusal,
  type WorkspaceScan,
  type WorkspaceStatus,
  type WorkspaceStatusFile,
} from "./types.js";
