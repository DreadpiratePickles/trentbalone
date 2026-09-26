/**
 * [H2] The fetch an http MCP connection sends through: the credential reaches the MCP server's origin
 * and nothing else.
 *
 * `createEgressFetch` follows redirects itself and re-sends every header on every hop, so a server that
 * answered 307 to another host would hand that host its `Authorization` header. The base fetch here is
 * built with `maxRedirects: 0` (or asked for `redirect: "manual"`), and this wrapper follows a redirect
 * only to the same origin (or the same host upgraded to https), after the SSRF floor; any other target
 * is refused by name. That holds for a static bearer from the entry's headers as much as for OAuth.
 *
 * For an OAuth-managed server the wrapper sets `Authorization: Bearer <token>` on every request (the
 * specification requires it on every HTTP request, never in the query), takes a refreshed token when
 * the server answers 401 and retries that request once, and otherwise fails with the login hint. A
 * server with no credential that answers 401 with a Bearer challenge gets the same hint.
 */
import { RedirectBlockedError, type FetchLike } from "../web/proxied-fetch.js";
import { checkUrlSafety, type LookupFn } from "../web/url-safety.js";
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

function allowedHop(from: URL, to: URL): boolean {
  if (to.origin === from.origin) return true;
  return from.protocol === "http:" && to.protocol === "https:" && to.hostname === from.hostname;
}

function redirectTarget(response: Response | undefined, error: unknown, current: URL): URL | undefined {
  if (error instanceof RedirectBlockedError) return new URL(error.location, current);
  if (response !== undefined && response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location !== null) return new URL(location, current);
  }
  return undefined;
}

export function createPinnedFetch(options: PinnedFetchOptions): FetchLike {
  const pinned = new URL(options.serverUrl);

  async function send(url: URL, init: RequestInit | undefined, headers: Headers): Promise<Response> {
    let current = url;
    for (let hop = 0; ; hop += 1) {
      let response: Response | undefined;
      let failure: unknown;
      try {
        response = await options.base(current.toString(), { ...init, headers, redirect: "manual" });
      } catch (error) {
        failure = error;
      }
      const next = redirectTarget(response, failure, current);
      if (next === undefined) {
        if (response === undefined) throw failure instanceof Error ? failure : new Error(String(failure));
        return response;
      }
      await response?.body?.cancel().catch(() => undefined);
      if (!allowedHop(pinned, next)) {
        throw new Error(`${options.server} answered a redirect to ${next.host}; its credential is only ever sent to ${pinned.host}, so the redirect was refused`);
      }
      if (hop >= MCP_MAX_SAME_ORIGIN_REDIRECTS) throw new Error(`${options.server} redirected more than ${MCP_MAX_SAME_ORIGIN_REDIRECTS} times`);
      const verdict = await checkUrlSafety(next.toString(), { lookup: options.lookup });
      if (!verdict.ok) throw new Error(`${options.server} redirected to ${next.host}, refused by the SSRF floor: ${verdict.reason}`);
      current = next;
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
