/**
 * The honest matrix: what each platform can do from THIS install, from the app adapter's own
 * capability table (`apps/web/lib/social/live-platform-adapter.ts` LIVE_CAPABILITIES, copied here
 * as data and checked against the adapter by `static-graph.test.ts`), from which `trent connect`
 * provider holds a token (`connect/resolver.ts` PLATFORM_PROVIDER), from whether the app's store
 * may be used at all (`fleet-memory/app-store.ts`: the adapter imports it, so without a postgres
 * `DATABASE_URL` the adapter is never imported and the direct paths are not routes), plus the
 * facts the adapter cannot change and the user must hear:
 *
 *   - TikTok: the adapter posts `privacy_level: SELF_ONLY`, and no `trent connect` provider holds
 *     a TikTok token, so from the CLI TikTok is Buffer or nothing (private-only until the audit).
 *   - YouTube: the adapter has reply, inbox and analytics, no publish; unaudited projects upload
 *     private-only anyway; YouTube requires an "altered or synthetic content" disclosure.
 *   - DMs: `sendDm` throws for every platform; Messenger bots must self-disclose. Excluded.
 *   - Instagram and TikTok need a hosted media URL; Instagram's AI-generated field is not set.
 *   - X and LinkedIn: the adapter supports them, no connect provider holds their token; Buffer.
 *   - Bluesky: AT Protocol directly, no review, no fee. Threads: Buffer only.
 *
 * This module imports nothing from `apps/web`: it is in the static graph of every CLI command
 * (`tools/index.ts`), and a top-level import of the adapter would evaluate the app's store, and
 * with it the Prisma client, at start-up (`doctor/app-store-isolation.test.ts`).
 *
 * Sources: `01_discovery/output/market-agents-research-2026-09-19.md` section 2.1 and the review
 * `02_plan/output/upgrade-round-review.md` section 6.8.
 */
import { PLATFORM_PROVIDER } from "../../connect/resolver.js";
import type { ConnectProviderId } from "../../connect/providers.js";
import { describeAppStore, type AppStoreState } from "../../fleet-memory/app-store.js";
import type { SocialToolPlatform } from "./schemas.js";

export type SocialRoute = "direct" | "bluesky" | "buffer";
export type SocialOperation = "post" | "reply" | "inbox" | "insights";
export type DirectOperations = Readonly<Record<SocialOperation, boolean>>;

export interface PlatformEntry {
  readonly platform: SocialToolPlatform;
  /** The connect provider that holds the direct token, when one exists at all. */
  readonly provider?: ConnectProviderId;
  readonly connected: boolean;
  readonly bufferConnected: boolean;
  /** What the direct path (the app adapter, or the AT Protocol client) can do; Buffer adds `post` only. */
  readonly direct: DirectOperations;
  /** Why the direct path cannot run here even though the adapter has it: the app's store is not usable. */
  readonly directBlocked?: string;
  /** The route `social_post` would take now, or nothing with the reason. */
  readonly postRoute?: SocialRoute;
  readonly review: string;
  readonly caveats: readonly string[];
}

const NONE: DirectOperations = { post: false, reply: false, inbox: false, insights: false };
const ALL: DirectOperations = { post: true, reply: true, inbox: true, insights: true };

/**
 * The app adapter's `LIVE_CAPABILITIES`, reduced to the four operations the tools expose
 * (`posts`, `replies`, `inbox`, `analytics`); a platform absent here is one `isLiveSocialPlatform`
 * refuses. Threads has no live adapter; Bluesky is the AT client, not the adapter.
 */
export const ADAPTER_OPERATIONS: Readonly<Partial<Record<SocialToolPlatform, DirectOperations>>> = {
  x: ALL,
  facebook: ALL,
  instagram: ALL,
  linkedin: ALL,
  tiktok: { post: true, reply: false, inbox: false, insights: true },
  youtube: { post: false, reply: true, inbox: true, insights: true },
};

export const CAVEATS: Readonly<Record<SocialToolPlatform, readonly string[]>> = {
  facebook: ["Messenger DMs are not supported (sendDm throws; a bot would have to self-disclose)", "accounts without a role on your Meta app need Meta App Review before publishing"],
  instagram: [
    "requires a publicly hosted image or video URL (media_url); text alone is refused",
    "Instagram's AI-generated content field is not set by the adapter: label AI-made media yourself",
    "DMs are not supported",
    "100 API-published posts per 24 hours per account",
  ],
  x: ["no trent connect provider holds an X token; X's API is pay-per-use or 200 dollars per month on Basic, so the route is Buffer", "DMs are not supported"],
  linkedin: ["no trent connect provider holds a LinkedIn token and Community Management API access needs LinkedIn's approval, so the route is Buffer"],
  tiktok: [
    "the direct adapter posts SELF_ONLY (private) until TikTok's audit, and no trent connect provider holds a TikTok token: the route is Buffer, whose channel privacy applies",
    "requires a publicly hosted video URL; no reply and no inbox in TikTok's Content Posting API",
  ],
  youtube: [
    "no publish path in the adapter: upload through YouTube Studio or Buffer; reply, inbox and insights are direct",
    "YouTube requires an altered or synthetic content (AI use) disclosure on upload, which nothing here sets",
    "unaudited projects upload private-only; audits have no SLA",
  ],
  threads: ["no direct path in the adapter; Buffer when a Threads channel is connected there"],
  bluesky: ["AT Protocol directly with an app password; no review, no fee; 300 graphemes per post; up to four images (2,000,000 bytes each) or one MP4 video (300,000,000 bytes) uploaded from files under the workspace, alt text required; no media URL"],
};

export const REVIEW: Readonly<Record<SocialToolPlatform, string>> = {
  facebook: "Meta App Review plus Business Verification for accounts outside your app",
  instagram: "Meta App Review plus Business Verification for accounts outside your app",
  x: "none for Buffer; X's own paid tier for the direct API",
  linkedin: "LinkedIn Community Management API product access for the direct API; none for Buffer",
  tiktok: "TikTok audit for public posts on the direct API; none for Buffer",
  youtube: "YouTube API audit for public uploads",
  threads: "Meta app for the direct API (not wired); none for Buffer",
  bluesky: "none",
};

/** Which connect provider holds each platform's direct token, with Bluesky added to the app's table. */
export function directProviderOf(platform: SocialToolPlatform): ConnectProviderId | undefined {
  if (platform === "bluesky") return "bluesky";
  return PLATFORM_PROVIDER[platform];
}

/** The app adapter's row for `platform`, or nothing for one it does not serve live. */
export function adapterOperations(platform: SocialToolPlatform): DirectOperations | undefined {
  return ADAPTER_OPERATIONS[platform];
}

/** What the direct path can do at all: the AT client for Bluesky, the app adapter's row otherwise. */
export function directOperations(platform: SocialToolPlatform): DirectOperations {
  if (platform === "bluesky") return ALL;
  return adapterOperations(platform) ?? NONE;
}

/** One line on why the app adapter cannot run here; nothing when the app's store is usable. */
export function adapterBlockedReason(appStore: AppStoreState): string | undefined {
  if (appStore.usable) return undefined;
  const cause =
    appStore.store === "memory" ? "DATABASE_URL is unset" : appStore.store === "sqlite" ? "DATABASE_URL names a SQLite file, the wrapper's own store" : "DATABASE_URL is not a postgres URL";
  return `the app's adapter loads the app's store and runs only with a postgres DATABASE_URL (${cause}); Buffer and Bluesky are the routes here`;
}

/** Whether the direct path for `platform` can run in this process: Bluesky always, the app adapter only on a usable app store. */
function directRunnable(platform: SocialToolPlatform, appStore: AppStoreState): boolean {
  return platform === "bluesky" || appStore.usable;
}

/** Where a post to `platform` goes now, given what is connected. Direct needs the capability, a token source and a runnable adapter. */
export function postRouteFor(platform: SocialToolPlatform, connected: ReadonlySet<ConnectProviderId>, appStore: AppStoreState = describeAppStore()): SocialRoute | undefined {
  const provider = directProviderOf(platform);
  const direct = directOperations(platform).post && directRunnable(platform, appStore);
  if (provider !== undefined && direct && connected.has(provider)) return platform === "bluesky" ? "bluesky" : "direct";
  if (connected.has("buffer")) return "buffer";
  return undefined;
}

/** The direct route for a non-post operation: the adapter (or the AT client) with a connected token, else nothing. */
export function directRouteFor(
  platform: SocialToolPlatform,
  operation: Exclude<SocialOperation, "post">,
  connected: ReadonlySet<ConnectProviderId>,
  appStore: AppStoreState = describeAppStore(),
): SocialRoute | undefined {
  const provider = directProviderOf(platform);
  if (provider === undefined || !directOperations(platform)[operation] || !connected.has(provider)) return undefined;
  if (!directRunnable(platform, appStore)) return undefined;
  return platform === "bluesky" ? "bluesky" : "direct";
}

export function platformEntry(platform: SocialToolPlatform, connected: ReadonlySet<ConnectProviderId>, appStore: AppStoreState = describeAppStore()): PlatformEntry {
  const provider = directProviderOf(platform);
  const route = postRouteFor(platform, connected, appStore);
  const direct = directOperations(platform);
  const blocked = direct === NONE || directRunnable(platform, appStore) ? undefined : adapterBlockedReason(appStore);
  return {
    platform,
    ...(provider === undefined ? {} : { provider }),
    connected: provider !== undefined && connected.has(provider),
    bufferConnected: connected.has("buffer"),
    direct,
    ...(blocked === undefined ? {} : { directBlocked: blocked }),
    ...(route === undefined ? {} : { postRoute: route }),
    review: REVIEW[platform],
    caveats: CAVEATS[platform],
  };
}

/** What `social_post` says when no route exists: the exact `trent connect` to run, and the app-store block when that is the cause. */
export function noRouteReason(platform: SocialToolPlatform, appStore: AppStoreState = describeAppStore()): string {
  const provider = directProviderOf(platform);
  const capable = directOperations(platform).post && provider !== undefined;
  const blocked = capable && !directRunnable(platform, appStore) ? adapterBlockedReason(appStore) : undefined;
  const direct = capable && blocked === undefined ? `trent connect ${provider} for the direct path, or ` : "";
  const facts = [...(blocked === undefined ? [] : [blocked]), ...CAVEATS[platform]].join("; ");
  return `no route to ${platform}: run ${direct}trent connect buffer with a ${platform} channel connected inside Buffer. ${facts}.`;
}

/** The refusal for a direct-only operation (reply, inbox, insights) with no direct route. */
export function noDirectReason(platform: SocialToolPlatform, what: string, appStore: AppStoreState = describeAppStore()): string {
  const blocked = directOperations(platform) !== NONE && !directRunnable(platform, appStore) ? adapterBlockedReason(appStore) : undefined;
  return `no ${what} path for ${platform}${blocked === undefined ? "" : `: ${blocked}`}`;
}

export function renderPlatformLine(entry: PlatformEntry): string {
  const ops = (["post", "reply", "inbox", "insights"] as const).filter((op) => entry.direct[op]);
  const state = entry.connected ? `connected via trent connect ${entry.provider}` : entry.provider === undefined ? "no direct token source" : `not connected (trent connect ${entry.provider})`;
  const route =
    entry.postRoute !== undefined
      ? `post: ${entry.postRoute}`
      : !entry.direct.post
        ? "post: no publish path from this install"
        : entry.directBlocked !== undefined
          ? "post: no route until Buffer is connected (the direct path is not runnable here)"
          : "post: no route until a provider is connected";
  const direct = ops.length === 0 ? "direct: nothing" : `direct: ${ops.join(", ")}${entry.directBlocked === undefined ? "" : " (not runnable here: " + entry.directBlocked + ")"}`;
  const buffer = entry.bufferConnected ? "Buffer connected" : "Buffer not connected";
  return `${entry.platform}: ${state}; ${route}; ${direct}; ${buffer}; review: ${entry.review}\n  ${entry.caveats.join("\n  ")}`;
}
