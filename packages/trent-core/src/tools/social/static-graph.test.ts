/**
 * The social toolset never pulls the app's store into the CLI's static graph.
 *
 * `apps/web/lib/social/live-platform-adapter.ts` imports `@/lib/store` at the top level, and every
 * module that exports the app's store evaluates `apps/web/lib/db.ts:8`, `new PrismaClient()`, whose
 * engine load nothing awaits: on any machine but the one that built the binary it rejects unhandled
 * and Bun kills the command (`doctor/app-store-isolation.test.ts`, `runtime/headless.app-store.test.ts`).
 * `tools/index.ts` is in the static graph of every CLI command, so a top-level import of the adapter
 * anywhere under `tools/social/` re-opens that death for every command. The rule is the one
 * `orchestrator/libs.ts` and `fleet-memory/app-tiers.ts` follow: app imports are lazy, inside the
 * function that needs them, and only after `appStoreUsable` says the app's store may be used.
 *
 * Vitest's module registry is the observation point: a mocked specifier records every evaluation
 * of it, static or dynamic, from anywhere in the worker's graph. The mocks are registered per test
 * with `vi.doMock` after `resetModules`, so each test's import list starts empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConnectProviderId } from "../../connect/providers.js";
import type { ToolCallRecord, TrentToolAdapter } from "../types.js";
import type { SocialAdapterOptions } from "./index.js";

const ADAPTER = "@/lib/social/live-platform-adapter";
const GUARDED = [ADAPTER, "@/lib/store", "@/lib/db", "@prisma/client"] as const;

let loaded: string[] = [];
const fetchAnalytics = vi.fn(async (_input: unknown) => ({ impressions: 1200, engagements: 45, videoViews: 0 }));

const EXPORTS: Record<(typeof GUARDED)[number], () => Record<string, unknown>> = {
  [ADAPTER]: () => ({
    isLiveSocialPlatform: (p: string) => ["x", "facebook", "instagram", "linkedin", "tiktok", "youtube"].includes(p),
    createLiveSocialAdapter: () => ({ fetchAnalytics }),
    SocialPlatformApiError: class extends Error {},
  }),
  "@/lib/store": () => ({ store: {} }),
  "@/lib/db": () => ({ db: {} }),
  "@prisma/client": () => ({ PrismaClient: class {} }),
};

let home: string;
let profileDir: string;
let workspace: string;

beforeEach(() => {
  vi.resetModules();
  loaded = [];
  fetchAnalytics.mockClear();
  for (const specifier of GUARDED) {
    vi.doMock(specifier, () => {
      loaded.push(specifier);
      return EXPORTS[specifier]();
    });
  }
  vi.stubEnv("TRENT_QUEUE_FALLBACK", "disabled");
  vi.stubEnv("DATABASE_URL", undefined);
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-social-graph-home-"));
  profileDir = path.join(home, ".trent", "default");
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-social-graph-work-"));
  fs.mkdirSync(profileDir, { recursive: true });
});

afterEach(() => {
  for (const specifier of GUARDED) vi.doUnmock(specifier);
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

/** The social adapter through `buildTrentTools`, imported AFTER the mocks so the registry sees every load. */
async function buildSocial(connected: ConnectProviderId[], social: Partial<SocialAdapterOptions> = {}) {
  const { buildTrentTools, SOCIAL_ADAPTER_NAME } = await import("../index.js");
  const { IdempotencyManager } = await import("../../governance/IdempotencyManager.js");
  const { createBoundApprovalStore } = await import("../../governance/bound-approvals.js");
  const { MemoryGatewayStore } = await import("../../gateway/store/GatewayStore.js");
  const set = new Set<ConnectProviderId>(connected);
  const built = buildTrentTools(
    { toolsets: ["social"], disabled_toolsets: [], autonomy: "never" },
    {
      workspace,
      profileDir,
      backend: "local",
      home,
      idempotency: new IdempotencyManager(),
      bindings: createBoundApprovalStore({ store: new MemoryGatewayStore() }),
      runId: "run_1",
      social: {
        fetchImpl: async () => {
          throw new Error("no network in this test");
        },
        connected: () => set,
        platformTokens: async (input) => (set.has("meta") ? { accessToken: "fake-meta-token", externalAccountId: input.externalAccountId } : undefined),
        providerToken: async () => undefined,
        ...social,
      },
    },
  );
  const adapter = built.adapters.find((a) => a.name === SOCIAL_ADAPTER_NAME);
  if (!adapter) throw new Error("the social adapter was not built");
  return adapter;
}

/** A write as the wrapper chain sees it in a step: the preview first, then the call (`social.test.ts` does the same). */
async function writeInStep(social: TrentToolAdapter, action: string): Promise<ToolCallRecord> {
  const { runWithToolCallContext } = await import("../../governance/tool-call-context.js");
  return runWithToolCallContext({ runId: "run_1", stepId: "step_1" }, async () => {
    await social.dryRun!(action, {});
    return social.execute(action, {});
  });
}

describe("the static graph of buildTrentTools", () => {
  it("evaluates neither the app's social adapter nor its store nor @prisma/client", async () => {
    await import("../index.js");
    expect(
      loaded,
      "a module under tools/social imports an app module at the top level; make it a dynamic import() inside the function that needs it",
    ).toEqual([]);
  });
});

describe("without a usable app store (DATABASE_URL unset)", () => {
  it("social_platforms_list names Buffer and Bluesky as the routes, says why the app adapter is not one, and imports nothing", async () => {
    const social = await buildSocial(["meta", "bluesky", "buffer"]);
    const result = await social.execute("social_platforms_list {}", {});
    expect(result.status).toBe("completed");
    const line = (platform: string) => result.summary.split("\n").find((l) => l.startsWith(`${platform}:`)) ?? "";
    expect(line("facebook")).toContain("post: buffer");
    expect(line("instagram")).toContain("post: buffer");
    expect(line("bluesky")).toContain("post: bluesky");
    expect(line("x")).toContain("post: buffer");
    expect(result.summary).toMatch(/DATABASE_URL/);
    expect(loaded).toEqual([]);
  });

  it("a Facebook post with only Meta connected is refused with the reason and Buffer named, before any approval or import", async () => {
    const social = await buildSocial(["meta"]);
    const action = 'social_post {"platform":"facebook","text":"open late","account_id":"page_42"}';
    const result = await writeInStep(social, action);
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("social_no_route");
    expect(result.summary).toMatch(/DATABASE_URL/);
    expect(result.summary).toContain("trent connect buffer");
    expect(loaded).toEqual([]);
  });

  it("a Facebook insights read, direct only, is refused the same way and imports nothing", async () => {
    const social = await buildSocial(["meta"]);
    const result = await social.execute('social_insights_read {"platform":"facebook","post_id":"fb_1","account_id":"page_42"}', {});
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("social_insights_unsupported");
    expect(result.summary).toMatch(/DATABASE_URL/);
    expect(fetchAnalytics).not.toHaveBeenCalled();
    expect(loaded).toEqual([]);
  });

  it("a file: DATABASE_URL (the wrapper's own store) is not the app's either", async () => {
    vi.stubEnv("DATABASE_URL", "file:/tmp/some-profile/trent.db");
    const social = await buildSocial(["meta"]);
    const result = await writeInStep(social, 'social_post {"platform":"facebook","text":"open late","account_id":"page_42"}');
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("social_no_route");
    expect(result.summary).toMatch(/SQLite/);
    expect(loaded).toEqual([]);
  });
});

describe("with a postgres DATABASE_URL", () => {
  it("the direct path is a route again and the adapter is imported only when that call runs", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/trent");
    const social = await buildSocial(["meta"]);
    const list = await social.execute("social_platforms_list {}", {});
    expect(list.summary.split("\n").find((l) => l.startsWith("facebook:"))).toContain("post: direct");
    expect(loaded, "listing the matrix needs no adapter: the capability table is the toolset's own data").toEqual([]);
    const result = await social.execute('social_insights_read {"platform":"facebook","post_id":"fb_1","account_id":"page_42"}', {});
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("1200");
    expect(fetchAnalytics).toHaveBeenCalledTimes(1);
    expect(loaded).toEqual([ADAPTER]);
  });

  it("the seam decides too: an injected env with a postgres URL makes the direct path a route", async () => {
    const social = await buildSocial(["meta"], { env: { DATABASE_URL: "postgresql://db.internal/trent" } });
    const list = await social.execute("social_platforms_list {}", {});
    expect(list.summary.split("\n").find((l) => l.startsWith("facebook:"))).toContain("post: direct");
    expect(loaded).toEqual([]);
  });
});

describe("the matrix's capability table is the adapter's", () => {
  it("matches LIVE_CAPABILITIES and isLiveSocialPlatform for every platform the tools expose, read from the real adapter module", async () => {
    // The real adapter, with the store it imports mocked away: the table it exports is what is
    // compared, so the toolset's local copy cannot drift from the app without this test saying so.
    vi.doUnmock(ADAPTER);
    const adapter = (await import(ADAPTER)) as {
      isLiveSocialPlatform(platform: string): boolean;
      createLiveSocialAdapter(platform: string, deps: { tokenResolver: () => Promise<undefined> }): { capabilities: Record<string, boolean> };
    };
    const { ADAPTER_OPERATIONS, adapterOperations } = await import("./matrix.js");
    const { SOCIAL_TOOL_PLATFORMS } = await import("./schemas.js");
    for (const platform of SOCIAL_TOOL_PLATFORMS) {
      if (platform === "bluesky") continue; // the AT Protocol client, not the app's adapter
      expect(platform in ADAPTER_OPERATIONS, platform).toBe(adapter.isLiveSocialPlatform(platform));
      if (!adapter.isLiveSocialPlatform(platform)) continue;
      const caps = adapter.createLiveSocialAdapter(platform, { tokenResolver: async () => undefined }).capabilities;
      expect(adapterOperations(platform), platform).toEqual({ post: caps.posts, reply: caps.replies, inbox: caps.inbox, insights: caps.analytics });
    }
  });
});
