/**
 * Buffer as the publisher for every platform whose direct path is unreviewed or has no token
 * source here. Buffer's public API is GraphQL at `https://api.buffer.com` with
 * `Authorization: Bearer <access token>` (https://developers.buffer.com/guides/your-first-post):
 * `account { organizations { id name } }` names the organization, `channels(input: {
 * organizationId })` lists the channels with their `service`, and `createPost(input: { text,
 * channelId, schedulingType: automatic, mode: addToQueue | customScheduled, dueAt })` answers a
 * `PostActionSuccess { post { id text dueAt } }` or a `MutationError { message }`. The media
 * input of `createPost` is not on the documented guide pages (the reference page answered 404
 * on 2026-09-20), so this client sends text only and the toolset refuses a media URL on this
 * path with a typed error rather than dropping it. The founder connects each channel inside
 * Buffer first; the token reaches only channels Buffer already holds.
 */
import type { SocialToolPlatform } from "./schemas.js";
import type { SocialFetch } from "./types.js";

export const BUFFER_DEFAULT_ENDPOINT = "https://api.buffer.com";

/** Buffer's `service` names for each platform; X appears under its old name in Buffer. */
export const BUFFER_SERVICES: Readonly<Record<SocialToolPlatform, readonly string[]>> = {
  facebook: ["facebook"],
  instagram: ["instagram"],
  x: ["twitter", "x"],
  linkedin: ["linkedin"],
  tiktok: ["tiktok"],
  youtube: ["youtube"],
  threads: ["threads"],
  bluesky: ["bluesky"],
};

export interface BufferChannel {
  readonly id: string;
  readonly name: string;
  readonly service: string;
}

export interface BufferPost {
  readonly id: string;
  readonly dueAt: string | null;
  readonly channel: BufferChannel;
}

export class BufferError extends Error {
  constructor(
    readonly operation: string,
    message: string,
  ) {
    super(`buffer ${operation} failed: ${message}`);
    this.name = "BufferError";
  }
}

export interface BufferClientOptions {
  readonly fetchImpl: SocialFetch;
  readonly accessToken: string;
  readonly endpoint?: string;
}

/** A GraphQL string literal: JSON's escaping is a superset of what GraphQL needs for a double-quoted string. */
function literal(value: string): string {
  return JSON.stringify(value);
}

export function createBufferClient(options: BufferClientOptions) {
  const endpoint = (options.endpoint ?? BUFFER_DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const token = options.accessToken;

  async function graphql<T>(operation: string, query: string): Promise<T> {
    const res = await options.fetchImpl(endpoint === "" ? "/" : endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    const scrubbed = text.split(token).join("[token]");
    if (!res.ok) throw new BufferError(operation, `HTTP ${res.status}: ${scrubbed.slice(0, 300)}`);
    const parsed = JSON.parse(text) as { data?: T; errors?: Array<{ message?: string }> };
    if (parsed.errors?.length) throw new BufferError(operation, parsed.errors.map((e) => e.message ?? "error").join("; ").split(token).join("[token]"));
    if (parsed.data === undefined) throw new BufferError(operation, "the API answered without data");
    return parsed.data;
  }

  async function organizationId(): Promise<string> {
    const data = await graphql<{ account?: { organizations?: Array<{ id?: string }> } }>("organizations", "query GetOrganizations { account { organizations { id name } } }");
    const id = data.account?.organizations?.[0]?.id;
    if (!id) throw new BufferError("organizations", "the token belongs to no Buffer organization");
    return id;
  }

  async function channels(): Promise<BufferChannel[]> {
    const org = await organizationId();
    const data = await graphql<{ channels?: Array<{ id?: string; name?: string; service?: string }> }>(
      "channels",
      `query GetChannels { channels(input: { organizationId: ${literal(org)} }) { id name service } }`,
    );
    return (data.channels ?? []).filter((c): c is { id: string; name: string; service: string } => typeof c.id === "string" && typeof c.service === "string").map((c) => ({ id: c.id, name: c.name ?? c.id, service: c.service.toLowerCase() }));
  }

  async function channelFor(platform: SocialToolPlatform): Promise<BufferChannel> {
    const all = await channels();
    const wanted = BUFFER_SERVICES[platform];
    const found = all.find((c) => wanted.includes(c.service));
    if (found === undefined) {
      const have = all.map((c) => `${c.service} (${c.name})`).join(", ") || "none";
      throw new BufferError("channels", `Buffer holds no ${platform} channel for this token; connect one inside Buffer first. Channels: ${have}`);
    }
    return found;
  }

  /** Text only (see the module comment). `dueAt` schedules through Buffer; absent, the post joins the queue's next slot. */
  async function createPost(platform: SocialToolPlatform, text: string, dueAt?: string): Promise<BufferPost> {
    const channel = await channelFor(platform);
    const mode = dueAt === undefined ? "mode: addToQueue" : `mode: customScheduled, dueAt: ${literal(dueAt)}`;
    const query =
      `mutation CreatePost { createPost(input: { text: ${literal(text)}, channelId: ${literal(channel.id)}, schedulingType: automatic, ${mode} }) ` +
      "{ ... on PostActionSuccess { post { id text dueAt } } ... on MutationError { message } } }";
    const data = await graphql<{ createPost?: { post?: { id?: string; dueAt?: string | null }; message?: string } }>("createPost", query);
    const post = data.createPost?.post;
    if (!post?.id) throw new BufferError("createPost", data.createPost?.message ?? "the API answered without a post id");
    return { id: post.id, dueAt: post.dueAt ?? null, channel };
  }

  return { channels, channelFor, createPost };
}

export type BufferClient = ReturnType<typeof createBufferClient>;
