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
 *      address is refused even when it is reached through a local-looking name (DNS rebinding),
 *      because the rule resolves the host before deciding.
 *
 * The address classifier is reused from `tools/web/url-safety.ts` — one definition of what loopback
 * is, shared with the SSRF floor, so the two can never drift.
 */
import { classifyAddress, defaultLookup, type LookupFn } from "../tools/web/url-safety.js";

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

/** True when `host` (a bare hostname, no port) is one Trent always treats as this machine. */
function isLocalName(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost");
}

export interface AssertLocalOptions {
  /** Host or host:port strings the operator configured as their local model endpoint. */
  readonly allowedHosts?: readonly string[];
  /** Injectable resolver; defaults to `dns.promises.lookup`. */
  readonly lookup?: LookupFn;
}

/**
 * Resolves `target` and throws {@link EgressBlocked} unless every address it maps to is loopback, or
 * the host (optionally with its port) is one the operator allow-listed as a local endpoint. This is
 * the rule the dial chokepoint applies while offline; it never opens a socket itself.
 */
export async function assertLocalTarget(target: string | URL, options: AssertLocalOptions = {}): Promise<void> {
  const url = target instanceof URL ? target : new URL(target);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const allowed = new Set((options.allowedHosts ?? []).map((h) => h.toLowerCase()));
  const hostPort = url.port ? `${host.toLowerCase()}:${url.port}` : host.toLowerCase();
  if (allowed.has(host.toLowerCase()) || allowed.has(hostPort)) return;
  if (isLocalName(host)) return;

  const lookup = options.lookup ?? defaultLookup;
  let addresses: string[];
  try {
    addresses = (await lookup(host)).map((a) => a.address);
  } catch (err) {
    throw new EgressBlocked(host, `could not be resolved (${err instanceof Error ? err.message : String(err)})`);
  }
  if (addresses.length === 0) throw new EgressBlocked(host, "resolved to no address");
  for (const address of addresses) {
    const reason = classifyAddress(address);
    // `classifyAddress` returns a reason for every non-public address; only loopback is allowed here.
    if (reason === null || !reason.startsWith("loopback")) {
      throw new EgressBlocked(host, `resolves to ${address}, which is not loopback`);
    }
  }
}
