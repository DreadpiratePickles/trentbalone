/**
 * [O-03] The egress proxy's offline rule: loopback upstreams only, whatever the allowlist says.
 *
 * The host `EgressProxy` dials upstream over its own https/http requests, not through the offline
 * dial guard in `egress/dial.ts`, so that guard never sees its dials. A host-side tool whose request
 * reached the loopback listener therefore passed the guard's loopback rule and then left the machine
 * through the proxy. This module is the proxy's own copy of that rule, built on the same pieces: offline is
 * decided by {@link isOffline} (egress/offline.ts), and the upstream is resolved exactly once through
 * {@link resolvePinned} under the `loopback` policy, so every address in the one answer must be
 * loopback and the literal returned is the one the proxy dials (no second resolution to rebind).
 *
 * An `upstreamOverrides` entry (tests, staging) is held to the same rule: offline, an override that
 * points off the machine is refused like any other target. Every override the test suites use points
 * at 127.0.0.1, which passes.
 *
 * Pure apart from the injected resolver: this module never opens a socket.
 */
import type { LookupFn } from "../tools/web/url-safety.js";
import { isOffline } from "./offline.js";
import { PinRefused, resolvePinned } from "./pinned-lookup.js";

/** The refusal body a plain-HTTP or intercepted request gets offline; the CONNECT header carries `reason`. */
export const REFUSAL_OFFLINE = {
  error: "egress_refused",
  reason: "offline_non_loopback",
  message:
    "Trent egress proxy refused this request: offline mode is on and the upstream is not on this machine " +
    "(every resolved address must be loopback). The request was NOT forwarded.",
} as const;

export interface OfflineUpstream {
  readonly host: string;
  readonly port: number;
}

/** The proxy's offline switch: the injected value when one was given, else `TRENT_OFFLINE` now. */
export function proxyIsOffline(injected: boolean | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  return injected ?? isOffline(env);
}

/** What a refusal is logged with: the host asked for, and why. Never a header, token or secret. */
export type OfflineRefusal = {
  readonly host: string;
  readonly port: number;
  readonly address?: string;
  readonly detail: string;
};

/**
 * Resolve the upstream for `target` once under the loopback policy. Returns the literal address and
 * port to dial, or null after telling `onRefused` why it may not be dialled offline (an address off
 * the machine, or no answer at all). With an override, the override's address is what is checked.
 */
export async function pinOfflineUpstream(
  target: OfflineUpstream,
  override: OfflineUpstream | undefined,
  lookup: LookupFn | undefined,
  onRefused: (refusal: OfflineRefusal) => void = () => {},
): Promise<OfflineUpstream | null> {
  const dial = override ?? target;
  try {
    const pin = await resolvePinned(dial.host, { policy: "loopback", ...(lookup ? { lookup } : {}) });
    return { host: pin.address, port: dial.port };
  } catch (err) {
    if (!(err instanceof PinRefused)) throw err;
    onRefused({ host: target.host, port: target.port, ...(err.address === null ? {} : { address: err.address }), detail: err.detail });
    return null;
  }
}
