/**
 * Shapes shared by the social clients and the adapter. `SocialFetch` is the app adapter's own
 * `httpFetch` seam (`live-platform-adapter.ts` JsonFetch), so one injected function serves the
 * Meta, X, LinkedIn, TikTok, YouTube, Bluesky and Buffer requests alike; a real `Response`
 * satisfies it, and so does a test's host-rewriting wrapper.
 */
import type { ConnectProviderId } from "../../connect/providers.js";
import type { PlatformTokenResolver, ResolvedToken } from "../../connect/resolver.js";
import type { AppStoreState } from "../../fleet-memory/app-store.js";
import type { SocialToolPlatform } from "./schemas.js";

export type SocialFetch = (
  url: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string>; headers?: { get(name: string): string | null } }>;

/** The credentials and transport the routes run on; every member has a profile-backed default. */
export interface SocialPorts {
  readonly fetchImpl: SocialFetch;
  /** Which `trent connect` providers are connected right now. Synchronous: it reads names, never values. */
  readonly connected: () => ReadonlySet<ConnectProviderId>;
  /** The app adapter's resolver shape: a token for a live platform, or nothing. */
  readonly platformTokens: PlatformTokenResolver;
  /**
   * Whether the app's store may be used in this process (`fleet-memory/app-store.ts`). The app's
   * adapter imports that store, so the direct Meta and YouTube paths exist only when this says
   * `usable`; otherwise the adapter module is never imported and the routes are Buffer and Bluesky.
   */
  readonly appStore: () => AppStoreState;
  /** A Buffer access token or a Bluesky handle and app password; nothing when not connected. */
  readonly providerToken: (id: "buffer" | "bluesky") => Promise<ResolvedToken | undefined>;
  readonly endpoints: { readonly bluesky: string; readonly buffer: string };
  readonly pricing: { readonly buffer_cents_per_post: number };
  readonly now: () => Date;
}

export interface SocialPostRequest {
  readonly platform: SocialToolPlatform;
  readonly text: string;
  readonly mediaUrl?: string;
  readonly accountId?: string;
}

/** A refusal the tool can name: the code is stable, the message says what to do. */
export class SocialToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SocialToolError";
  }
}
