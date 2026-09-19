/**
 * Trent's toolsets for the seats: every Hermes tool, one adapter per toolset, built from
 * `config.toolsets - config.disabled_toolsets` and registered into the read-only app through the
 * `registerExternalAdapters` seam (`apps/web/lib/tools.ts`). One adapter per toolset is deliberate:
 * the router advertises the top three catalog entries per step, so a family must be one entry.
 */
import fs from "node:fs";
import os from "node:os";
import process from "node:process";
import type { Toolset, TrentConfig } from "../config/schema.js";
import { IdempotencyManager } from "../governance/IdempotencyManager.js";
import { idempotentAdapters } from "../governance/idempotent-dispatch.js";
import { PolicyDispatcher } from "../governance/policy-dispatch.js";
import { autonomyAdapters } from "../governance/autonomy-dispatch.js";
import { DEFAULT_AUTONOMY } from "../governance/autonomy.js";
import { createToolHookRunner } from "../hooks/runner.js";
import type { ToolHookPort } from "../hooks/types.js";
import { SANDBOX_IMAGE } from "../terminal/sandbox-image.js";
import { createCodeExecutionAdapter } from "./code_execution/index.js";
import { createCronAdapter } from "./cron/index.js";
import { createDelegateAdapter } from "./delegate/index.js";
import type { DelegatePort } from "./delegate/types.js";
import { createFileOpsAdapter } from "./file_ops/index.js";
import { createHumanAdapter, type HumanAnswers } from "./human/index.js";
import { createMcpAdapter } from "./mcp/index.js";
import { createPluginsAdapter } from "./plugins/index.js";
import { createSkillsAdapter } from "./skills/index.js";
import { createTerminalAdapter } from "./terminal/index.js";
import { createWebToolsAdapter } from "./web/index.js";
import { createBrowserAdapter } from "./browser/index.js";
import { askVision, createVisionAdapter, type VisionGateway } from "./vision/index.js";
import type { ToolContext, TrentToolAdapter } from "./types.js";

export type { ToolAdapter, ToolCallRecord, ToolContext, TrentToolAdapter } from "./types.js";
export { floorBlock, dangerous, normaliseForDetection, maskQuoted, detectionVariants } from "./approval-floors.js";
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
export { createBrowserAdapter, findChromium, BROWSER_ADAPTER_NAME, BROWSER_TOOL_SCHEMAS } from "./browser/index.js";
export { createVisionAdapter, askVision, VISION_ADAPTER_NAME, VISION_TOOL_SCHEMAS, type VisionGateway } from "./vision/index.js";
export { createHumanAdapter, questionFromEvent, renderQuestion, HumanAnswers, sharedHumanAnswers, HUMAN_ADAPTER_NAME, HUMAN_SCOPES, HUMAN_TOOL_SCHEMAS } from "./human/index.js";
export type { HumanAdapter, HumanCallerContext, QuestionDetails, QuestionRecord } from "./human/index.js";

/** The config slice the tool builder reads. */
export type ToolBuildConfig = Pick<TrentConfig, "toolsets" | "disabled_toolsets"> & {
  readonly mcp_servers?: TrentConfig["mcp_servers"];
  readonly policy?: TrentConfig["policy"];
  readonly terminal?: { readonly backend?: TrentConfig["terminal"]["backend"]; readonly docker?: { readonly image?: string } };
  /** A2.2: the autonomy level, the user deny globs and the user hooks. Absent means the defaults. */
  readonly autonomy?: TrentConfig["autonomy"];
  readonly approvals?: TrentConfig["approvals"];
  readonly hooks?: TrentConfig["hooks"];
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
  /** The model gateway `vision` (and `browser_vision`) ask; without it `vision` is built `unavailable`. */
  readonly gateway?: VisionGateway;
  /** Screenshots land in `<profileDir>/browser/<runId>/`. */
  readonly runId?: string;
  /**
   * Durable idempotency for side-effecting calls (`governance/idempotent-dispatch.ts`). Defaults
   * to a manager persisted at `<profileDir>/idempotency.json`; tests pass an in-memory one.
   */
  readonly idempotency?: IdempotencyManager;
  /**
   * Trace-level policy rules (`governance/policy-dispatch.ts`), evaluated before idempotency.
   * Defaults to the shipped rules merged with `config.policy.rules`; tests pass their own.
   */
  readonly policy?: PolicyDispatcher;
  /**
   * Where `ask_human` reads the founder's answer on the replay of a parked call. Defaults to the
   * process-wide `sharedHumanAnswers` the orchestrator's `answer()` writes to; tests pass their own.
   */
  readonly humanAnswers?: HumanAnswers;
  /**
   * A2.2: the home directory the hardline rules resolve `~` and `$HOME` against. Defaults to
   * `os.homedir()`; tests pass a temporary one so a rule about `~/.ssh` can be proved without a
   * real one existing.
   */
  readonly home?: string;
  /** Named on every hook payload, so a hook can tell which seat asked. */
  readonly seat?: string;
  /** Overrides the hook runner built from `config.hooks`; tests pass their own. */
  readonly hookRunner?: ToolHookPort;
}

/** One toolset that was enabled in config but could not be built here, and why the seat cannot use it. */
export interface SkippedToolset {
  readonly toolset: string;
  readonly reason: string;
}

export interface TrentToolBuild {
  readonly adapters: TrentToolAdapter[];
  readonly skipped: SkippedToolset[];
  /**
   * A2.2: one line per hook that was configured but did not run (unconsented, or its spec
   * changed since consent). Read once by the surface that built the tools, so a silent hook is
   * visible without a line per tool call. Empty when every configured hook is consented.
   */
  readonly hookNotices: readonly string[];
}

/**
 * The toolsets this builder implements, keyed by the config's `ToolsetSchema` names (`code` is
 * Hermes's `code_execution`). This list is the single truth: `tools-index.test.ts` checks that
 * every `ToolsetSchema` value is either here or in `NOT_YET_IMPLEMENTED` with a reason, so a new
 * enum value can never be a silent no-op.
 */
export const IMPLEMENTED_TOOLSETS = ["file_ops", "terminal", "web", "code", "delegation", "cron", "skills", "plugins", "browser", "vision", "mcp", "human"] as const satisfies readonly Toolset[];

/** Enum values this builder does NOT produce, each with the reason a seat will see. */
export const NOT_YET_IMPLEMENTED: readonly { readonly toolset: Toolset; readonly reason: string }[] = [
  { toolset: "memory", reason: "registered by the fleet-memory hook (apps/cli/src/repl/fleet-memory.ts), not by this builder" },
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
  const caPem = deps.egress ? readCaPem(deps.egress.caCertPath) : undefined;
  const egressReason = !deps.egress
    ? "the egress proxy is not running; the toolset has no transport"
    : caPem === undefined
      ? `the egress CA certificate could not be read at ${deps.egress.caCertPath}`
      : undefined;
  const egress = deps.egress && caPem !== undefined ? { proxyUrl: deps.egressHostUrl ?? deps.egress.proxyUrl, token: deps.egress.token, caPem } : undefined;
  const pending = new Map(NOT_YET_IMPLEMENTED.map((entry) => [entry.toolset as string, entry.reason]));
  for (const toolset of enabledToolsets(config)) {
    if (toolset === "file_ops") adapters.push(createFileOpsAdapter(ctx));
    else if (toolset === "terminal") adapters.push(createTerminalAdapter(ctx));
    else if (toolset === "code") adapters.push(createCodeExecutionAdapter(ctx));
    else if (toolset === "delegation") adapters.push(createDelegateAdapter({ profileDir: deps.profileDir, ...(deps.delegate ? { port: deps.delegate } : {}) }));
    else if (toolset === "plugins") adapters.push(createPluginsAdapter(ctx, deps.pluginsDir ? { pluginsDir: deps.pluginsDir } : {}));
    else if (toolset === "skills") adapters.push(createSkillsAdapter({ profileDir: deps.profileDir, ...(deps.skillsDir ? { skillsDir: deps.skillsDir } : {}) }));
    else if (toolset === "cron") adapters.push(createCronAdapter({ profileDir: deps.profileDir }));
    else if (toolset === "mcp") adapters.push(createMcpAdapter(config, { profileDir: deps.profileDir, env: deps.env ?? process.env, ...(egress ? { egress } : {}) }));
    else if (toolset === "human") adapters.push(createHumanAdapter(deps.humanAnswers ? { answers: deps.humanAnswers } : {}));
    else if (toolset === "vision") {
      // Without a gateway the adapter is built `unavailable`: every call says not_available, never a stub.
      adapters.push(createVisionAdapter({ workspace: deps.workspace, profileDir: deps.profileDir, ...(deps.gateway ? { gateway: deps.gateway } : {}), ...(egress ? { egress } : {}) }));
    } else if (toolset === "web" || toolset === "browser") {
      // web and browser only ever go out through the egress proxy: no proxy, no network.
      if (!egress) {
        skipped.push({ toolset, reason: egressReason ?? "the egress proxy is not running; the toolset has no transport" });
        continue;
      }
      if (toolset === "web") {
        adapters.push(createWebToolsAdapter({ profileDir: deps.profileDir, env: deps.env ?? process.env, egress }));
      } else {
        const gateway = deps.gateway;
        adapters.push(
          createBrowserAdapter({
            profileDir: deps.profileDir,
            egress,
            env: deps.env ?? process.env,
            ...(deps.runId ? { runId: deps.runId } : {}),
            ...(gateway ? { vision: (input) => askVision(gateway, input) } : {}),
          }),
        );
      }
    } else {
      skipped.push({ toolset, reason: pending.get(toolset) ?? `"${toolset}" is not a toolset this builder knows` });
    }
  }
  const idempotency = deps.idempotency ?? new IdempotencyManager({ dir: deps.profileDir });
  const policy = deps.policy ?? new PolicyDispatcher(undefined, config.policy?.rules ?? []);
  // A2.2. The autonomy wrapper goes OUTSIDE the policy and idempotency wrappers, so a hardline
  // refusal, a deny-glob refusal or a blocking pre-tool hook never enters the policy history ring
  // and never reaches the idempotency store. Anything it lets through is then classified by the
  // policy rules and keyed by idempotency exactly as before.
  const hooks =
    deps.hookRunner ??
    (config.hooks === undefined
      ? undefined
      : createToolHookRunner({ profileDir: deps.profileDir, hooks: config.hooks, ...(deps.seat === undefined ? {} : { seat: deps.seat }) }));
  const guarded = autonomyAdapters(policy.wrap(idempotentAdapters(adapters, idempotency)), {
    level: config.autonomy ?? DEFAULT_AUTONOMY,
    deny: config.approvals?.deny ?? [],
    hardline: { home: deps.home ?? os.homedir(), profileDir: deps.profileDir },
    ...(hooks === undefined ? {} : { hooks }),
    ...(deps.seat === undefined ? {} : { seat: deps.seat }),
  });
  return {
    adapters: guarded,
    skipped,
    // A getter, not a snapshot: a hook is skipped when a CALL is made, which is always after the
    // build returned. Reading this field at the end of a run is what makes the notice reachable.
    get hookNotices(): readonly string[] {
      return hooks?.notices() ?? [];
    },
  };
}

/** `buildTrentTools(...).adapters`: the shape the orchestrator and the older callers take. */
export function buildTrentToolAdapters(config: ToolBuildConfig, deps: ToolBuildDeps): TrentToolAdapter[] {
  return buildTrentTools(config, deps).adapters;
}
