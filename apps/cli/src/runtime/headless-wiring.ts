/**
 * The config blocks `createHeadlessRuntime` reads, and the five small wirings it builds from them.
 *
 * Each one has the same shape: take one block of the loaded config, return the collaborator it
 * describes, and return nothing when the block is absent or turned off. They live beside the
 * runtime rather than inside it so `headless.ts` stays the object graph and nothing else; the
 * runtime re-exports them, so a caller still imports them from one place.
 */

import { randomBytes } from "node:crypto";
import { openCheckpointSession, type CheckpointSession } from "@trent/core/checkpoints/index.js";
import { currentSpendLedger, installSpendLedger, openSpendLedger, type SpendLedger } from "@trent/core/governance/index.js";
import type { OrcEvent } from "@trent/core/orchestrator/index.js";
import { recordRunSpend } from "@trent/core/orchestrator/run-hooks.js";
import type { MemoryBlock } from "@trent/core/fleet-memory/index.js";
import type { HooksConfig, SessionHookReport } from "@trent/core/hooks/index.js";
import { loadWorkspaceContext } from "@trent/core/workspace-context/index.js";
import { createAlertHook, type AlertBudgetPort, type AlertHook, type AlertHookDeps } from "@trent/core/gateway/index.js";
import { applyPrivacyEnv, createPromptRedactor, type PromptPrivacyConfig } from "@trent/core/model-gateway/index.js";
import { OTelExporter, createOTelBusHook, type OTelBusHook } from "@trent/core/traces/index.js";

export interface HeadlessAlertDeps {
  readonly manager: AlertHookDeps["manager"];
  readonly budget?: AlertBudgetPort;
  readonly log?: (line: string) => void;
}

/** The `telemetry` config block as the runtime reads it; `TrentConfig` satisfies it structurally. */
export interface TelemetrySlice {
  telemetry?: { otlp_endpoint?: string; service_name?: string };
}

/** The `gateway` config block as the alert hook reads it; `TrentConfig` satisfies it structurally. */
export interface GatewaySlice {
  gateway?: { owner?: { platform: string; channelId: string }; alerts?: { approval_wait_minutes?: number } };
}

/** The `privacy` config block as the model gateway reads it; `TrentConfig` satisfies it structurally. */
export interface PrivacySlice {
  privacy?: PromptPrivacyConfig;
}

/** The `memory` config block the fleet memory wiring reads; `TrentConfig` satisfies it structurally. */
export interface MemorySlice {
  memory?: { blocks?: MemoryBlock[] };
}

/**
 * The `model_overrides` block. It is not routing, so it does not belong in `provider`/`model`, but
 * it has to reach the model gateway — which the orchestrator builds with NO arguments. It therefore
 * travels with the model config and `applyModelEnv` writes the env bridge the gateway reads, the
 * same road the `privacy` block takes (docs/configuration.md, "Model pricing").
 */
export interface ModelOverridesSlice {
  model_overrides?: Readonly<
    Record<string, { context_window?: number; input_cents_per_million?: number; output_cents_per_million?: number }>
  >;
}

// [B2.1] model tiers
/**
 * The `models` tier block. It travels with the model config for the same reason `model_overrides`
 * does — the orchestrator builds its gateway with no arguments — and `applyModelEnv` maps it onto
 * the per-provider tier variables the app's resolver reads. Without this the tier mapping B2 added
 * reached `fleet show` and nothing else: a live run wrote one model into every tier variable and
 * every seat ran it, whatever its manifest tier said (docs/configuration.md, "Model tiers").
 */
export interface ModelTiersSlice {
  models?: { fast?: string; executor?: string; planner?: string; judge?: string };
}

/** The `runtime` config block the orchestrator's run cap comes from; `TrentConfig` satisfies it structurally. */
export interface RuntimeSlice {
  runtime?: { max_concurrent_runs?: number };
}

// [E1] checkpoints
/** The `checkpoints` block the ledger reads; `TrentConfig` satisfies it structurally. */
export interface CheckpointsSlice {
  checkpoints?: { enabled?: boolean; max_bytes_per_run?: number };
}

/** The `hooks` block the session hooks are read from; `TrentConfig` satisfies it structurally. */
export interface HooksSlice {
  hooks?: HooksConfig;
}

// [G3.1] the one daily spend ledger
/**
 * The day boundary the ledger's totals are read on. It is the heartbeat's timezone, because that
 * is the one `trent budget status` prints and the one the sweep's headroom already measures the
 * day with; two boundaries would mean two different "todays" against one `budget.daily_cap`.
 */
export interface SpendSlice {
  heartbeat?: { active_hours?: { tz?: string } };
}

/** The `workspace` caps the instruction-file loader reads; `TrentConfig` satisfies it structurally. */
export type WorkspaceSlice = Parameters<typeof loadWorkspaceContext>[0]["config"];

const DEFAULT_APPROVAL_WAIT_MINUTES = 30;

/**
 * A session hook that did not run, or ran and failed, as one line the user can act on. A skipped
 * hook names the command it would have run and the command that would allow it; a failed one
 * carries the tail of its own stderr, because a hook that fails silently is a hook nobody fixes.
 */
export function sessionHookNotices(report: SessionHookReport): string[] {
  return [
    ...report.skipped.map((line) => `The ${report.kind} hook ${line}. Run "trent hooks consent" to allow it.`),
    ...report.failures.map((line) => `The ${report.kind} hook failed: ${line}`),
  ];
}

/**
 * Prompt redaction (T3.2) for this config. The orchestrator builds the model gateway with no
 * arguments, so the block travels through the env the gateway reads, the way the model block does.
 * The redactor is compiled here first so a bad `privacy.patterns[]` entry fails at startup with
 * its index (exit code 3) rather than on the first prompt. Returns the env names written.
 */
export function wirePromptRedaction(config: PrivacySlice): string[] {
  if (config.privacy === undefined) return [];
  createPromptRedactor({ enabled: config.privacy.redact_prompts, patterns: config.privacy.patterns });
  return applyPrivacyEnv(config.privacy);
}

/**
 * The push-alert hook for this config and sender, or nothing when no sender was injected. The
 * owner and the wait are config; a missing owner leaves the hook inert, and it says so once.
 */
export function wireAlerts(config: GatewaySlice, deps: HeadlessAlertDeps | undefined): AlertHook | undefined {
  if (deps === undefined) return undefined;
  const minutes = config.gateway?.alerts?.approval_wait_minutes ?? DEFAULT_APPROVAL_WAIT_MINUTES;
  return createAlertHook({
    manager: deps.manager,
    owner: config.gateway?.owner,
    budget: deps.budget,
    approvalWaitMs: minutes * 60_000,
    log: deps.log,
  });
}

/**
 * The OTel bus hook for this config, or nothing when no endpoint is set. Tracing off means no
 * exporter is built at all, so an unconfigured session never buffers spans it cannot ship.
 */
export function wireTelemetry(config: TelemetrySlice, onError?: (message: string) => void): OTelBusHook | undefined {
  const endpoint = config.telemetry?.otlp_endpoint;
  if (!endpoint) return undefined;
  const exporter = new OTelExporter({ endpoint, serviceName: config.telemetry?.service_name ?? "trent" });
  return createOTelBusHook(exporter, onError === undefined ? {} : { onError });
}

// [E1] checkpoints
/**
 * Opens this session's agent-write ledger (docs/checkpoints.md), or nothing when the profile has
 * turned checkpoints off. It is opened HERE, in the graph every surface is built on, so `trent
 * run`, the gateway, cron and the heartbeat ledger their seats' writes without wiring of their
 * own: `file_ops` looks the session up on the process, not on a context it is handed.
 */
/** The installed ledger and the one call that gives it back. */
export interface SpendLedgerSession {
  readonly ledger: SpendLedger;
  /** Uninstalls it, unless something installed a newer one meanwhile. Idempotent. */
  close(): void;
}

// [G3.1] the one daily spend ledger
/**
 * Installs this profile's spend ledger for the life of the runtime.
 *
 * The ledger is deliberately NOT self-installing (`governance/spend-ledger.ts`): a library that
 * opened one implicitly would write the founder's real profile from every test process. The
 * profile directory is known here — in the graph the REPL, `trent run`, the gateway, cron, the
 * heartbeat and the protocol servers are all built on — so this is the single place that installs
 * it, and every one of those surfaces is on the same daily cap by being built at all.
 *
 * `close()` only uninstalls what it installed: two runtimes in one process (a test file, a REPL
 * that opens a second graph) must not leave the second one's runs writing nowhere.
 */
export function wireSpendLedger(config: SpendSlice, input: { profileDir: string }): SpendLedgerSession {
  const ledger = openSpendLedger({ profileDir: input.profileDir, tz: config.heartbeat?.active_hours?.tz ?? "UTC" });
  installSpendLedger(ledger);
  return {
    ledger,
    close: () => {
      if (currentSpendLedger() === ledger) installSpendLedger(undefined);
    },
  };
}

/** Written when a billed step reached the runtime without the model that was billed. */
const UNATTRIBUTED = "unattributed";

// [G3.1] the one daily spend ledger
/**
 * The observer that turns a run's billed steps into charges against the run's own meter
 * (`orchestrator/run-hooks.ts`), which writes them to the ledger, grouped, when the run ends.
 *
 * `step_end` and `consolidate_end` are the two frames that carry `costCents`, and they carry it as
 * integer cents already; the REPL's ticker and `trent run`'s reader read the same two. The step
 * snapshot names the seat and the model but not the provider, so the session's configured provider
 * is recorded — that is what billed it. A frame with no integer cost is not a charge and is left
 * alone rather than rounded, estimated or recorded as zero.
 */
export function wireRunSpend(provider: string): (event: OrcEvent) => void {
  return (event) => {
    if (event.kind !== "step_end" && event.kind !== "consolidate_end") return;
    const cents = event.step?.costCents;
    if (typeof cents !== "number" || !Number.isInteger(cents) || cents <= 0) return;
    const seat = event.step?.agentRole;
    recordRunSpend(event.runId, {
      model: event.step?.model ?? UNATTRIBUTED,
      provider,
      cents,
      tokens: Math.trunc(event.step?.tokens ?? 0),
      ...(seat === undefined ? {} : { seat }),
    });
  };
}

export function wireCheckpoints(config: CheckpointsSlice, input: { workspace: string; profileDir: string }): CheckpointSession | undefined {
  const block = config.checkpoints;
  if (block?.enabled === false) return undefined;
  return openCheckpointSession({
    runId: `ses_${randomBytes(8).toString("hex")}`,
    workspace: input.workspace,
    profileDir: input.profileDir,
    ...(block?.max_bytes_per_run === undefined ? {} : { maxBytesPerRun: block.max_bytes_per_run }),
  });
}

