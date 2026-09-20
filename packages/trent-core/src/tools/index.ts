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
// [U1] the class floor and the per-call approval binding every side-effecting executor sits behind.
import { createBoundApprovalStore, installBoundApprovals, type BoundApprovalStore } from "../governance/bound-approvals.js";
import { floorClasses } from "../governance/gate-config-schema.js";
import { createProvenanceLedger, provenanceAdapters, type ProvenanceLedger } from "../governance/provenance.js";
import { holdMemoryWrite } from "./memory/holds.js";
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
import { createClarifyAdapter } from "./clarify/index.js";
import { createSessionSearchAdapter } from "./session_search/index.js";
import { createTodoAdapter, type TodoAdapter } from "./todo/index.js";
import { discloseAdapters, DEFAULT_DISCLOSURE_THRESHOLD, isToolBridge } from "./tool_search/index.js";
import { createTerminalAdapter } from "./terminal/index.js";
import { createWebToolsAdapter } from "./web/index.js";
import { createBrowserAdapter } from "./browser/index.js";
import { askVision, createVisionAdapter, type VisionGateway } from "./vision/index.js";
import { createMediaAdapter } from "./media/index.js";
import { seatCapability } from "../fleet/seat-capabilities.js";
// [D5] tool descriptions: what a promoted improvement draft replaced, read at registration.
import { applyToolDescriptions, readToolOverrides, type AppliedToolOverride } from "../improve/tool-overrides.js";
import type { ToolContext, ToolDescriptionOverride, TrentToolAdapter } from "./types.js";

export type { Provenance, ToolAdapter, ToolCallRecord, ToolContext, ToolDescriptionOverride, TrentToolAdapter } from "./types.js";
// [C5] provenance: the tag, the per-step ledger and the hold path a held memory write waits on.
export {
  DEFAULT_PROVENANCE_POLICY, SHARED_WRITE_TOOLS, SKILL_WRITE_TOOLS, UNTRUSTED_ADAPTERS,
  adapterProvenance, createProvenanceLedger, isSharedWriteTool, isSkillWriteTool, provenanceAdapters, provenanceOf, worstProvenance,
} from "../governance/provenance.js";
export type { HeldWriteInput, ProvenanceLedger, ProvenancePolicy } from "../governance/provenance.js";
// [U1] the gate: what a new executor calls inside `execute`, and what a surface lists and decides.
export {
  BOUND_CALL_KIND, STEP_APPROVAL, boundCallKey, createBoundApprovalStore, currentBoundApprovals, installBoundApprovals, requireBoundApproval,
} from "../governance/bound-approvals.js";
export type { BoundApprovalDecision, BoundApprovalDetails, BoundApprovalRow, BoundApprovalStore, BoundCall } from "../governance/bound-approvals.js";
export { CLASS_FLOOR, GateConfigSchema, floorClasses } from "../governance/gate-config-schema.js";
export type { GateConfig } from "../governance/gate-config-schema.js";
export { INBOUND_SCOPE, isInboundCall } from "../governance/provenance.js";
export { recordToolSpend } from "../governance/spend-ledger.js";
export type { ToolSpendCharge } from "../governance/spend-ledger.js";
export {
  HELD_WRITE_ACTION, activeHeldWriteSession, approveHeldMemoryWrite, closeHeldWriteSession, denyHeldMemoryWrite, heldWriteAction,
  holdMemoryWrite, listHeldMemoryWrites, openHeldWriteSession, provenanceMarker, summariseHeldWrite,
} from "./memory/holds.js";
export type { ApproveHeldWriteResult, HeldWrite, HeldWriteDetails, HeldWriteRow, HeldWriteSession, HeldWriteSummary } from "./memory/holds.js";
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
// [B2] media: the local clip pipeline over allowlisted binaries (docs/media.md).
export { createMediaAdapter, MEDIA_ADAPTER_NAME, MEDIA_IMAGE, MEDIA_SCOPES, MEDIA_TOOL_SCHEMAS, mediaBackendPresent, reportMediaInstall, selectMediaBackend } from "./media/index.js";
export type { MediaBackend, MediaInstallReport } from "./media/index.js";
export { createHumanAdapter, questionFromEvent, renderQuestion, renderQuestions, HumanAnswers, sharedHumanAnswers, CARD_ADAPTER_NAMES, HUMAN_ADAPTER_NAME, HUMAN_SCOPES, HUMAN_TOOL_SCHEMAS } from "./human/index.js";
export type { HumanAdapter, HumanCallerContext, QuestionDetails, QuestionEntry, QuestionRecord, QuestionsDetails } from "./human/index.js";
// A3: progressive disclosure and the three tools the catalog was missing.
export {
  CORE_ADAPTERS, DEFAULT_DISCLOSURE_THRESHOLD, discloseAdapters, isToolBridge, parseToolBlocks, rankDocuments,
  TOOL_BRIDGE_ADAPTER_NAME, TOOL_BRIDGE_SCHEMAS, TOOL_BRIDGE_SCOPES, TOOL_CALL_TOOL, TOOL_DESCRIBE_TOOL, TOOL_SEARCH_TOOL,
} from "./tool_search/index.js";
export type { DeferredTool, ToolBridgeAdapter, UnknownToolRecord } from "./tool_search/index.js";
export { createTodoAdapter, TodoStore, TODO_ADAPTER_NAME, TODO_SCOPES, TODO_STATUSES, TODO_TOOL_SCHEMAS } from "./todo/index.js";
export type { TodoAdapter, TodoItem, TodoStatus } from "./todo/index.js";
export { createClarifyAdapter, splitAnswers, CLARIFY_ADAPTER_NAME, CLARIFY_MAX_QUESTIONS, CLARIFY_SCOPES, CLARIFY_TOOL_SCHEMAS } from "./clarify/index.js";
export type { ClarifyRecord } from "./clarify/index.js";
export { createSessionSearchAdapter, renderHits, SESSION_SEARCH_ADAPTER_NAME, SESSION_SEARCH_SCOPES, SESSION_SEARCH_TOOL_SCHEMAS } from "./session_search/index.js";

/** The config slice the tool builder reads. */
export type ToolBuildConfig = Pick<TrentConfig, "toolsets" | "disabled_toolsets"> & {
  readonly mcp_servers?: TrentConfig["mcp_servers"];
  readonly policy?: TrentConfig["policy"];
  readonly terminal?: { readonly backend?: TrentConfig["terminal"]["backend"]; readonly docker?: { readonly image?: string } };
  /** A2.2: the autonomy level, the user deny globs and the user hooks. Absent means the defaults. */
  readonly autonomy?: TrentConfig["autonomy"];
  readonly approvals?: TrentConfig["approvals"];
  readonly hooks?: TrentConfig["hooks"];
  /** A3: `tools.disclosure_threshold`. Absent means the shipped default. */
  readonly tools?: TrentConfig["tools"];
  /** [C5] `provenance`: what a memory or skill write made from untrusted context may do. */
  readonly provenance?: TrentConfig["provenance"];
  /** [U1] `gate.ask_classes`: classes added to the shipped class floor. Absent means the shipped floor alone. */
  readonly gate?: TrentConfig["gate"];
  /**
   * [D3] `curator.scan_agent_skills`: whether an agent-authored skill is scanned as a composed
   * bundle before it becomes active. D3 declared the key and nothing read it, so the gate was
   * always on; the builder feeds it to `createSkillsAdapter` here. Absent keeps the shipped
   * behaviour, which is the gate on. `TrentConfig` satisfies this structurally.
   */
  readonly curator?: { readonly scan_agent_skills?: boolean };
  /** [B2] `media`: the backend preference, the hosted-transcription opt-in and the whisper model path. */
  readonly media?: TrentConfig["media"];
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
  /**
   * A3: adapters a caller registers itself — the app's catalog adapters, a host integration, a
   * test's fixture. They are wrapped by the same gate chain as the built ones and their tools are
   * deferred behind the bridges whatever the catalog size, because their descriptions are written
   * outside this repository.
   */
  readonly extraAdapters?: readonly TrentToolAdapter[];
  /**
   * [C5] The per-step provenance ledger. Defaults to one per build, which is the right scope: a
   * build is one surface's tool set, and the tags are keyed by (run, step) inside it. Tests pass
   * their own to assert what a step accumulated.
   */
  readonly provenance?: ProvenanceLedger;
  /**
   * [D5] The tool descriptions a human promoted (`improve/tool-overrides.ts`). Defaults to what
   * `<profileDir>/tool-overrides.json` holds, which is nothing until a `tool` draft is promoted;
   * a caller passes its own to build without reading the profile.
   */
  readonly toolOverrides?: readonly ToolDescriptionOverride[];
  /**
   * [U1] Where an approval bound to one side-effecting call lives (`governance/bound-approvals.ts`).
   * Defaults to the rows in `<profileDir>/gateway.json`, which `trent approvals` lists and decides;
   * tests pass an in-memory one. Whatever is used is installed as the process's store, so an
   * adapter calling `requireBoundApproval` inside `execute` binds against the same rows.
   */
  readonly bindings?: BoundApprovalStore;
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
   * [C5] The ledger the provenance wrapper writes to; a surface reads it to explain a hold.
   * Optional because the legacy adapters-only seam (`buildAdapters`) builds a `TrentToolBuild`
   * by hand and never wraps anything, so it has no ledger to report.
   */
  readonly provenance?: ProvenanceLedger;
  /**
   * A2.2: one line per hook that was configured but did not run (unconsented, or its spec
   * changed since consent). Read once by the surface that built the tools, so a silent hook is
   * visible without a line per tool call. Empty when every configured hook is consented.
   */
  readonly hookNotices: readonly string[];
  /**
   * [D5] Which tool descriptions this build is serving from an improvement rather than from the
   * code, each with the draft id a surface names. Empty on every build with no promoted override,
   * and absent on the legacy adapters-only seam (`apps/cli/src/repl/tools.ts`), which registers a
   * hand-built list and reads no profile.
   */
  readonly descriptionOverrides?: readonly AppliedToolOverride[];
  /** [U1] The bound-approval rows this build's gate reads and writes; a surface lists them to explain a parked call. */
  readonly bindings?: BoundApprovalStore;
}

/**
 * The toolsets this builder implements, keyed by the config's `ToolsetSchema` names (`code` is
 * Hermes's `code_execution`). This list is the single truth: `tools-index.test.ts` checks that
 * every `ToolsetSchema` value is either here or in `NOT_YET_IMPLEMENTED` with a reason, so a new
 * enum value can never be a silent no-op.
 */
/**
 * A3. Registered on every build, whatever `config.toolsets` says, because they are the wrapper's
 * own mechanics rather than a capability a founder grants: the run's task list, the founder card,
 * and a read of this profile's own transcripts. They are not `Toolset` values for the same reason.
 */
export const ALWAYS_ON_ADAPTERS: readonly string[] = ["todo", "clarify", "session_search"];

export const IMPLEMENTED_TOOLSETS = ["file_ops", "terminal", "web", "code", "delegation", "cron", "skills", "plugins", "browser", "vision", "mcp", "human", "media"] as const satisfies readonly Toolset[];

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
    else if (toolset === "skills")
      adapters.push(
        createSkillsAdapter({
          profileDir: deps.profileDir,
          ...(deps.skillsDir ? { skillsDir: deps.skillsDir } : {}),
          // [D3] The gate the profile asked for. Absent leaves the adapter's own default, which is
          // the gate on, so a profile that never names the key keeps the shipped behaviour.
          ...(config.curator?.scan_agent_skills === undefined ? {} : { scanAgentSkills: config.curator.scan_agent_skills }),
        }),
      );
    else if (toolset === "cron") adapters.push(createCronAdapter({ profileDir: deps.profileDir }));
    else if (toolset === "mcp") adapters.push(createMcpAdapter(config, { profileDir: deps.profileDir, env: deps.env ?? process.env, ...(egress ? { egress } : {}) }));
    else if (toolset === "human") adapters.push(createHumanAdapter(deps.humanAnswers ? { answers: deps.humanAnswers } : {}));
    else if (toolset === "media") {
      // [B2] Docker when the media image exists, the host's own binaries otherwise; the hosted
      // transcription path exists only with a gateway AND `media.hosted_transcription`.
      adapters.push(createMediaAdapter(ctx, { env: deps.env ?? process.env, ...(config.media ? { media: config.media } : {}), ...(deps.gateway ? { gateway: deps.gateway } : {}) }));
    } else if (toolset === "vision") {
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
  // A3. Three tools that are not a toolset the founder enables or disables: a task list, the
  // founder card, and a read of this profile's own transcripts. They cost one schema each and a
  // seat without them re-plans from a transcript compaction is shortening.
  adapters.push(createTodoAdapter({ profileDir: deps.profileDir }));
  adapters.push(createClarifyAdapter(deps.humanAnswers ? { answers: deps.humanAnswers } : {}));
  adapters.push(createSessionSearchAdapter({ profileDir: deps.profileDir }));
  if (deps.extraAdapters?.length) adapters.push(...deps.extraAdapters);
  // [D5] Descriptions a human promoted, applied BEFORE the wrapper chain so every gate below sees
  // the same adapter list it always saw. Only the description line moves: the schema stays the
  // shipped one and `execute` is the shipped function, because an improvement may change what the
  // model is told a tool does and never what the tool does.
  const described = applyToolDescriptions(adapters, deps.toolOverrides ?? readToolOverrides(deps.profileDir));
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
  // [U1] The class floor and its binding live in the same wrapper: a post, a send, a booking, an
  // invoice or a charge asks at every level, and runs only against an approval bound to exactly
  // that call. The store is installed process-wide so an adapter's own `requireBoundApproval`
  // reads the rows this gate wrote.
  const bindings = deps.bindings ?? createBoundApprovalStore({ profileDir: deps.profileDir });
  installBoundApprovals(bindings);
  const guarded = autonomyAdapters(policy.wrap(idempotentAdapters(described.adapters, idempotency)), {
    level: config.autonomy ?? DEFAULT_AUTONOMY,
    deny: config.approvals?.deny ?? [],
    hardline: { home: deps.home ?? os.homedir(), profileDir: deps.profileDir },
    floor: floorClasses(config.gate),
    bindings,
    ...(hooks === undefined ? {} : { hooks }),
    ...(deps.seat === undefined ? {} : { seat: deps.seat }),
  });
  // [C5] Provenance sits OUTSIDE the autonomy, policy and idempotency wrappers and inside
  // disclosure. Outside, because the tag has to describe the record the seat actually receives —
  // including one a gate refused — and because a held write must be parked before any of those
  // wrappers spends an idempotency key on it. Inside disclosure, because a `tool_call` through
  // the bridge must be tagged and gated exactly as a direct call is.
  const ledger = deps.provenance ?? createProvenanceLedger();
  const tagged = provenanceAdapters(guarded, {
    ledger,
    ...(config.provenance === undefined ? {} : { policy: config.provenance }),
    hold: (input) =>
      holdMemoryWrite({
        profileDir: deps.profileDir,
        adapter: input.adapter,
        action: input.action,
        sources: input.sources,
        ...(deps.seat === undefined ? {} : { seat: deps.seat }),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
      }).line,
  });
  // A3. Disclosure runs LAST, on the wrapped list, so the bridges hold wrapped adapters: a
  // `tool_call` re-enters the same autonomy, policy, idempotency and hook chain a direct call
  // enters. Reversing the order would make the bridge a hole in every gate at once.
  const disclosed = discloseAdapters(tagged, TOOLSET_BY_ADAPTER, {
    threshold: config.tools?.disclosure_threshold ?? DEFAULT_DISCLOSURE_THRESHOLD,
    ...(config.mcp_servers === undefined ? {} : { mcpServers: config.mcp_servers }),
  });
  return {
    adapters: disclosed,
    skipped,
    provenance: ledger,
    descriptionOverrides: described.applied,
    bindings,
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

/**
 * B2, per-seat adapter selection. An adapter's name IS its toolset, with two spellings the config
 * enum does not share: `code_execution` is the `code` toolset, and the fleet-memory hook registers
 * `memory` and `fleet_search` for `memory`.
 */
export const TOOLSET_BY_ADAPTER: Readonly<Record<string, Toolset>> = {
  file_ops: "file_ops",
  terminal: "terminal",
  web: "web",
  browser: "browser",
  code_execution: "code",
  delegation: "delegation",
  cron: "cron",
  skills: "skills",
  plugins: "plugins",
  vision: "vision",
  mcp: "mcp",
  human: "human",
  media: "media",
  memory: "memory",
  fleet_search: "memory",
  // A3. `clarify` is the founder card, so it follows `human`; `session_search` reads this profile's
  // own transcripts, so it follows `memory`. Both are in `SHARED_SEAT_TOOLSETS`, so every seat keeps
  // them. `todo` and the `tools` bridge are deliberately absent: a task list and the way to reach a
  // deferred tool are not capabilities a manifest grants, and the bridge is narrowed per seat by
  // {@link adaptersForSeat} instead.
  clarify: "human",
  session_search: "memory",
};

/**
 * The subset of a built adapter list one seat may use: its manifest capabilities decide which
 * toolsets it gets (`fleet/seat-capabilities.ts`). Order is preserved. An adapter no toolset claims
 * was registered by a caller on purpose and is kept for every seat rather than silently dropped.
 */
export function adaptersForSeat(adapters: readonly TrentToolAdapter[], seat: string): TrentToolAdapter[] {
  const allowed = new Set<string>(seatCapability(seat).toolsets);
  const keep = (adapter: TrentToolAdapter): boolean => {
    const toolset = TOOLSET_BY_ADAPTER[adapter.name];
    return toolset === undefined || allowed.has(toolset);
  };
  // A3. The bridge is narrowed to the same subset, so `tool_call` cannot reach a toolset this
  // seat's manifest does not entitle it to. Without this the disclosure layer would be a way
  // around the per-seat gate rather than a way around the context cost.
  return adapters.filter(keep).map((adapter) => (isToolBridge(adapter) ? adapter.restrict(keep) : adapter));
}
