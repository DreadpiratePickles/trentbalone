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
 */
import type { FetchLike } from "../tools/web/proxied-fetch.js";
import { assertLocalTarget, isOffline } from "./offline.js";

export interface TrentFetchOptions {
  /**
   * Host or `host:port` strings the operator configured as their local model endpoint. The default
   * (none) is loopback-only, which is the correct offline posture. The config loader wave (S2a-3)
   * threads the configured local base URL through here; this wave keeps the loopback-only default.
   */
  readonly allowedHosts?: readonly string[];
}

/** Resolve a `fetch` input (`string | URL | Request`) to the URL the offline guard should inspect. */
function targetOf(input: RequestInfo | URL): string | URL {
  if (typeof input === "string" || input instanceof URL) return input;
  return input.url;
}

/**
 * Build a `fetch`-shaped client that enforces offline mode at call time and then delegates to the
 * platform `fetch`. With no `allowedHosts` the only permitted destination while offline is loopback.
 */
export function createTrentFetch(options: TrentFetchOptions = {}): FetchLike {
  const allow = options.allowedHosts;
  return async (input, init) => {
    if (isOffline()) {
      await assertLocalTarget(targetOf(input), allow === undefined ? {} : { allowedHosts: allow });
    }
    return fetch(input, init);
  };
}

/**
 * The default dial every module's raw-`fetch` fallback uses: loopback-only while offline, transparent
 * otherwise. Consults `process.env.TRENT_OFFLINE` on every call.
 */
export const trentFetch: FetchLike = createTrentFetch();

/**
 * A dial that ALWAYS enforces the loopback-only rule, regardless of `TRENT_OFFLINE`. Used by the
 * offline proof (`trent security --offline`, `doctor/checks/offline.ts`) so it can exercise the guard
 * on a process that is not itself offline — the canary to `192.0.2.1` must be refused whether or not
 * the operator launched this command with offline on.
 */
export function createForcedOfflineDial(options: TrentFetchOptions = {}): FetchLike {
  const allow = options.allowedHosts;
  return async (input, init) => {
    await assertLocalTarget(targetOf(input), allow === undefined ? {} : { allowedHosts: allow });
    return fetch(input, init);
  };
}
