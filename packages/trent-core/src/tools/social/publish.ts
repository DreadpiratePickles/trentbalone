/**
 * The routes. A post goes direct through the app's adapter (`apps/web/lib/social/live-platform-adapter.ts`,
 * with `platformTokenResolver` from `trent connect` in its `tokenResolver` seam) when the adapter
 * can post there, a connected provider holds the token and the app's store is usable; to Bluesky
 * through the AT Protocol client; and otherwise through Buffer when a Buffer token is connected.
 * Replies, the inbox and insights are direct only (Buffer's API has no reply, and its metrics
 * query was not confirmed). Nothing here checks an approval: `index.ts` does that inside `execute`
 * before calling in, and the queue handler does it before its tick-time call. Every failure is a
 * `SocialToolError` with a stable code, and no message carries a token: the adapter scrubs
 * provider bodies itself and the two clients scrub their own.
 *
 * The adapter is imported lazily, inside {@link liveAdapter}, and only after `appStoreUsable`
 * (`fleet-memory/app-store.ts`) says yes: the adapter module imports `@/lib/store`, whose
 * evaluation constructs the app's Prisma client, and this module is in the static graph of every
 * CLI command (`static-graph.test.ts`). The type-only imports below are erased and load nothing.
 */
import type { SocialInboxMessage, SocialPlatformAdapter } from "@/lib/social/platform-adapter";
import { ConfigManager } from "../../config/ConfigManager.js";
import { ConnectStore } from "../../connect/store.js";
import type { ConnectProviderId } from "../../connect/providers.js";
import { platformTokenResolver, tokenResolver, type ResolvedToken } from "../../connect/resolver.js";
import { describeAppStore, type AppStoreEnv } from "../../fleet-memory/app-store.js";
import { recordToolSpend } from "../../governance/spend-ledger.js";
import { currentToolCallContext } from "../../governance/tool-call-context.js";
import { BLUESKY_DEFAULT_SERVICE, BLUESKY_EMBED_IMAGES, BLUESKY_EMBED_VIDEO, BLUESKY_MAX_GRAPHEMES, BlueskyError, createBlueskyClient, graphemeCount, type BlueskyBlob, type BlueskyClient, type BlueskyEmbed } from "./bluesky.js";
import { BUFFER_ASSET_EXTENSIONS, BUFFER_DEFAULT_ENDPOINT, bufferAssetOf, createBufferClient } from "./buffer.js";
import { readMediaForSend, type SocialMediaFile } from "./media-files.js";
import { adapterBlockedReason, directRouteFor, noDirectReason, noRouteReason, postRouteFor, type SocialRoute } from "./matrix.js";
import type { SocialToolPlatform } from "./schemas.js";
import { SocialToolError, type SocialFetch, type SocialPorts, type SocialPostRequest } from "./types.js";

/** The seam `buildTrentTools` and the cron handler fill; every member defaults to the profile. */
export interface SocialAdapterOptions {
  readonly manager?: ConfigManager;
  readonly fetchImpl?: SocialFetch;
  readonly connected?: () => ReadonlySet<ConnectProviderId>;
  readonly platformTokens?: SocialPorts["platformTokens"];
  readonly providerToken?: SocialPorts["providerToken"];
  readonly endpoints?: { readonly bluesky?: string; readonly buffer?: string };
  /** Buffer bills per channel per month; set a per-post amortisation in integer cents to see it on the ledger. Default 0. */
  readonly pricing?: { readonly buffer_cents_per_post?: number };
  readonly now?: () => Date;
  /** The one variable the app-store decision is made from; defaults to `process.env`, read at each call. */
  readonly env?: AppStoreEnv;
}

/** The company id the app adapter is handed; its resolver here reads the profile, not a company row. */
const CLI_COMPANY = "trent-cli";
const ACCOUNT_REQUIRED: ReadonlySet<SocialToolPlatform> = new Set(["facebook", "instagram", "youtube"]);

export function createSocialPorts(profileDir: string, options: SocialAdapterOptions = {}): SocialPorts {
  const manager = options.manager ?? new ConfigManager({ baseDir: profileDir, profile: "default" });
  const pricing = options.pricing?.buffer_cents_per_post ?? 0;
  if (!Number.isInteger(pricing) || pricing < 0) throw new TypeError(`buffer_cents_per_post must be a non-negative integer of cents, received ${pricing}`);
  return {
    fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init)),
    connected: options.connected ?? (() => new Set(new ConnectStore(manager).list().filter((r) => r.connected).map((r) => r.provider))),
    platformTokens: options.platformTokens ?? platformTokenResolver({ manager }),
    providerToken:
      options.providerToken ??
      (async (id): Promise<ResolvedToken | undefined> => (new ConnectStore(manager).read(id).connected ? tokenResolver(id, { manager }) : undefined)),
    appStore: () => describeAppStore(options.env ?? process.env),
    endpoints: { bluesky: options.endpoints?.bluesky ?? BLUESKY_DEFAULT_SERVICE, buffer: options.endpoints?.buffer ?? BUFFER_DEFAULT_ENDPOINT },
    pricing: { buffer_cents_per_post: pricing },
    now: options.now ?? (() => new Date()),
  };
}

export interface PublishResult {
  readonly route: SocialRoute;
  readonly externalId: string;
  readonly note?: string;
}

/** The adapter's own error class, recognised by shape: importing it would load the adapter module for a check that needs no adapter. */
function isPlatformApiError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && error.name === "SocialPlatformApiError" && typeof (error as { code?: unknown }).code === "string";
}

function asToolError(platform: SocialToolPlatform, error: unknown): SocialToolError {
  if (error instanceof SocialToolError) return error;
  if (isPlatformApiError(error)) return new SocialToolError(`${platform}_${error.code}`, error.message);
  const message = error instanceof Error ? error.message : String(error);
  return new SocialToolError(`${platform}_provider_error`, message);
}

/**
 * The app's adapter for `platform`, imported here and nowhere else, and only when the app's store
 * is usable. The routes are decided on the same predicate before this is reached, so the refusal
 * below is the last line, not the first: it guarantees the import never happens without Postgres.
 */
async function liveAdapter(platform: SocialToolPlatform, ports: SocialPorts): Promise<SocialPlatformAdapter> {
  const blocked = adapterBlockedReason(ports.appStore());
  if (blocked !== undefined) throw new SocialToolError("social_direct_unavailable", blocked);
  const { createLiveSocialAdapter } = await import("@/lib/social/live-platform-adapter");
  return createLiveSocialAdapter(platform, { tokenResolver: ports.platformTokens, httpFetch: ports.fetchImpl, now: () => ports.now().toISOString() });
}

function requireAccount(platform: SocialToolPlatform, accountId: string | undefined): string {
  if (accountId !== undefined && accountId.trim() !== "") return accountId.trim();
  if (!ACCOUNT_REQUIRED.has(platform)) return "";
  throw new SocialToolError("social_account_id_required", `${platform} needs account_id (the Page id, Instagram business account id or YouTube channel id); social_platforms_list says where to find it`);
}

async function bluesky(ports: SocialPorts): Promise<BlueskyClient> {
  const token = await ports.providerToken("bluesky");
  if (token === undefined || token.username === undefined) throw new SocialToolError("bluesky_not_connected", "Bluesky is not connected; run trent connect bluesky");
  const client = createBlueskyClient({ fetchImpl: ports.fetchImpl, service: ports.endpoints.bluesky, now: ports.now });
  await client.login(token.username, token.accessToken);
  return client;
}

async function buffer(ports: SocialPorts) {
  const token = await ports.providerToken("buffer");
  if (token === undefined) throw new SocialToolError("buffer_not_connected", "Buffer is not connected; run trent connect buffer");
  return createBufferClient({ fetchImpl: ports.fetchImpl, accessToken: token.accessToken, endpoint: ports.endpoints.buffer });
}

export const BUFFER_HOSTING_MEDIA_DOCS = "https://developers.buffer.com/guides/hosting-media.md";

/**
 * Where media can go: files are uploaded on the Bluesky path only; a hosted URL goes to the direct
 * APIs (the app's adapter) and to Buffer as an asset, never to Bluesky, which takes no URL.
 */
function checkMediaRoute(route: SocialRoute, request: SocialPostRequest, files: number): void {
  if (files > 0 && request.mediaUrl !== undefined) throw new SocialToolError("social_media_conflict", "pass media (files under the workspace) or media_url (one hosted URL), not both");
  if (files > 0 && route === "buffer") {
    throw new SocialToolError(
      "buffer_media_needs_url",
      `${request.platform} goes through Buffer, whose API has no upload endpoint and fetches each asset from a public URL when the post goes out (${BUFFER_HOSTING_MEDIA_DOCS}). ` +
        "Trent runs on this machine and has no public URL to give it: host the file at a stable public https URL (Cloudinary, Cloudflare R2 or your own site) and pass it as media_url, or the owner attaches it inside Buffer",
    );
  }
  if (files > 0 && route === "direct") {
    throw new SocialToolError("social_media_file_unsupported", `the direct ${request.platform} path takes a publicly hosted media_url, not a local file: the platform fetches the URL itself`);
  }
  if (route === "bluesky" && request.mediaUrl !== undefined) {
    throw new SocialToolError("bluesky_media_url_unsupported", `Bluesky takes uploaded files, not a URL: pass media [{"path": "<file under the workspace>", "alt": "<alt text>"}] and each file is uploaded with the post`);
  }
  if (route === "buffer" && request.mediaUrl !== undefined && bufferAssetOf(request.mediaUrl) === undefined) {
    throw new SocialToolError("buffer_media_kind_unknown", `Buffer is told whether a URL is an image or a video, and ${request.mediaUrl} does not say: its path must end in ${BUFFER_ASSET_EXTENSIONS.join(", ")}`);
  }
}

/**
 * The typed refusals that need no network: named before any approval is asked, so a call that
 * cannot succeed never asks. `files` is how many local files the call attaches; it defaults to the
 * resolved ones, and the preview passes the count it is about to resolve so the route is refused
 * before any file is read.
 */
export function checkPostRequest(request: SocialPostRequest, ports: SocialPorts, files = request.media?.length ?? 0): SocialRoute {
  const appStore = ports.appStore();
  const route = postRouteFor(request.platform, ports.connected(), appStore);
  if (route === undefined) throw new SocialToolError("social_no_route", noRouteReason(request.platform, appStore));
  if (request.mediaUrl !== undefined && !/^https:\/\/\S+$/.test(request.mediaUrl)) throw new SocialToolError("social_media_url_invalid", "media_url must be a publicly hosted https URL");
  checkMediaRoute(route, request, files);
  if (route === "direct" && request.platform === "instagram" && request.mediaUrl === undefined) {
    throw new SocialToolError("instagram_media_url_required", "Instagram publishing requires a publicly hosted image or video URL in media_url; text alone cannot be published");
  }
  if (route === "direct") requireAccount(request.platform, request.accountId);
  return route;
}

/** Uploads each approved file's bytes, in order, and builds the post's embed from the blobs. */
async function blueskyEmbed(client: BlueskyClient, payloads: ReadonlyArray<{ file: SocialMediaFile; bytes: Buffer }>): Promise<BlueskyEmbed | undefined> {
  if (payloads.length === 0) return undefined;
  const blobs: BlueskyBlob[] = [];
  for (const { file, bytes } of payloads) blobs.push(await client.uploadBlob(bytes, file.mime));
  const aspect = (file: SocialMediaFile) => (file.aspectRatio === undefined ? {} : { aspectRatio: file.aspectRatio });
  const first = payloads[0]!.file;
  if (first.kind === "video") return { $type: BLUESKY_EMBED_VIDEO, video: blobs[0]!, alt: first.alt, ...aspect(first) };
  return { $type: BLUESKY_EMBED_IMAGES, images: payloads.map(({ file }, i) => ({ image: blobs[i]!, alt: file.alt, ...aspect(file) })) };
}

export async function publishSocialPost(request: SocialPostRequest, ports: SocialPorts, seat?: string): Promise<PublishResult> {
  const route = checkPostRequest(request, ports);
  try {
    if (route === "bluesky") {
      const files = request.media ?? [];
      // The text limit createRecord enforces, checked before a file is uploaded for a post that cannot be made.
      if (graphemeCount(request.text) > BLUESKY_MAX_GRAPHEMES) throw new BlueskyError("createRecord", 400, `a post is at most ${BLUESKY_MAX_GRAPHEMES} graphemes; this one is ${graphemeCount(request.text)}`);
      // Every file read and re-checked before the login: one gone or changed stops the post before anything leaves.
      const payloads = files.map((file) => ({ file, bytes: readMediaForSend(file) }));
      const client = await bluesky(ports);
      const embed = await blueskyEmbed(client, payloads);
      const ref = await client.createPost(request.text, embed === undefined ? {} : { embed });
      return { route, externalId: ref.uri, ...(files.length === 0 ? {} : { note: `attached ${files.map((f) => f.path).join(", ")}` }) };
    }
    if (route === "buffer") {
      const asset = request.mediaUrl === undefined ? undefined : bufferAssetOf(request.mediaUrl);
      const post = await (await buffer(ports)).createPost(request.platform, request.text, asset === undefined ? {} : { asset });
      const cents = ports.pricing.buffer_cents_per_post;
      const context = currentToolCallContext();
      const row = recordToolSpend({ run_id: context?.runId ?? "no-run", tool: "social_post", provider: "buffer", cents, units: 1, ...(seat === undefined ? {} : { seat }) });
      const ledgerNote = row === undefined ? "no spend ledger is open in this process, so the Buffer charge was not recorded" : `${cents} cents recorded on the ledger as buffer spend`;
      const media = asset === undefined ? "" : ` Buffer fetches the ${asset.kind} at ${asset.url} when the post goes out; keep it public until then.`;
      return { route, externalId: post.id, note: `queued in Buffer for channel ${post.channel.name} (${post.channel.service}); Buffer publishes at its next slot.${media} ${ledgerNote}` };
    }
    const account = requireAccount(request.platform, request.accountId);
    const published = await (await liveAdapter(request.platform, ports)).publishPost({
      companyId: CLI_COMPANY,
      socialAccountId: account,
      externalAccountId: account,
      content: request.text,
      ...(request.mediaUrl === undefined ? {} : { mediaUrls: [request.mediaUrl] }),
      postId: `cli_${ports.now().getTime()}`,
    });
    return { route, externalId: published.externalPostId };
  } catch (error) {
    throw asToolError(request.platform, error);
  }
}

export interface ReplyRequest {
  readonly platform: SocialToolPlatform;
  readonly threadId: string;
  readonly text: string;
  readonly accountId?: string;
}

export async function replySocial(request: ReplyRequest, ports: SocialPorts): Promise<PublishResult> {
  const appStore = ports.appStore();
  const route = directRouteFor(request.platform, "reply", ports.connected(), appStore);
  if (route === undefined) {
    throw new SocialToolError("social_reply_unsupported", `${noDirectReason(request.platform, "reply", appStore)}: replies are direct only (Facebook and Instagram comments, YouTube comments, Bluesky posts), and DMs are never sent`);
  }
  try {
    if (route === "bluesky") return { route, externalId: (await (await bluesky(ports)).reply(request.threadId, request.text)).uri };
    const account = requireAccount(request.platform, request.accountId);
    const sent = await (await liveAdapter(request.platform, ports)).reply({ companyId: CLI_COMPANY, socialAccountId: account, externalAccountId: account, externalThreadId: request.threadId, content: request.text });
    return { route, externalId: sent.externalReplyId };
  } catch (error) {
    throw asToolError(request.platform, error);
  }
}

export interface InboxItem {
  readonly id: string;
  readonly thread: string;
  readonly from: string;
  readonly kind: string;
  readonly text: string;
  readonly at: string;
}

function fromAdapter(message: SocialInboxMessage): InboxItem {
  return { id: message.externalMessageId, thread: message.externalThreadId, from: message.externalContactId, kind: message.kind, text: message.content, at: message.sentAt };
}

export async function readSocialInbox(platform: SocialToolPlatform, accountId: string | undefined, limit: number, ports: SocialPorts): Promise<InboxItem[]> {
  const appStore = ports.appStore();
  const route = directRouteFor(platform, "inbox", ports.connected(), appStore);
  if (route === undefined) throw new SocialToolError("social_inbox_unsupported", `${noDirectReason(platform, "inbox", appStore)}: the inbox is direct only (X mentions need an X token nothing here holds; TikTok has none; Buffer has none)`);
  try {
    if (route === "bluesky") return (await (await bluesky(ports)).notifications(limit)).map((n) => ({ id: n.uri, thread: n.uri, from: n.author, kind: n.reason, text: n.text, at: n.at }));
    const account = requireAccount(platform, accountId);
    const result = await (await liveAdapter(platform, ports)).fetchInbox({ companyId: CLI_COMPANY, socialAccountId: account, externalAccountId: account, limit });
    return result.messages.map(fromAdapter);
  } catch (error) {
    throw asToolError(platform, error);
  }
}

export interface Insights {
  readonly impressions: number;
  readonly engagements: number;
  readonly videoViews: number;
  readonly detail: string;
}

export async function readSocialInsights(platform: SocialToolPlatform, postId: string, accountId: string | undefined, ports: SocialPorts): Promise<Insights> {
  const appStore = ports.appStore();
  const route = directRouteFor(platform, "insights", ports.connected(), appStore);
  if (route === undefined) throw new SocialToolError("social_insights_unsupported", `${noDirectReason(platform, "insights", appStore)}: insights are direct only (Meta, YouTube, Bluesky); Buffer's metrics query is not wired`);
  try {
    if (route === "bluesky") {
      const c = await (await bluesky(ports)).counts(postId);
      return { impressions: 0, engagements: c.likes + c.reposts + c.replies + c.quotes, videoViews: 0, detail: `likes ${c.likes}, reposts ${c.reposts}, replies ${c.replies}, quotes ${c.quotes}; Bluesky reports no impressions` };
    }
    const account = requireAccount(platform, accountId);
    const a = await (await liveAdapter(platform, ports)).fetchAnalytics({ companyId: CLI_COMPANY, socialAccountId: account, externalAccountId: account, externalPostId: postId });
    return { impressions: a.impressions, engagements: a.engagements, videoViews: a.videoViews, detail: `impressions ${a.impressions}, engagements ${a.engagements}, video views ${a.videoViews}` };
  } catch (error) {
    throw asToolError(platform, error);
  }
}
