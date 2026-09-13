/**
 * Trent's toolsets for the seats: every Hermes tool, one adapter per toolset, built from
 * `config.toolsets - config.disabled_toolsets` and registered into the read-only app through the
 * `registerExternalAdapters` seam (`apps/web/lib/tools.ts`). One adapter per toolset is deliberate:
 * the router advertises the top three catalog entries per step, so a family must be one entry.
 */
import type { TrentConfig } from "../config/schema.js";
import { createFileOpsAdapter } from "./file_ops/index.js";
import { createTerminalAdapter } from "./terminal/index.js";
import type { ToolContext, TrentToolAdapter } from "./types.js";

export type { ToolAdapter, ToolCallRecord, ToolContext, TrentToolAdapter } from "./types.js";
export { floorBlock, dangerous, normaliseForDetection } from "./approval-floors.js";
export { createFileOpsAdapter, FILE_OPS_NAME, FILE_OPS_SCOPES } from "./file_ops/index.js";
export { createTerminalAdapter, TERMINAL_NAME, TERMINAL_SCOPES } from "./terminal/index.js";
export { fitSummary, headTail, spill, spilloverDir, SUMMARY_LIMIT } from "./spillover.js";
export { createSandbox, type Sandbox } from "./sandbox.js";

/** The config slice the tool builder reads. */
export type ToolBuildConfig = Pick<TrentConfig, "toolsets" | "disabled_toolsets"> & {
  readonly terminal?: { readonly backend?: TrentConfig["terminal"]["backend"]; readonly docker?: { readonly image?: string } };
};

export interface ToolBuildDeps {
  readonly workspace: string;
  readonly profileDir: string;
  readonly egress?: ToolContext["egress"];
  readonly autoApproveWrites?: boolean;
  /** Overrides the config's backend; tests use it to force `local` or an image. */
  readonly backend?: ToolContext["backend"];
  readonly dockerImage?: string;
}

/** The toolsets this build implements; the rest of Hermes's twelve arrive through the same seam. */
export const IMPLEMENTED_TOOLSETS = ["file_ops", "terminal"] as const;

export function enabledToolsets(config: ToolBuildConfig): string[] {
  const disabled = new Set(config.disabled_toolsets ?? []);
  return (config.toolsets ?? []).filter((toolset) => !disabled.has(toolset));
}

export function buildTrentToolAdapters(config: ToolBuildConfig, deps: ToolBuildDeps): TrentToolAdapter[] {
  const backend = deps.backend ?? (config.terminal?.backend === "local" ? "local" : "docker");
  const ctx: ToolContext = {
    workspace: deps.workspace,
    profileDir: deps.profileDir,
    backend,
    docker: { image: deps.dockerImage ?? config.terminal?.docker?.image ?? "trent-sandbox:latest" },
    egress: deps.egress,
    autoApproveWrites: deps.autoApproveWrites,
  };
  const adapters: TrentToolAdapter[] = [];
  for (const toolset of enabledToolsets(config)) {
    if (toolset === "file_ops") adapters.push(createFileOpsAdapter(ctx));
    else if (toolset === "terminal") adapters.push(createTerminalAdapter(ctx));
  }
  return adapters;
}
