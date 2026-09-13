export { createFileOpsAdapter, FILE_OPS_NAME, FILE_OPS_SCOPES, FILE_OPS_INSTRUCTIONS, FILE_OPS_ROUTING_TEXT } from "./adapter.js";
export { resolveWorkspacePath, isProtectedInstructionFile, deniedReason, PathPolicyError } from "./paths.js";
export { fuzzyFind, applySpans, unifiedDiff } from "./fuzzy.js";
