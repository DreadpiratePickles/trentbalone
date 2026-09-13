/**
 * Trent's toolsets for the seats: every Hermes tool, one adapter per toolset, built from
 * `config.toolsets - config.disabled_toolsets` and registered into the read-only app through the
 * `registerExternalAdapters` seam (`apps/web/lib/tools.ts`). One adapter per toolset is deliberate:
 * the router advertises the top three catalog entries per step, so a family must be one entry.
 */
import type { TrentConfig } from "../config/schema.js";
import { SANDBOX_IMAGE } from "../terminal/sandbox-image.js";
import { createCodeExecutionAdapter } from "./code_execution/index.js";
import { createDelegateAdapter } from "./delegate/index.js";
import type { DelegatePort } from "./delegate/types.js";
import { createFileOpsAdapter } from "./file_ops/index.js";
import { createPluginsAdapter } from "./plugins/index.js";
import { createTerminalAdapter } from "./terminal/index.js";
import type { ToolContext, TrentToolAdapter } from "./types.js";

export type { ToolAdapter, ToolCallRecord, ToolContext, TrentToolAdapter } from "./types.js";
export { floorBlock, dangerous, normaliseForDetection } from "./approval-floors.js";
export { createFileOpsAdapter, FILE_OPS_NAME, FILE_OPS_SCOPES } from "./file_ops/index.js";
export { createTerminalAdapter, TERMINAL_NAME, TERMINAL_SCOPES } from "./terminal/index.js";
export { fitSummary, headTail, spill, spilloverDir, SUMMARY_LIMIT } from "./spillover.js";
export { createSandbox, type Sandbox } from "./sandbox.js";
export { createCodeExecutionAdapter, CODE_EXECUTION_NAME, CODE_EXECUTION_SCOPES, CODE_EXECUTION_SCHEMAS } from "./code_execution/index.js";
export { createDelegateAdapter, DELEGATE_ADAPTER_NAME, DELEGATE_SCOPES, DELEGATE_TOOL_SCHEMAS } from "./delegate/index.js";
export type { DelegatePort, DelegateRequest, DelegateResult } from "./delegate/types.js";
export { createPluginsAdapter, loadPluginManifests, PLUGINS_ADAPTER_NAME, PLUGIN_NAME_PATTERN } from "./plugins/index.js";
export { BUILTIN_TOOL_NAMES, BUILTIN_TOOLS_BY_TOOLSET, isBuiltinToolName } from "./tool-names.js";

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
  /** The orchestrator's delegation path; without it `delegate_task` reports `not_available`. */
  readonly delegate?: DelegatePort;
  /** Where `plugins` reads `<name>/plugin.json`; defaults to `<profileDir>/plugins`. */
  readonly pluginsDir?: string;
}

/**
 * The toolsets this builder implements, keyed by the config's `ToolsetSchema` names (`code` is
 * Hermes's `code_execution`). memory/web/skills/cron have adapters of their own that the fleet
 * hook and the wiring layer register separately.
 */
export const IMPLEMENTED_TOOLSETS = ["file_ops", "terminal", "code", "delegation", "plugins"] as const;

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
    docker: { image: deps.dockerImage ?? config.terminal?.docker?.image ?? SANDBOX_IMAGE },
    egress: deps.egress,
    autoApproveWrites: deps.autoApproveWrites,
  };
  const adapters: TrentToolAdapter[] = [];
  for (const toolset of enabledToolsets(config)) {
    if (toolset === "file_ops") adapters.push(createFileOpsAdapter(ctx));
    else if (toolset === "terminal") adapters.push(createTerminalAdapter(ctx));
    else if (toolset === "code") adapters.push(createCodeExecutionAdapter(ctx));
    else if (toolset === "delegation") adapters.push(createDelegateAdapter({ profileDir: deps.profileDir, ...(deps.delegate ? { port: deps.delegate } : {}) }));
    else if (toolset === "plugins") adapters.push(createPluginsAdapter(ctx, deps.pluginsDir ? { pluginsDir: deps.pluginsDir } : {}));
  }
  return adapters;
}
