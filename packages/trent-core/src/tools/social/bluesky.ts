/**
 * Bluesky through the AT Protocol directly: no review, no fee, an app password from
 * `trent connect bluesky`. Four XRPC calls, each `/xrpc/<nsid>` on the PDS
 * (https://atproto.com/specs/xrpc): `com.atproto.server.createSession` (identifier, password
 * -> accessJwt, did), `com.atproto.repo.createRecord` (repo, collection, record -> uri, cid;
 * https://github.com/bluesky-social/atproto/blob/main/lexicons/com/atproto/repo/createRecord.json),
 * `com.atproto.repo.getRecord` for a reply's parent and root, `app.bsky.notification.listNotifications`
 * for mentions and replies, and `app.bsky.feed.getPosts` for the counts. The post record is
 * `app.bsky.feed.post` with `text` and `createdAt` required and `text` capped at 300 graphemes
 * (lexicons/app/bsky/feed/post.json). The session JWT lives in this closure and nowhere else.
 */
import type { SocialFetch } from "./types.js";

export const BLUESKY_DEFAULT_SERVICE = "https://bsky.social";
export const BLUESKY_POST_COLLECTION = "app.bsky.feed.post";
export const BLUESKY_MAX_GRAPHEMES = 300;

export interface BlueskyClientOptions {
  readonly fetchImpl: SocialFetch;
  readonly service?: string;
  readonly now?: () => Date;
}

export interface BlueskySession {
  readonly did: string;
  readonly handle: string;
}

export interface BlueskyRef {
  readonly uri: string;
  readonly cid: string;
}

export interface BlueskyNotification {
  readonly uri: string;
  readonly author: string;
  readonly reason: string;
  readonly text: string;
  readonly at: string;
}

export interface BlueskyCounts {
  readonly likes: number;
  readonly reposts: number;
  readonly replies: number;
  readonly quotes: number;
}

export class BlueskyError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    message: string,
  ) {
    super(`bluesky ${operation} failed: ${message}`);
    this.name = "BlueskyError";
  }
}

export function graphemeCount(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
}

/** `at://did/collection/rkey` -> its three parts, or nothing for anything else. */
export function parseAtUri(uri: string): { repo: string; collection: string; rkey: string } | undefined {
  const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri.trim());
  return match ? { repo: match[1]!, collection: match[2]!, rkey: match[3]! } : undefined;
}

export function createBlueskyClient(options: BlueskyClientOptions) {
  const service = (options.service ?? BLUESKY_DEFAULT_SERVICE).replace(/\/+$/, "");
  const now = options.now ?? (() => new Date());
  let session: (BlueskySession & { accessJwt: string }) | undefined;

  async function xrpc<T>(operation: string, nsid: string, init: { method: "GET" | "POST"; query?: Record<string, string>; body?: unknown; auth?: boolean }): Promise<T> {
    const query = init.query ? `?${new URLSearchParams(init.query).toString()}` : "";
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.auth !== false && session !== undefined) headers.authorization = `Bearer ${session.accessJwt}`;
    const res = await options.fetchImpl(`${service}/xrpc/${nsid}${query}`, { method: init.method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    const text = await res.text();
    if (!res.ok) {
      const scrubbed = session === undefined ? text : text.split(session.accessJwt).join("[token]");
      throw new BlueskyError(operation, res.status, `HTTP ${res.status}: ${scrubbed.slice(0, 300)}`);
    }
    return (text === "" ? {} : JSON.parse(text)) as T;
  }

  async function login(handle: string, appPassword: string): Promise<BlueskySession> {
    if (session !== undefined) return { did: session.did, handle: session.handle };
    const data = await xrpc<{ accessJwt?: string; did?: string; handle?: string }>("createSession", "com.atproto.server.createSession", {
      method: "POST",
      body: { identifier: handle, password: appPassword },
      auth: false,
    });
    if (!data.accessJwt || !data.did) throw new BlueskyError("createSession", 200, "the PDS answered without a session");
    session = { accessJwt: data.accessJwt, did: data.did, handle: data.handle ?? handle };
    return { did: session.did, handle: session.handle };
  }

  function requireSession(): BlueskySession & { accessJwt: string } {
    if (session === undefined) throw new BlueskyError("session", 401, "login first");
    return session;
  }

  async function createPost(text: string, reply?: { root: BlueskyRef; parent: BlueskyRef }): Promise<BlueskyRef> {
    const current = requireSession();
    if (graphemeCount(text) > BLUESKY_MAX_GRAPHEMES) throw new BlueskyError("createRecord", 400, `a post is at most ${BLUESKY_MAX_GRAPHEMES} graphemes; this one is ${graphemeCount(text)}`);
    const record = { $type: BLUESKY_POST_COLLECTION, text, createdAt: now().toISOString(), ...(reply === undefined ? {} : { reply }) };
    const data = await xrpc<{ uri?: string; cid?: string }>("createRecord", "com.atproto.repo.createRecord", {
      method: "POST",
      body: { repo: current.did, collection: BLUESKY_POST_COLLECTION, record },
    });
    if (!data.uri || !data.cid) throw new BlueskyError("createRecord", 200, "the PDS answered without a uri and cid");
    return { uri: data.uri, cid: data.cid };
  }

  async function getRecord(uri: string): Promise<{ ref: BlueskyRef; root: BlueskyRef }> {
    const parts = parseAtUri(uri);
    if (parts === undefined) throw new BlueskyError("getRecord", 400, `${uri} is not an at:// URI`);
    const data = await xrpc<{ uri?: string; cid?: string; value?: { reply?: { root?: BlueskyRef } } }>("getRecord", "com.atproto.repo.getRecord", {
      method: "GET",
      query: { repo: parts.repo, collection: parts.collection, rkey: parts.rkey },
    });
    if (!data.uri || !data.cid) throw new BlueskyError("getRecord", 200, "the PDS answered without a uri and cid");
    const ref = { uri: data.uri, cid: data.cid };
    return { ref, root: data.value?.reply?.root ?? ref };
  }

  async function reply(parentUri: string, text: string): Promise<BlueskyRef> {
    const parent = await getRecord(parentUri);
    return createPost(text, { root: parent.root, parent: parent.ref });
  }

  async function notifications(limit: number): Promise<BlueskyNotification[]> {
    requireSession();
    const data = await xrpc<{ notifications?: Array<{ uri?: string; author?: { handle?: string }; reason?: string; record?: { text?: string }; indexedAt?: string }> }>(
      "listNotifications",
      "app.bsky.notification.listNotifications",
      { method: "GET", query: { limit: String(limit) } },
    );
    return (data.notifications ?? [])
      .filter((n) => n.reason === "mention" || n.reason === "reply" || n.reason === "quote")
      .map((n) => ({ uri: n.uri ?? "", author: n.author?.handle ?? "unknown", reason: n.reason ?? "", text: n.record?.text ?? "", at: n.indexedAt ?? "" }));
  }

  async function counts(uri: string): Promise<BlueskyCounts> {
    requireSession();
    const data = await xrpc<{ posts?: Array<{ likeCount?: number; repostCount?: number; replyCount?: number; quoteCount?: number }> }>("getPosts", "app.bsky.feed.getPosts", {
      method: "GET",
      query: { uris: uri },
    });
    const post = data.posts?.[0];
    if (post === undefined) throw new BlueskyError("getPosts", 404, `no post at ${uri}`);
    return { likes: post.likeCount ?? 0, reposts: post.repostCount ?? 0, replies: post.replyCount ?? 0, quotes: post.quoteCount ?? 0 };
  }

  return { login, createPost, reply, notifications, counts };
}

export type BlueskyClient = ReturnType<typeof createBlueskyClient>;
