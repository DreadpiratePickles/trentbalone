/**
 * Allowlist matching and the token-for-secret swap performed at the boundary.
 *
 * Split out of the proxy so the policy is unit-testable without a socket, and so there is exactly
 * one function that can ever place a real secret into an outbound header.
 */
import type http from "node:http";
import type { ProxyTokenRecord } from "./TokenStorePort.js";
import { TOKEN_PREFIX } from "./TokenManager.js";
import { bindingTargetHost, boundHostsOf, secretWithheldReason, type SecretWithheld } from "./host-binding.js";

/** Header names a client may present the opaque token in. */
const TOKEN_HEADERS = ["x-trent-proxy-token", "authorization", "x-api-key", "x-goog-api-key"];

// [P2-9] own credential
/**
 * Sent by a tool that authenticates to its own peer (an A2A agent's bearer) or to nobody. The
 * broker then swaps nothing in: it removes only what is its own and lets the caller's headers
 * through, so the record's secret (in the REPL, the model provider key) never reaches a host the
 * caller is talking to on its own account. It can only take away what the proxy adds, never add a
 * secret, and the allowlist and token gates run before it exactly as for every other request.
 */
export const OWN_CREDENTIAL_HEADER = "x-trent-own-credential";

function carriesBrokerToken(value: string | string[] | undefined): boolean {
  const text = Array.isArray(value) ? value.join(" ") : value ?? "";
  return text.includes(TOKEN_PREFIX);
}

function ownCredential(headers: http.IncomingHttpHeaders, host: string): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  for (const name of [OWN_CREDENTIAL_HEADER, "x-trent-proxy-token", "proxy-authorization", "proxy-connection"]) delete out[name];
  for (const name of TOKEN_HEADERS) if (carriesBrokerToken(headers[name])) delete out[name];
  out.host = host;
  return out;
}
// [/P2-9]

export function normalizeHost(hostHeader: string | undefined): string {
  if (!hostHeader) return "";
  const withoutPort = hostHeader.replace(/^\[(.+)\]$/, "$1").split(":")[0] ?? "";
  return withoutPort.trim().toLowerCase();
}

/**
 * Exact match, or a `*.example.com` wildcard covering one or more leading labels. An empty
 * allowlist matches nothing: deny by default, including on a misconfiguration.
 */
export function isHostAllowed(host: string, interceptDomains: readonly string[]): boolean {
  const target = normalizeHost(host);
  if (!target) return false;
  return interceptDomains.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".example.com"
      return target.endsWith(suffix) && target.length > suffix.length;
    }
    return target === pattern;
  });
}

/** Pull the opaque token out of whichever header the client used. Returns null if there is none. */
export function extractToken(headers: http.IncomingHttpHeaders): string | null {
  for (const name of TOKEN_HEADERS) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") continue;
    const candidate = value.startsWith("Bearer ") ? value.slice(7).trim() : value.trim();
    if (candidate.startsWith(TOKEN_PREFIX)) return candidate;
  }
  return null;
}

// [egress host binding]
/** Where the request is going beyond its host, and who hears about a withheld secret. */
export interface CredentialTarget {
  /** The target port. A binding that names a port (`127.0.0.1:11434`) matches that port only. */
  readonly port?: number;
  /** Called when the record's secret is withheld from this host. Given the host, never the secret. */
  readonly onWithheld?: (event: SecretWithheld) => void;
}
// [/egress host binding]

/**
 * Replace every credential-bearing header with the real secret for this host. The token headers are
 * removed first so an opaque token can never leak upstream, and no header is left carrying a value
 * the sandbox chose. The secret is written only onto a host the record is bound to
 * (`host-binding.ts`); to any other host the request goes as it would with the own-credential
 * marker: the broker removes only what is its own and adds nothing.
 */
export function applyCredentials(
  headers: http.IncomingHttpHeaders,
  host: string,
  record: ProxyTokenRecord,
  destination: CredentialTarget = {}
): http.OutgoingHttpHeaders {
  // [P2-9] own credential: the caller's own Authorization (or none) passes; no record secret is added.
  if (headers[OWN_CREDENTIAL_HEADER] !== undefined) return ownCredential(headers, host);
  const secret = record.realCredentials.apiKey ?? record.realCredentials.token;
  // [egress host binding] A secret is withheld from every host it is not bound to, and from all of
  // them when the record names none. The caller's own credential (a search key) still passes.
  const withheld = secret ? secretWithheldReason(host, destination.port, record) : null;
  if (withheld !== null) {
    destination.onWithheld?.({
      host: bindingTargetHost(host),
      ...(destination.port === undefined ? {} : { port: destination.port }),
      reason: withheld,
      boundHosts: boundHostsOf(record),
    });
    return ownCredential(headers, host);
  }
  const out: http.OutgoingHttpHeaders = { ...headers };
  for (const name of TOKEN_HEADERS) delete out[name];
  delete out["proxy-authorization"];
  delete out["proxy-connection"];
  out.host = host;

  if (!secret) return out;

  const explicit = record.realCredentials.headerName;
  if (explicit) {
    out[explicit.toLowerCase()] = secret;
    return out;
  }

  const target = normalizeHost(host);
  if (target.endsWith("anthropic.com")) {
    out["x-api-key"] = secret;
    out["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
  } else if (target.endsWith("googleapis.com")) {
    out["x-goog-api-key"] = secret;
  } else {
    out.authorization = `Bearer ${secret}`;
  }
  return out;
}
