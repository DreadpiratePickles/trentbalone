/**
 * Builds the a2a toolset THROUGH `buildTrentTools`, so every test runs the real wrapper chain
 * (class floor, bound approvals, idempotency, provenance) over a fake peer. The peer's token is
 * written into the scratch profile's own secrets file under the NAME the peer entry gives, which
 * is the only place the toolset reads it from; no real profile and no real peer is reachable.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryGatewayStore } from "../../../gateway/store/GatewayStore.js";
import { IdempotencyManager } from "../../../governance/IdempotencyManager.js";
import { createBoundApprovalStore, installBoundApprovals, type BoundApprovalStore } from "../../../governance/bound-approvals.js";
import { runWithToolCallContext } from "../../../governance/tool-call-context.js";
import { buildTrentTools, type ToolBuildDeps } from "../../index.js";
import type { TrentToolAdapter } from "../../types.js";

export interface HarnessPeer {
  readonly name: string;
  readonly url: string;
  readonly token_env?: string;
}

export interface A2aHarness {
  readonly adapter: TrentToolAdapter;
  readonly bindings: BoundApprovalStore;
  readonly profileDir: string;
  readonly cleanup: () => void;
}

export interface A2aHarnessOptions {
  readonly peers: readonly HarnessPeer[];
  /** Written to `<profile>/.env`, 0600, as `NAME=value` lines. */
  readonly secrets?: Readonly<Record<string, string>>;
  readonly autonomy?: "never" | "ask_always" | "ask_dangerous";
  /** Replaces the direct test transport, e.g. with the egress client. */
  readonly deps?: Partial<ToolBuildDeps>;
}

export function buildA2aHarness(options: A2aHarnessOptions): A2aHarness {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-a2a-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-a2a-work-"));
  const profileDir = path.join(home, ".trent", "default");
  fs.mkdirSync(profileDir, { recursive: true });
  const secrets = Object.entries(options.secrets ?? {});
  if (secrets.length > 0) fs.writeFileSync(path.join(profileDir, ".env"), `${secrets.map(([name, value]) => `${name}=${value}`).join("\n")}\n`, { mode: 0o600 });
  const bindings = createBoundApprovalStore({ store: new MemoryGatewayStore() });
  const built = buildTrentTools(
    { toolsets: ["a2a"], disabled_toolsets: [], autonomy: options.autonomy ?? "never", a2a: { peers: options.peers.map((peer) => ({ ...peer })) } },
    { workspace, profileDir, backend: "local", home, idempotency: new IdempotencyManager(), bindings, a2a: { fetchImpl: globalThis.fetch }, ...(options.deps ?? {}) },
  );
  const adapter = built.adapters.find((candidate) => candidate.name === "a2a");
  if (adapter === undefined) throw new Error(`the a2a adapter was not built: ${JSON.stringify(built.skipped)}`);
  return {
    adapter,
    bindings,
    profileDir,
    cleanup: () => {
      installBoundApprovals(undefined);
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}

/** Runs `fn` inside one seat turn, so the gate binds and the idempotency store keys the call. */
export function inStep<T>(runId: string, stepId: string, fn: () => Promise<T>): Promise<T> {
  return runWithToolCallContext({ runId, stepId }, fn);
}

/** The seat's action string for one tool. */
export function action(tool: string, args: Record<string, unknown>): string {
  return `${tool} ${JSON.stringify(args)}`;
}

/** Pause, show the human the preview, then run: the seat loop's path for a floored call the human approved. */
export async function approvedCall(adapter: TrentToolAdapter, runId: string, stepId: string, line: string) {
  const parked = await inStep(runId, stepId, () => adapter.execute(line, {}));
  const shown = await inStep(runId, stepId, () => adapter.dryRun!(line, {}));
  const done = await inStep(runId, stepId, () => adapter.execute(line, {}));
  return { parked, shown, done };
}
