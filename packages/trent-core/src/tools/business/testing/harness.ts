/**
 * Builds the business toolset THROUGH `buildTrentTools`, so every test runs the real wrapper
 * chain (class floor, bound approvals, idempotency, provenance) at `autonomy: never` — the level
 * that used to lift adapter approval — over a token stub and a fake server per provider. No
 * profile secrets are read and no real provider is reachable: the endpoints are the fakes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConnectProviderId } from "../../../connect/providers.js";
import type { ResolvedToken } from "../../../connect/resolver.js";
import { EXIT, TrentError } from "../../../errors/index.js";
import { MemoryGatewayStore } from "../../../gateway/store/GatewayStore.js";
import { IdempotencyManager } from "../../../governance/IdempotencyManager.js";
import { createBoundApprovalStore, installBoundApprovals, type BoundApprovalStore } from "../../../governance/bound-approvals.js";
import { installSpendLedger, openSpendLedger, type SpendLedger } from "../../../governance/spend-ledger.js";
import { runWithToolCallContext } from "../../../governance/tool-call-context.js";
import { buildTrentTools, type ToolBuildDeps } from "../../index.js";
import type { TrentToolAdapter } from "../../types.js";
import type { BusinessProviderId } from "../http.js";

export interface Harness {
  readonly adapter: TrentToolAdapter;
  readonly bindings: BoundApprovalStore;
  readonly ledger: SpendLedger;
  readonly profileDir: string;
  readonly cleanup: () => void;
}

export interface HarnessOptions {
  readonly endpoints: Partial<Record<BusinessProviderId, string>>;
  /** Providers the stub reports as connected, with the token it hands out. */
  readonly connected: Partial<Record<ConnectProviderId, { accessToken: string; username?: string }>>;
  readonly autonomy?: "never" | "ask_always";
  /** Through this egress proxy instead of the direct test transport (`egress.test.ts`). */
  readonly egress?: ToolBuildDeps["egress"];
}

/** The exact error `tokenResolver` throws for a provider nothing connected. */
export function notConnected(id: ConnectProviderId, name: string): TrentError {
  return new TrentError({ code: EXIT.AUTH, operation: `connect.${id}.resolve`, message: `${name} is not connected; run trent connect ${id}`, target: id });
}

const NAMES: Record<ConnectProviderId, string> = { stripe: "Stripe", google: "Google", square: "Square", twilio: "Twilio", buffer: "Buffer", meta: "Meta", bluesky: "Bluesky" };

export function stubTokens(connected: HarnessOptions["connected"]): (id: ConnectProviderId) => Promise<ResolvedToken> {
  return async (id) => {
    const entry = connected[id];
    if (entry === undefined) throw notConnected(id, NAMES[id]);
    return {
      provider: id,
      kind: id === "twilio" ? "basic" : id === "stripe" ? "api_key" : "oauth2",
      accessToken: entry.accessToken,
      ...(entry.username === undefined ? {} : { username: entry.username }),
      scopes: [],
      refreshed: false,
    };
  };
}

export function buildHarness(options: HarnessOptions): Harness {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-business-home-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-business-work-"));
  const profileDir = path.join(home, ".trent", "default");
  fs.mkdirSync(profileDir, { recursive: true });
  const bindings = createBoundApprovalStore({ store: new MemoryGatewayStore() });
  const ledger = openSpendLedger({ profileDir });
  installSpendLedger(ledger);
  const built = buildTrentTools(
    { toolsets: ["business"], disabled_toolsets: [], autonomy: options.autonomy ?? "never" },
    {
      workspace,
      profileDir,
      backend: "local",
      home,
      idempotency: new IdempotencyManager(),
      bindings,
      business: { ...(options.egress === undefined ? { fetchImpl: globalThis.fetch } : {}), endpoints: options.endpoints, tokens: stubTokens(options.connected) },
      ...(options.egress === undefined ? {} : { egress: options.egress }),
    },
  );
  const adapter = built.adapters.find((candidate) => candidate.name === "business");
  if (adapter === undefined) throw new Error(`the business adapter was not built: ${JSON.stringify(built.skipped)}`);
  return {
    adapter,
    bindings,
    ledger,
    profileDir,
    cleanup: () => {
      installBoundApprovals(undefined);
      installSpendLedger(undefined);
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
