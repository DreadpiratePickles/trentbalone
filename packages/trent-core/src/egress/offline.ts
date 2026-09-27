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
 *   2. Loopback-only. The only destination permitted is loopback (127.0.0.0/8, ::1) or `localhost`,
 *      plus any host:port the operator explicitly configured as their local model. A public or LAN
 *      address is refused even when it is reached through a local-looking name, because the rule
 *      resolves the host before deciding.
 *
 * [D3] Resolving before deciding is not enough on its own: if the dial then resolves the name AGAIN,
 * a rebinding DNS server answers loopback to the check and a public address to the connect. So
 * {@link assertLocalTarget} resolves exactly once (through `egress/pinned-lookup.ts`) and RETURNS the
 * address it validated; `egress/dial.ts` connects to that literal. It returns undefined only when the dial
 * needs no pin: a loopback literal (no DNS at all), the name `localhost` (answered from the hosts
 * file, not DNS), or a host the operator configured as their local endpoint (trusted as written).
 *
 * The address classifier is reused from `tools/web/url-safety.ts` (via `egress/pinned-lookup.ts`) — one definition of what loopback
 * is, shared with the SSRF floor, so the two can never drift.
 */
import type { LookupFn } from "../tools/web/url-safety.js";
import { PinRefused, isIpLiteral, resolvePinned, type PinnedTarget } from "./pinned-lookup.js";

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
  /** Injectable resolver; defaults to `dns.promises.lookup`. */
  readonly lookup?: LookupFn;
}

/**
 * Resolves `target` ONCE and throws {@link EgressBlocked} unless every address in that answer is
 * loopback, or the host (optionally with its port) is one the operator allow-listed as a local
 * endpoint. Returns the validated address the dial must connect to, or undefined when the dial needs no
 * pin (a loopback literal, `localhost`, an operator-configured host). It never opens a socket.
 */
export async function assertLocalTarget(target: string | URL, options: AssertLocalOptions = {}): Promise<PinnedTarget | undefined> {
  const url = target instanceof URL ? target : new URL(target);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()));
  const hostPort = url.port ? `${host}:${url.port}` : host;
  if (allowed.has(host) || allowed.has(hostPort)) return undefined;
  if (host === "localhost" || host === "localhost.") return undefined;

  try {
    // One resolution (none at all for a literal), every address loopback, the chosen one returned.
    const pinned = await resolvePinned(host, { policy: "loopback", ...(options.lookup ? { lookup: options.lookup } : {}) });
    return isIpLiteral(host) ? undefined : pinned;
  } catch (err) {
    if (!(err instanceof PinRefused)) throw err;
    const detail = err.address === null ? err.detail : `resolves to ${err.address}, which is not loopback`;
    throw new EgressBlocked(host, detail);
  }
}
