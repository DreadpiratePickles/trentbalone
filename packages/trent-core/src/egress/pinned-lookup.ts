/**
 * [D3] Resolve once, validate, and pin: the answer to DNS rebinding and resolve-then-connect.
 *
 * An allow-check that resolves a name and a connect that resolves it AGAIN are two questions to a DNS
 * server the attacker may control: the first answer passes the check, the second (a private address,
 * 169.254.169.254, a public exfil host) is where the socket actually goes. The fix is to ask once.
 * {@link resolvePinned} performs the single resolution, validates EVERY address in that one answer
 * against a policy, and returns the address the caller must dial as a literal — so the connect needs
 * no DNS at all and there is no second question to rebind.
 *
 * Policies:
 *   - `public`   a DNS name the proxy allowlisted: every address must be routable public space.
 *                Private, loopback, link-local, CGNAT, multicast and cloud-metadata answers are refused.
 *   - `loopback` a `*.localhost` name dialled online: loopback only. (Offline nothing is resolved at
 *                all: {@link pinOfflineLocal} pins by definition and refuses every other name.)
 *   - `explicit` an IP literal someone wrote down (an allowlist entry, an override): no DNS happens,
 *                so there is nothing to rebind; only cloud-metadata and unspecified addresses are refused.
 *
 * Pure apart from the injected resolver: this module never opens a socket.
 */
import net from "node:net";
import { classifyAddress, defaultLookup, type LookupFn, type ResolvedAddress } from "../tools/web/url-safety.js";

export type AddressPolicy = "public" | "loopback" | "explicit";

/** The one resolution's verdict: the address to dial, and the full answer it was chosen from. */
export interface PinnedTarget {
  /** The hostname as asked (lower case, no brackets). */
  readonly host: string;
  /** The literal to connect to. Never a name. */
  readonly address: string;
  readonly family: 4 | 6;
  /** Every address the single answer held; each one passed the policy. */
  readonly addresses: readonly string[];
}

/** Refusal: the one answer held an address the policy does not permit, or there was no answer. */
export class PinRefused extends Error {
  constructor(
    readonly host: string,
    readonly address: string | null,
    readonly detail: string,
  ) {
    super(`egress: ${host} refused — ${detail}`);
    this.name = "PinRefused";
  }
}

/** Strip IPv6 brackets and lower-case, the form every comparison here uses. */
export function bareHost(host: string): string {
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

/** True when `host` is an IPv4 or IPv6 literal (brackets allowed): dialling it needs no DNS. */
export function isIpLiteral(host: string): boolean {
  return net.isIP(bareHost(host)) !== 0;
}

/** True for `localhost` and any `*.localhost` name (RFC 6761: always this machine). */
export function isLocalhostName(host: string): boolean {
  const h = bareHost(host).replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost");
}

/** The policy a destination host is held to when nobody said otherwise. */
export function policyFor(host: string): AddressPolicy {
  const h = bareHost(host);
  if (net.isIP(h) !== 0) return "explicit";
  return isLocalhostName(h) ? "loopback" : "public";
}

/** Why `address` is not permitted under `policy`, or null when it is. */
export function addressViolation(address: string, policy: AddressPolicy): string | null {
  const reason = classifyAddress(address);
  if (policy === "public") return reason;
  if (policy === "loopback") return reason !== null && reason.startsWith("loopback") ? null : `${reason ?? "public address"}, not loopback`;
  // explicit: a literal someone configured. Metadata and unspecified are never a real destination.
  if (reason !== null && (reason.startsWith("cloud metadata") || reason.startsWith("unspecified") || reason === "unparseable address")) return reason;
  return null;
}

/** Choose the literal to dial from a validated answer: IPv4 first (what local runtimes bind), else the first. */
function choose(addresses: readonly ResolvedAddress[]): ResolvedAddress {
  return addresses.find((a) => net.isIPv4(a.address)) ?? addresses[0]!;
}

export interface ResolvePinnedOptions {
  /** The rule every address in the answer must satisfy. Defaults to {@link policyFor}(host). */
  readonly policy?: AddressPolicy;
  /** Injectable resolver; defaults to `dns.promises.lookup(host, { all: true })`. Called at most once. */
  readonly lookup?: LookupFn;
}

/**
 * Resolve `host` exactly once and validate every address in that answer. Returns the literal to dial.
 * An IP literal is validated without any resolution. Throws {@link PinRefused} on an empty answer, a
 * resolver failure, or any address the policy refuses — a mixed answer cannot smuggle one bad address.
 */
export async function resolvePinned(host: string, options: ResolvePinnedOptions = {}): Promise<PinnedTarget> {
  const h = bareHost(host);
  const policy = options.policy ?? policyFor(h);
  const literal = net.isIP(h);
  let answer: ResolvedAddress[];
  if (literal !== 0) {
    answer = [{ address: h, family: literal }];
  } else {
    try {
      answer = await (options.lookup ?? defaultLookup)(h);
    } catch (err) {
      throw new PinRefused(h, null, `could not be resolved (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (answer.length === 0) throw new PinRefused(h, null, "resolved to no address");
  for (const { address } of answer) {
    const violation = addressViolation(address, policy);
    if (violation !== null) throw new PinRefused(h, address, `resolves to ${address}, which is ${violation}`);
  }
  const picked = choose(answer);
  return {
    host: h,
    address: bareHost(picked.address),
    family: net.isIPv6(bareHost(picked.address)) ? 6 : 4,
    addresses: answer.map((a) => bareHost(a.address)),
  };
}

/** The address a `localhost` / `*.localhost` name is pinned to offline: IPv4 loopback, what local runtimes bind. */
export const LOCALHOST_PIN = "127.0.0.1";

/**
 * [O-02/O-03] The offline pin, with NO resolver: a DNS query is itself egress, so offline no name is
 * ever sent to one. An IP literal is checked as written (loopback only). `localhost` and `*.localhost`
 * (RFC 6761: always this machine) are pinned to {@link LOCALHOST_PIN} by definition. Any other name is
 * refused ({@link PinRefused}, address null) without being resolved, so a secret encoded in the name
 * (`<secret>.attacker.tld`) never reaches a resolver. Operator-vouched hosts are the caller's business.
 */
export function pinOfflineLocal(host: string): PinnedTarget {
  const h = bareHost(host);
  const literal = net.isIP(h);
  if (literal !== 0) {
    const violation = addressViolation(h, "loopback");
    if (violation !== null) throw new PinRefused(h, h, `resolves to ${h}, which is ${violation}`);
    return { host: h, address: h, family: literal === 6 ? 6 : 4, addresses: [h] };
  }
  if (isLocalhostName(h)) return { host: h, address: LOCALHOST_PIN, family: 4, addresses: [LOCALHOST_PIN] };
  throw new PinRefused(h, null, "is a DNS name that is not loopback by definition; offline it is refused without a DNS query (use an IP literal, localhost, or a configured local host)");
}

/** `address` as it goes into a URL authority: IPv6 bracketed. */
export function urlHostOf(address: string): string {
  return net.isIPv6(address) ? `[${address}]` : address;
}
