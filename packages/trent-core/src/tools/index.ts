/**
 * Trent's toolsets for the seats: every Hermes tool, one adapter per toolset, built from
 * `config.toolsets - config.disabled_toolsets` and registered into the read-only app through the
 * `registerExternalAdapters` seam (`apps/web/lib/tools.ts`). One adapter per toolset is deliberate:
 * the router advertises the top three catalog entries per step, so a family must be one entry.
 */
import fs from "node:fs";
import process from "node:process";
import type { Toolset, TrentConfig } from "../config/schema.js";
import { SANDBOX_IMAGE } from "../terminal/sandbox-image.js";
import { createCodeExecutionAdapter } from "./code_execution/index.js";
import { createCronAdapter } from "./cron/index.js";
import { createDelegateAdapter } from "./delegate/index.js";
import type { DelegatePort } from "./delegate/types.js";
import { createFileOpsAdapter } from "./file_ops/index.js";
import { createPluginsAdapter } from "./plugins/index.js";
import { createSkillsAdapter } from "./skills/index.js";
import { createTerminalAdapter } from "./terminal/index.js";
import { createWebToolsAdapter } from "./web/index.js";
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
export { createWebToolsAdapter, WEB_ADAPTER_NAME, WEB_TOOL_SCHEMAS } from "./web/index.js";
export { createSkillsAdapter, SKILLS_ADAPTER_NAME, SKILL_TOOL_SCHEMAS } from "./skills/index.js";
export { createCronAdapter, CRON_ADAPTER_NAME, CRON_TOOL_SCHEMAS } from "./cron/index.js";

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
  /**
   * The proxy URL as reachable from THIS process, for `web`, when `egress.proxyUrl` is the
   * sandbox-side alias (`host.docker.internal`). Defaults to `egress.proxyUrl`.
   */
  readonly egressHostUrl?: string;
  /** The env `web` reads TAVILY_API_KEY / JINA_API_KEY from; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Override `<profileDir>/skills`. */
  readonly skillsDir?: string;
}

/** One toolset that was enabled in config but could not be built here, and why the seat cannot use it. */
export interface SkippedToolset {
  readonly toolset: string;
  readonly reason: string;
}

export interface TrentToolBuild {
  readonly adapters: TrentToolAdapter[];
  readonly skipped: SkippedToolset[];
}

/**
 * The toolsets this builder implements, keyed by the config's `ToolsetSchema` names (`code` is
 * Hermes's `code_execution`). This list is the single truth: `tools-index.test.ts` checks that
 * every `ToolsetSchema` value is either here or in `NOT_YET_IMPLEMENTED` with a reason, so a new
 * enum value can never be a silent no-op.
 */
export const IMPLEMENTED_TOOLSETS = ["file_ops", "terminal", "web", "code", "delegation", "cron", "skills", "plugins"] as const satisfies readonly Toolset[];

/** Enum values this builder does NOT produce, each with the reason a seat will see. */
export const NOT_YET_IMPLEMENTED: readonly { readonly toolset: Toolset; readonly reason: string }[] = [
  { toolset: "memory", reason: "registered by the fleet-memory hook (apps/cli/src/repl/fleet-memory.ts), not by this builder" },
  { toolset: "browser", reason: "no browser adapter yet; the read-only app's Steel/Camofox adapters are registered by apps/web/lib/tools.ts" },
  { toolset: "vision", reason: "no vision adapter yet" },
  { toolset: "mcp", reason: "MCP connectors are configured per profile (`/mcp`); no toolset adapter yet" },
];

export function enabledToolsets(config: ToolBuildConfig): string[] {
  const disabled = new Set(config.disabled_toolsets ?? []);
  return (config.toolsets ?? []).filter((toolset) => !disabled.has(toolset));
}

function readCaPem(caCertPath: string): string | undefined {
  try {
    return fs.readFileSync(caCertPath, "utf8");
  } catch {
    return undefined;
  }
}

/** Builds every enabled toolset it can; the ones it cannot are returned in `skipped` with a reason. */
export function buildTrentTools(config: ToolBuildConfig, deps: ToolBuildDeps): TrentToolBuild {
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
  const skipped: SkippedToolset[] = [];
  const pending = new Map(NOT_YET_IMPLEMENTED.map((entry) => [entry.toolset as string, entry.reason]));
  for (const toolset of enabledToolsets(config)) {
    if (toolset === "file_ops") adapters.push(createFileOpsAdapter(ctx));
    else if (toolset === "terminal") adapters.push(createTerminalAdapter(ctx));
    else if (toolset === "code") adapters.push(createCodeExecutionAdapter(ctx));
    else if (toolset === "delegation") adapters.push(createDelegateAdapter({ profileDir: deps.profileDir, ...(deps.delegate ? { port: deps.delegate } : {}) }));
    else if (toolset === "plugins") adapters.push(createPluginsAdapter(ctx, deps.pluginsDir ? { pluginsDir: deps.pluginsDir } : {}));
    else if (toolset === "skills") adapters.push(createSkillsAdapter({ profileDir: deps.profileDir, ...(deps.skillsDir ? { skillsDir: deps.skillsDir } : {}) }));
    else if (toolset === "cron") adapters.push(createCronAdapter({ profileDir: deps.profileDir }));
    else if (toolset === "web") {
      // web_search / web_extract only ever go out through the egress proxy: no proxy, no web.
      if (!deps.egress) {
        skipped.push({ toolset, reason: "the egress proxy is not running; web_search/web_extract have no transport" });
        continue;
      }
      const caPem = readCaPem(deps.egress.caCertPath);
      if (caPem === undefined) {
        skipped.push({ toolset, reason: `the egress CA certificate could not be read at ${deps.egress.caCertPath}` });
        continue;
      }
      adapters.push(
        createWebToolsAdapter({
          profileDir: deps.profileDir,
          env: deps.env ?? process.env,
          egress: { proxyUrl: deps.egressHostUrl ?? deps.egress.proxyUrl, token: deps.egress.token, caPem },
        }),
      );
    } else {
      skipped.push({ toolset, reason: pending.get(toolset) ?? `"${toolset}" is not a toolset this builder knows` });
    }
  }
  return { adapters, skipped };
}

/** `buildTrentTools(...).adapters`: the shape the orchestrator and the older callers take. */
export function buildTrentToolAdapters(config: ToolBuildConfig, deps: ToolBuildDeps): TrentToolAdapter[] {
  return buildTrentTools(config, deps).adapters;
}
