/**
 * [C16] The tools every harness gets, built once per bench run: `file_ops` over the world's workspace,
 * `business` against the fake Stripe, Calendar, Square and Twilio, and `social` against the fake Bluesky,
 * through `buildTrentTools`, so the whole gate chain (autonomy, floors, policy, idempotency, provenance) is
 * the shipped one, at the shipped default autonomy. The owner (`operator.ts`) sits on top.
 *
 * The approval rows and the idempotency keys are in memory: a bench never writes the profile's
 * `gateway.json`, and a task's attempt never inherits another's keys (every run id is new anyway).
 */
import type { ConnectProviderId } from "../connect/providers.js";
import type { ResolvedToken } from "../connect/resolver.js";
import { EXIT, TrentError } from "../errors/index.js";
import { MemoryGatewayStore } from "../gateway/store/GatewayStore.js";
import { DEFAULT_AUTONOMY } from "../governance/autonomy.js";
import { createBoundApprovalStore, type BoundApprovalStore } from "../governance/bound-approvals.js";
import { IdempotencyManager } from "../governance/IdempotencyManager.js";
import { buildTrentTools, type ToolBuildConfig, type ToolBuildDeps } from "../tools/index.js";
import type { TrentToolAdapter } from "../tools/types.js";
import { withOperator, type BenchOperator } from "./operator.js";
import type { BenchWorld } from "./world.js";

/** The toolsets both sides of the bench get, and nothing else. */
export const BENCH_TOOLSETS = ["file_ops", "business", "social"] as const;

/** The config slice the bench builds with: its toolsets, at the product's default autonomy. */
export const BENCH_TOOL_CONFIG: ToolBuildConfig = { toolsets: [...BENCH_TOOLSETS], disabled_toolsets: [], autonomy: DEFAULT_AUTONOMY };

/** Fake credentials for the fakes; none is a real secret and none can reach a real provider. */
function fakeToken(id: ConnectProviderId): ResolvedToken {
  if (id === "twilio") return { provider: id, kind: "basic", accessToken: "bench-twilio-token", username: "ACbench", scopes: [], refreshed: false };
  if (id === "stripe") return { provider: id, kind: "api_key", accessToken: "bench-stripe-key", scopes: [], refreshed: false };
  if (id === "bluesky") return { provider: id, kind: "basic", accessToken: "bench-app-password", username: "maplestreetspa.bsky.social", scopes: [], refreshed: false };
  if (id === "google" || id === "square") return { provider: id, kind: "oauth2", accessToken: `bench-${id}-token`, scopes: [], refreshed: false };
  throw new TrentError({ code: EXIT.AUTH, operation: `bench.${id}`, message: `${id} is not part of the bench's world`, target: id });
}

export interface BenchToolInput {
  readonly world: BenchWorld;
  readonly operator: BenchOperator;
  readonly profileDir: string;
  /** The home the hardline rules resolve `~` against; defaults to the workspace. */
  readonly home?: string;
  /** What the surface already set up (a runtime's `buildDeps`), kept where the bench does not override it. */
  readonly base?: Partial<ToolBuildDeps>;
}

export interface BenchTools {
  readonly adapters: TrentToolAdapter[];
  readonly bindings: BoundApprovalStore;
  readonly build: ReturnType<typeof buildTrentTools>;
}

export function benchToolDeps(input: BenchToolInput, bindings: BoundApprovalStore): ToolBuildDeps {
  const { world } = input;
  return {
    ...(input.base ?? {}),
    workspace: world.workspace,
    profileDir: input.profileDir,
    backend: "local",
    home: input.home ?? world.workspace,
    idempotency: new IdempotencyManager(),
    bindings,
    business: { fetchImpl: globalThis.fetch, endpoints: world.endpoints, tokens: async (id) => fakeToken(id) },
    social: {
      fetchImpl: world.socialFetch,
      connected: () => new Set<ConnectProviderId>(["bluesky"]),
      platformTokens: async () => undefined,
      providerToken: async (id) => (id === "bluesky" ? fakeToken(id) : undefined),
      endpoints: { bluesky: "https://bsky.social", buffer: "https://api.buffer.com" },
      env: {},
    },
  };
}

export function buildBenchTools(input: BenchToolInput): BenchTools {
  const bindings = createBoundApprovalStore({ store: new MemoryGatewayStore() });
  const build = buildTrentTools(BENCH_TOOL_CONFIG, benchToolDeps(input, bindings));
  const missing = BENCH_TOOLSETS.filter((toolset) => build.skipped.some((skip) => skip.toolset === toolset));
  if (missing.length > 0) {
    throw new TrentError({ code: EXIT.CONFIG, operation: "bench.tools", message: `the bench could not build ${missing.join(", ")}: ${JSON.stringify(build.skipped)}` });
  }
  const adapters = withOperator(build.adapters, input.operator);
  return { adapters, bindings, build: { ...build, adapters } };
}
