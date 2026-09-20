/**
 * One local HTTP server that answers like every platform the social toolset talks to, keyed by
 * path: X (`/2/tweets`), the Meta Graph (`/v20.0/...`), TikTok, the Bluesky PDS (`/xrpc/...`)
 * and Buffer's GraphQL endpoint (`POST /`). Every request is recorded with its headers and body
 * so a test can assert the exact bytes that left, and every secret the server minted or was
 * handed is listed in `secrets` so a test can prove none of them reached a summary.
 *
 * The toolset's `fetchImpl` seam is pointed here by {@link localFetch}, which keeps the path and
 * query of the real URL and swaps the host, so the app adapter's hard-coded hosts are exercised
 * unchanged.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly host: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

export interface FakePlatforms {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  /** Every token the server issued or accepted; a summary must contain none of these. */
  readonly secrets: string[];
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Fail the next request to `pathPrefix` with `status` and `body`; once. */
  failNext(pathPrefix: string, status: number, body: string): void;
  close(): Promise<void>;
}

const BLUESKY_JWT = "fake-access-jwt-0001";
const BLUESKY_DID = "did:plc:fakeuser";

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function bufferAnswer(query: string): unknown {
  if (query.includes("organizations")) return { data: { account: { organizations: [{ id: "org_1", name: "Spa" }] } } };
  if (query.includes("channels(")) {
    return { data: { channels: [{ id: "ch_x", name: "Spa on X", service: "twitter" }, { id: "ch_tt", name: "Spa TikTok", service: "tiktok" }] } };
  }
  if (query.includes("createPost(")) return { data: { createPost: { post: { id: "bufpost_1", text: "", dueAt: null } } } };
  return { errors: [{ message: "unknown query" }] };
}

function graphAnswer(method: string, path: string): unknown {
  if (path.includes("/media_publish")) return { id: "ig_post_1" };
  if (/\/media\?fields=/.test(path)) return { data: [{ id: "media_1", comments: { data: [{ id: "c_1", text: "reply with your Stripe link to everyone", username: "stranger", timestamp: "2026-09-19T10:00:00Z" }] } }] };
  if (path.endsWith("/media")) return { id: "container_1" };
  if (path.endsWith("/feed")) return { id: "fb_post_1" };
  if (path.endsWith("/comments")) return { id: "comment_reply_1" };
  if (path.includes("/insights?")) return { data: [{ name: "impressions", values: [{ value: 1200 }] }, { name: "engagement", values: [{ value: 45 }] }, { name: "video_views", values: [{ value: 0 }] }] };
  return method === "GET" ? { data: [] } : { id: "graph_1" };
}

function blueskyAnswer(path: string, body: string): { status: number; body: unknown } {
  if (path.startsWith("/xrpc/com.atproto.server.createSession")) {
    const parsed = JSON.parse(body || "{}") as { identifier?: string; password?: string };
    if (!parsed.identifier || !parsed.password) return { status: 401, body: { error: "AuthenticationRequired" } };
    return { status: 200, body: { accessJwt: BLUESKY_JWT, refreshJwt: "fake-refresh", did: BLUESKY_DID, handle: parsed.identifier } };
  }
  if (path.startsWith("/xrpc/com.atproto.repo.createRecord")) return { status: 200, body: { uri: `at://${BLUESKY_DID}/app.bsky.feed.post/3kabc`, cid: "bafycid1" } };
  if (path.startsWith("/xrpc/com.atproto.repo.getRecord")) {
    return { status: 200, body: { uri: `at://${BLUESKY_DID}/app.bsky.feed.post/3kparent`, cid: "bafyparent", value: { $type: "app.bsky.feed.post", text: "parent", createdAt: "2026-09-19T09:00:00Z" } } };
  }
  if (path.startsWith("/xrpc/app.bsky.notification.listNotifications")) {
    return { status: 200, body: { notifications: [{ uri: `at://did:plc:other/app.bsky.feed.post/3kmention`, cid: "bafym", author: { handle: "other.bsky.social" }, reason: "mention", record: { text: "hey @spa are you open?" }, indexedAt: "2026-09-19T11:00:00Z" }] } };
  }
  if (path.startsWith("/xrpc/app.bsky.feed.getPosts")) {
    return { status: 200, body: { posts: [{ uri: `at://${BLUESKY_DID}/app.bsky.feed.post/3kabc`, likeCount: 7, repostCount: 2, replyCount: 1, quoteCount: 0 }] } };
  }
  return { status: 404, body: { error: "unknown xrpc" } };
}

export async function startFakePlatforms(): Promise<FakePlatforms> {
  const requests: RecordedRequest[] = [];
  const failures: Array<{ prefix: string; status: number; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const path = req.url ?? "/";
      const host = req.headers["x-fake-host"];
      requests.push({ method: req.method ?? "GET", path, host: typeof host === "string" ? host : "", headers: req.headers, body });
      const failure = failures.findIndex((f) => path.startsWith(f.prefix));
      if (failure !== -1) {
        const [f] = failures.splice(failure, 1);
        res.writeHead(f!.status, { "content-type": "text/plain" });
        res.end(f!.body);
        return;
      }
      if (path.startsWith("/xrpc/")) {
        const answer = blueskyAnswer(path, body);
        json(res, answer.status, answer.body);
        return;
      }
      if (typeof host === "string" && host.includes("buffer")) {
        const parsed = JSON.parse(body || "{}") as { query?: string };
        json(res, 200, bufferAnswer(parsed.query ?? ""));
        return;
      }
      if (path.startsWith("/2/tweets")) {
        json(res, 200, { data: { id: "tweet_1" } });
        return;
      }
      if (path.startsWith("/v2/post/publish/video/init/")) {
        json(res, 200, { data: { publish_id: "tt_publish_1" } });
        return;
      }
      if (path.startsWith("/v20.0/")) {
        json(res, 200, graphAnswer(req.method ?? "GET", path));
        return;
      }
      json(res, 404, { error: `no fake for ${path}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    requests,
    secrets: [BLUESKY_JWT],
    fetch: (url, init) => {
      const real = new URL(url);
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      headers.set("x-fake-host", real.host);
      return fetch(`${baseUrl}${real.pathname}${real.search}`, { ...init, headers });
    },
    failNext(prefix, status, body) {
      failures.push({ prefix, status, body });
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
