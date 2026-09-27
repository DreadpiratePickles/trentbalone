/**
 * [SEC-2 S2a-2] The one dial chokepoint.
 *
 * Every module that would otherwise fall back to the platform global `fetch` when no explicit
 * transport seam is injected routes that fallback through {@link trentFetch} instead. When offline
 * mode is on — `TRENT_OFFLINE`, read at CALL TIME through {@link isOffline}, never captured at import
 * — the destination must be loopback (or a host the operator configured as their local model);
 * otherwise the dial is refused with {@link EgressBlocked} before any socket is opened. When offline
 * is off this is a transparent pass-through to the platform `fetch`, byte-for-byte the old behaviour.
 *
 * Runtime-agnostic by construction: no `undici` / `setGlobalDispatcher`, no `node:net` connect hook.
 * The shipped artefact is a Bun-compiled binary whose native `fetch` a Node dispatcher would never
 * intercept (spec §"The crux"), so the guard is Trent's own code and is testable under Bun.
 *
 * Test seams are unchanged: a module given an explicit `fetchImpl`/transport uses it directly and
 * never reaches `trentFetch`, so the injected-fetch tests keep asserting exact request behaviour.
 *
 * [D3] Pinning. `assertLocalTarget` resolves the name once and returns the loopback address it
 * validated; the dial then connects to THAT literal, so the platform `fetch` has no name to resolve a
 * second time and a rebinding DNS answer never reaches the connect. The mechanism has to be
 * runtime-agnostic too (no undici dispatcher: Bun's native fetch ignores it, and undici is not a
 * dependency of this package), so the URL's host is rewritten to the pinned literal and the original
 * authority goes in the `Host` header:
 *   - Bun's fetch honours that `Host` header, so the server sees the name it was addressed by.
 *   - Node's fetch (undici) drops a caller-set `Host` as a forbidden header, so under Node the server
 *     sees the literal (`127.0.0.1:11434`). The connect is still pinned; only name-based virtual
 *     hosting on a loopback server is lost, which local model runtimes do not use.
 *   - https to a DNS name is REFUSED offline: rewriting it to a literal would break certificate and
 *     SNI checks, and fetch gives no portable way to pin the address while keeping the name for TLS.
 *     Use `http://127.0.0.1:…` or list the host in `allowedHosts`.
 * Not pinned (documented residuals): the name `localhost` (answered from the hosts file, not DNS), a
 * loopback literal (no DNS at all), and an `allowedHosts` entry, which the operator vouched for and
 * the platform fetch resolves as written. Redirects are followed by the platform fetch and are not
 * re-checked against the offline rule.
 */
import type { FetchLike } from "../tools/web/proxied-fetch.js";
import type { LookupFn } from "../tools/web/url-safety.js";
import { EgressBlocked, assertLocalTarget, isOffline } from "./offline.js";
import { urlHostOf, type PinnedTarget } from "./pinned-lookup.js";

export interface TrentFetchOptions {
  /**
   * Host or `host:port` strings the operator configured as their local model endpoint. The default
   * (none) is loopback-only, which is the correct offline posture. The config loader wave (S2a-3)
   * threads the configured local base URL through here; this wave keeps the loopback-only default.
   */
  readonly allowedHosts?: readonly string[];
  /** Injectable resolver for the offline guard's single resolution. Defaults to `dns.promises.lookup`. */
  readonly lookup?: LookupFn;
}

/** Resolve a `fetch` input (`string | URL | Request`) to the URL the offline guard should inspect. */
function targetOf(input: RequestInfo | URL): string | URL {
  if (typeof input === "string" || input instanceof URL) return input;
  return input.url;
}

/**
 * The same request, addressed to the pinned literal: the URL's host becomes `pin.address`, and the
 * original authority is carried in `Host`. The body is read once so a `Request` input re-issues cleanly.
 */
async function pinnedRequest(input: RequestInfo | URL, init: RequestInit | undefined, pin: PinnedTarget): Promise<[string, RequestInit]> {
  const original = new Request(input, init);
  const url = new URL(original.url);
  if (url.protocol !== "http:") {
    throw new EgressBlocked(pin.host, `${url.protocol}// to a DNS name cannot be pinned to its validated loopback address offline; dial http://${urlHostOf(pin.address)} or configure the host as a local endpoint`);
  }
  const authority = url.host;
  url.hostname = urlHostOf(pin.address);
  const headers = new Headers(original.headers);
  headers.set("host", authority);
  const body = original.body === null ? undefined : await original.arrayBuffer();
  return [
    url.toString(),
    {
      method: original.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: original.redirect,
      signal: original.signal,
      ...(init?.keepalive === undefined ? {} : { keepalive: init.keepalive }),
    },
  ];
}

/**
 * Build a `fetch`-shaped client that enforces offline mode at call time and then delegates to the
 * platform `fetch`. With no `allowedHosts` the only permitted destination while offline is loopback,
 * and a name is dialled at the one address the guard validated (see the module header).
 */
export function createTrentFetch(options: TrentFetchOptions = {}): FetchLike {
  const guard = {
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
    ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
  };
  return async (input, init) => {
    if (!isOffline()) return fetch(input, init);
    const pin = await assertLocalTarget(targetOf(input), guard);
    if (pin === undefined) return fetch(input, init);
    const [url, pinnedInit] = await pinnedRequest(input, init, pin);
    return fetch(url, pinnedInit);
  };
}

/**
 * The default dial every module's raw-`fetch` fallback uses: loopback-only while offline, transparent
 * otherwise. Consults `process.env.TRENT_OFFLINE` on every call.
 *
 * [D5] This is the single dial the offline proof exercises. The proof fires THIS object (not a
 * freshly-constructed always-on guard) so a refusal proves the actual wiring, not just that
 * `assertLocalTarget` refuses a public IP; `trent security --offline` sets `TRENT_OFFLINE` around the
 * canary so this real dial engages even on a process that was not launched offline.
 */
export const trentFetch: FetchLike = createTrentFetch();
