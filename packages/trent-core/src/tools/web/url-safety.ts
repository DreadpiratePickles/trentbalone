/**
 * SSRF floors for anything a seat asks the web toolset to fetch. A port of Hermes `url_safety.py`.
 *
 * Order of checks: scheme -> secret-shaped query -> hostname literal / suffix -> DNS resolution
 * of every address. Cloud metadata endpoints are refused unconditionally; there is no option to
 * allow them. The check runs BEFORE any socket is opened, and again on every redirect hop.
 */
import dns from "node:dns";
import net from "node:net";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type LookupFn = (hostname: string) => Promise<ResolvedAddress[]>;

export interface UrlSafetyOptions {
  /** Injectable resolver. Defaults to `dns.promises.lookup(host, { all: true })`. */
  lookup?: LookupFn;
}

export type UrlSafetyVerdict =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: string };

/** Literal addresses that are always refused, whatever the allowlist says. */
const METADATA_ADDRESSES = new Set([
  "169.254.169.254", // AWS, GCP, Azure, OpenStack IMDS
  "169.254.170.2", // AWS ECS task metadata
  "100.100.100.200", // Alibaba Cloud
  "fd00:ec2::254", // AWS IMDS over IPv6
]);

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "instance-data"]);

const SECRET_PARAM_NAMES =
  /^(api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|sig|signature|private[_-]?key|client[_-]?secret|refresh[_-]?token|id[_-]?token|session[_-]?id|x-amz-signature|x-goog-signature)$/i;

const SECRET_VALUE_SHAPES = [
  /^sk-[A-Za-z0-9_-]{16,}$/, // OpenAI / Anthropic style
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^gh[pousr]_[A-Za-z0-9]{30,}$/, // GitHub tokens
  /^xox[abp]-[A-Za-z0-9-]{20,}$/, // Slack
  /^eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/, // JWT
];

export const defaultLookup: LookupFn = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true })).map((r) => ({
    address: r.address,
    family: r.family,
  }));

function ipv4Octets(address: string): number[] | null {
  if (!net.isIPv4(address)) return null;
  return address.split(".").map(Number);
}

/** Expand `::ffff:a.b.c.d` (and the hex form) back to dotted IPv4, or return null. */
function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = Number.parseInt(hex[1]!, 16);
    const lo = Number.parseInt(hex[2]!, 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return null;
}

/** Why an address is refused, or null when it is routable public space. */
export function classifyAddress(raw: string): string | null {
  const address = raw.replace(/^\[|\]$/g, "").toLowerCase();
  if (METADATA_ADDRESSES.has(address)) return "cloud metadata endpoint (always blocked)";
  const mapped = mappedIpv4(address);
  if (mapped) return classifyAddress(mapped);

  const v4 = ipv4Octets(address);
  if (v4) {
    const [a, b] = v4 as [number, number, number, number];
    if (a === 0) return "unspecified address (0.0.0.0/8)";
    if (a === 10) return "private range (10.0.0.0/8)";
    if (a === 127) return "loopback (127.0.0.0/8)";
    if (a === 169 && b === 254) return "link-local (169.254.0.0/16)";
    if (a === 172 && b >= 16 && b <= 31) return "private range (172.16.0.0/12)";
    if (a === 192 && b === 168) return "private range (192.168.0.0/16)";
    if (a === 100 && b >= 64 && b <= 127) return "carrier-grade NAT (100.64.0.0/10)";
    if (a >= 224) return "multicast or reserved (224.0.0.0/3)";
    return null;
  }
  if (net.isIPv6(address)) {
    if (address === "::1") return "loopback (::1)";
    if (address === "::") return "unspecified address (::)";
    if (/^f[cd][0-9a-f]{2}:/.test(address)) return "unique local (fc00::/7)";
    if (/^fe[89ab][0-9a-f]:/.test(address)) return "link-local (fe80::/10)";
    if (/^ff[0-9a-f]{2}:/.test(address)) return "multicast (ff00::/8)";
    return null;
  }
  return "unparseable address";
}

/** Hostnames that never resolve to anything a seat should reach. */
function classifyHostname(hostname: string): string | null {
  const h = hostname.toLowerCase();
  if (METADATA_HOSTS.has(h)) return "cloud metadata hostname (always blocked)";
  if (h === "localhost" || h.endsWith(".localhost")) return "localhost";
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) {
    return "internal-only hostname suffix";
  }
  return null;
}

/** A URL whose query string looks like it carries a credential is refused outright. */
export function hasSecretShapedQuery(url: URL): string | null {
  for (const [name, value] of url.searchParams) {
    if (SECRET_PARAM_NAMES.test(name)) return `query parameter "${name}" looks like a secret`;
    if (SECRET_VALUE_SHAPES.some((re) => re.test(value))) {
      return `query parameter "${name}" carries a secret-shaped value`;
    }
  }
  if (url.username || url.password) return "URL embeds userinfo credentials";
  return null;
}

/** Full verdict for one URL, including DNS resolution of every address it maps to. */
export async function checkUrlSafety(
  raw: string,
  options: UrlSafetyOptions = {}
): Promise<UrlSafetyVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `scheme "${url.protocol}" is not http or https` };
  }
  const secret = hasSecretShapedQuery(url);
  if (secret) return { ok: false, reason: `refused: ${secret}` };

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const hostReason = classifyHostname(hostname);
  if (hostReason) return { ok: false, reason: `host "${hostname}" is ${hostReason}` };

  if (net.isIP(hostname)) {
    const reason = classifyAddress(hostname);
    if (reason) return { ok: false, reason: `address ${hostname} is ${reason}` };
    return { ok: true, url, addresses: [hostname] };
  }

  const lookup = options.lookup ?? defaultLookup;
  let resolved: ResolvedAddress[];
  try {
    resolved = await lookup(hostname);
  } catch (err) {
    return { ok: false, reason: `DNS lookup of "${hostname}" failed: ${(err as Error).message}` };
  }
  if (!resolved.length) return { ok: false, reason: `DNS lookup of "${hostname}" returned nothing` };
  for (const { address } of resolved) {
    const reason = classifyAddress(address);
    if (reason) return { ok: false, reason: `host "${hostname}" resolves to ${address}, ${reason}` };
  }
  return { ok: true, url, addresses: resolved.map((r) => r.address) };
}
