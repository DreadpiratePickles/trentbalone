/**
 * The workspace's instruction files, on their way into a prompt and onto the screen.
 *
 * `loadWorkspaceContext` (`@trent/core/workspace-context`) decides WHETHER a file may be read —
 * trust first, then the prompt-injection scan, then the caps. This module decides how the files it
 * returns are WORDED for the stable tier, and what the user is told about the ones that were left
 * out. It reads nothing from disk and makes no trust decision of its own.
 *
 * The rendered text lands under `CONTEXT_BLOCKS.workspace` in the STABLE tier
 * (`fleet-memory/tiers.ts`), which is why the heading carries the workspace root and nothing that
 * changes between seats or turns: the tier's bytes have to be identical across runs of one profile.
 */

import type { WorkspaceContext } from "@trent/core/workspace-context/index.js";

/** The stable tier's workspace heading. One line, so a diff of two preludes stays readable. */
export function workspaceHeading(workspaceRoot: string): string {
  return `## Workspace instruction files (${workspaceRoot}, trusted by the user)`;
}

/**
 * The rendered block, or `undefined` when there is nothing to render — an untrusted workspace, or a
 * trusted one with no instruction files. `undefined` and not an empty string: the hook branches on
 * absence, and an empty block would still cost a separator in the prelude.
 */
export function renderWorkspaceContext(context: WorkspaceContext): string | undefined {
  if (!context.trusted || context.blocks.length === 0) return undefined;
  const sections = context.blocks.map((block) => `### ${block.path}\n${block.content}`);
  return [workspaceHeading(context.workspaceRoot), ...sections].join("\n\n");
}

/**
 * What the surface says out loud: one line when the workspace is untrusted (the instruction the
 * module itself returns, naming the command that would trust it), and one line per file that was
 * found and refused, naming the file and the reason. A trusted workspace whose files all loaded
 * produces no lines at all.
 */
export function workspaceNotices(context: WorkspaceContext): string[] {
  const lines: string[] = [];
  if (context.instruction !== null) lines.push(context.instruction);
  for (const refusal of context.refused) lines.push(`Not loaded: ${refusal.path} (${refusal.reason})`);
  return lines;
}
