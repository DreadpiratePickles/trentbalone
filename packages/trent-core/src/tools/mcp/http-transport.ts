/**
 * [H2] The fetch an http MCP connection sends through: the credential reaches the MCP server's origin
 * and nothing else.
 *
 * [C4] The base fetch is asked for `redirect: "manual"` (which `createEgressFetch` honours), and this
 * wrapper decides each hop with the shared redirect rule (`../web/proxied-fetch.ts`): a hop that keeps
 * the credential there (the same origin, or the same host upgraded to https) is followed after the
 * SSRF floor; any other target is refused by name, where the egress fetch would strip and follow. That
 * holds for a static bearer from the entry's headers as much as for OAuth.
 *
 * For an OAuth-managed server the wrapper sets `Authorization: Bearer <token>` on every request (the
 * specification requires it on every HTTP request, never in the query), takes a refreshed token when
 * the server answers 401 and retries that request once, and otherwise fails with the login hint. A
 * server with no credential that answers 401 with a Bearer challenge gets the same hint.
 */
import { keepsCredentials, redirectRefusal, redirectTarget, type FetchLike } from "../web/proxied-fetch.js"; // [C4]
import type { LookupFn } from "../web/url-safety.js"; // [C4]
import { mcpLoginRequired, type McpBearerSource } from "./http-oauth.js";
import { parseBearerChallenge } from "./http-oauth-wire.js";

export const MCP_MAX_SAME_ORIGIN_REDIRECTS = 3;

export interface PinnedFetchOptions {
  readonly server: string;
  readonly serverUrl: string;
  /** The egress fetch with `maxRedirects: 0`, or a test fetch. */
  readonly base: FetchLike;
  /** Present for an OAuth-managed server. */
  readonly bearer?: McpBearerSource;
  /** The entry configures its own `Authorization` header (a static bearer). */
  readonly staticAuthorization: boolean;
  readonly lookup?: LookupFn;
}

// [C4] The private copy of the redirect rule (`allowedHop`, `redirectTarget`) that stood here is the
// shared one in `../web/proxied-fetch.ts` now.

export function createPinnedFetch(options: PinnedFetchOptions): FetchLike {
  const pinned = new URL(options.serverUrl);

  async function send(url: URL, init: RequestInit | undefined, headers: Headers): Promise<Response> {
    let current = url;
    for (let hop = 0; ; hop += 1) {
      // [C4] The shared rule: `redirect: "manual"` returns the 3xx, `redirectTarget` reads it,
      // `keepsCredentials` decides whether the credential may follow, `redirectRefusal` is the floor.
      const response = await options.base(current.toString(), { ...init, headers, redirect: "manual" });
      const next = redirectTarget(response.status, response.headers.get("location"), current);
      if (next === undefined) return response;
      await response.body?.cancel().catch(() => undefined);
      if (!keepsCredentials(pinned, next)) {
        throw new Error(`${options.server} answered a redirect to ${next.host}; its credential is only ever sent to ${pinned.host}, so the redirect was refused`);
      }
      if (hop >= MCP_MAX_SAME_ORIGIN_REDIRECTS) throw new Error(`${options.server} redirected more than ${MCP_MAX_SAME_ORIGIN_REDIRECTS} times`);
      const refusal = await redirectRefusal(next, options.lookup);
      if (refusal !== undefined) throw new Error(`${options.server} redirected to ${next.host}, refused by the SSRF floor: ${refusal}`);
      current = next;
      // [/C4]
    }
  }

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== pinned.origin) throw new Error(`${options.server}: a request to ${url.host} is not this server's (${pinned.host}); refused`);
    const headers = new Headers(init?.headers);
    let sent: string | undefined;
    if (options.bearer !== undefined) {
      sent = await options.bearer.current();
      headers.set("authorization", `Bearer ${sent}`);
    }
    const response = await send(url, init, headers);
    if (response.status !== 401) return response;

    if (options.bearer !== undefined && sent !== undefined) {
      await response.body?.cancel().catch(() => undefined);
      const renewed = await options.bearer.afterRejection(sent);
      if (renewed === undefined) throw mcpLoginRequired(options.server, "refused the stored OAuth token and there is no refresh token");
      headers.set("authorization", `Bearer ${renewed}`);
      const retried = await send(url, init, headers);
      if (retried.status !== 401) return retried;
      await retried.body?.cancel().catch(() => undefined);
      throw mcpLoginRequired(options.server, "refused a freshly renewed OAuth token");
    }
    const challenge = parseBearerChallenge(response.headers.get("www-authenticate"));
    if (!options.staticAuthorization && challenge !== undefined) {
      await response.body?.cancel().catch(() => undefined);
      throw mcpLoginRequired(options.server, "answered 401 with an OAuth challenge and no login is stored");
    }
    return response;
  };
  return impl as FetchLike;
}
