/**
 * [SEC-2 S2a-1] Offline mode — the switch and the address rule.
 *
 * Trent can run "completely offline" on a local model. This module is the one place that decides
 * whether offline is on and whether a given destination is allowed while it is. The enforcement
 * chokepoint that consults it lives in `egress/dial.ts`; the config loader (S2a-3) turns the mode on
 * and rejects hosted configuration; the `doctor`/`trent security --offline` proof (S2b-2) exercises it.
 *
 * Two guarantees:
 *   1. One-way. Config may turn offline ON, never OFF. `resolveOfflineMode` treats a truthy
 *      `TRENT_OFFLINE` as a floor: a run started offline stays offline for its whole tree, because
 *      child runs (delegate, cron, gateway) inherit the environment variable.
 *   2. Loopback-only. The only destination permitted is loopback (127.0.0.0/8, ::1), `localhost` or
 *      a `*.localhost` name, plus any host:port the operator explicitly configured as their local
 *      model. A public or LAN address is refused.
 *   3. No DNS. A resolver query is itself egress (`<secret>.attacker.tld` leaks through the query name
 *      even when the connect is refused), so offline no name is ever resolved: an IP literal is
 *      checked as written, `*.localhost` is loopback by definition (RFC 6761), and every other name is
 *      refused before any lookup.
 *
 * [D3] The dial must connect to the address the check approved, never to a second answer for the
 * same name. {@link assertLocalTarget} therefore RETURNS the address it validated and
 * `egress/dial.ts` connects to that literal. Since the offline DNS-name fix no resolver is involved:
 * a `*.localhost` name is pinned to 127.0.0.1 (`pinOfflineLocal` in `egress/pinned-lookup.ts`). It
 * returns undefined when the dial needs no pin: a loopback literal (no DNS at all), the name
 * `localhost` (answered from the hosts file, not DNS), or a host the operator configured as their
 * local endpoint (trusted as written).
 *
 * The address classifier is reused from `tools/web/url-safety.ts` (via `egress/pinned-lookup.ts`) — one definition of what loopback
 * is, shared with the SSRF floor, so the two can never drift.
 */
import type { LookupFn } from "../tools/web/url-safety.js";
import { PinRefused, isIpLiteral, pinOfflineLocal, type PinnedTarget } from "./pinned-lookup.js";

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Refusal from the offline guard: the destination is not on this machine. */
export class EgressBlocked extends Error {
  constructor(
    readonly host: string,
    readonly detail: string,
  ) {
    super(`offline mode: ${host} is not reachable — ${detail}`);
    this.name = "EgressBlocked";
  }
}

/** Whether offline mode is on for this process, from a truthy `TRENT_OFFLINE`. */
export function isOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has((env.TRENT_OFFLINE ?? "").trim().toLowerCase());
}

/**
 * The effective mode, one-way: the environment is a floor config can raise but never lower. Used by
 * the config loader so `agent.offline: false` cannot re-open the network on a run launched with
 * `--offline` / `TRENT_OFFLINE=1`.
 */
export function resolveOfflineMode(input: { env?: NodeJS.ProcessEnv; config?: boolean }): boolean {
  return isOffline(input.env ?? {}) || input.config === true;
}

export interface AssertLocalOptions {
  /** Host or host:port strings the operator configured as their local model endpoint. */
  readonly allowedHosts?: readonly string[];
  /**
   * Accepted for callers that inject a resolver, and NEVER called: offline, no name is resolved (a
   * query is itself egress). Tests pass a counting resolver to prove it stays at zero calls.
   */
  readonly lookup?: LookupFn;
}

/**
 * Throws {@link EgressBlocked} unless `target` is a loopback literal, `localhost`, a `*.localhost` name,
 * or a host (optionally with its port) the operator allow-listed as a local endpoint. Any other name
 * is refused WITHOUT a resolver query. Returns the address the dial must connect to (127.0.0.1 for a
 * `*.localhost` name), or undefined when the dial needs no pin (a loopback literal, `localhost`, an
 * operator-configured host). It never resolves a name and never opens a socket.
 */
export async function assertLocalTarget(target: string | URL, options: AssertLocalOptions = {}): Promise<PinnedTarget | undefined> {
  const url = target instanceof URL ? target : new URL(target);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()));
  const hostPort = url.port ? `${host}:${url.port}` : host;
  if (allowed.has(host) || allowed.has(hostPort)) return undefined;
  if (host === "localhost" || host === "localhost.") return undefined;

  try {
    // No resolver, ever: a literal is checked as written, `*.localhost` is loopback by definition.
    const pinned = pinOfflineLocal(host);
    return isIpLiteral(host) ? undefined : pinned;
  } catch (err) {
    if (!(err instanceof PinRefused)) throw err;
    const detail = err.address === null ? err.detail : `resolves to ${err.address}, which is not loopback`;
    throw new EgressBlocked(host, detail);
  }
}
