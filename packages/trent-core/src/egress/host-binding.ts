/**
 * Which hosts a brokered secret may be written onto.
 *
 * A `ProxyTokenRecord` carries a real credential and the host(s) it belongs to. The broker used to
 * write the secret onto EVERY allowlisted request carrying the token, so the model provider key
 * reached any other `egress.intercept_domains` host a sandboxed tool contacted with a plain fetch
 * (and, on a Gemini profile, api.openai.com: the sandbox holds the one token in every provider
 * key variable). Now it is written only where `isHostBound` says so.
 *
 * A binding is `host` or `host:port`. A DNS name also covers its subdomains, on a label boundary
 * (`api.openai.com` covers `eu.api.openai.com`, never `evilapi.openai.com`); an IP literal is exact.
 * A port, when named, must match: a local runtime shares 127.0.0.1 with every other local service.
 * A record with no binding is bound to nothing. Pure: no I/O, nothing logged here.
 */
import net from "node:net";
import type { ProxyTokenRecord } from "./TokenStorePort.js";

export type SecretWithheldReason = "no_host_binding" | "host_not_bound";

/** What the broker reports when it forwards a request without the record's secret. Never the secret. */
export interface SecretWithheld {
  readonly host: string;
  readonly port?: number;
  readonly reason: SecretWithheldReason;
  readonly boundHosts: readonly string[];
}

interface Binding {
  readonly host: string;
  readonly port?: number;
}

const BRACKETED_V6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/;
const NAME_AND_PORT = /^([a-z0-9_.-]+?)\.?(?::(\d{1,5}))?$/;
const LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/;

function parseBinding(entry: string): Binding | null {
  const text = entry.trim().toLowerCase();
  let host: string;
  let portText: string | undefined;
  const v6 = BRACKETED_V6.exec(text);
  if (v6) {
    host = v6[1]!;
    portText = v6[2];
    if (net.isIP(host) !== 6) return null;
  } else {
    const plain = NAME_AND_PORT.exec(text);
    if (!plain) return null;
    host = plain[1]!;
    portText = plain[2];
    if (!host.split(".").every((label) => LABEL.test(label))) return null;
  }
  if (portText === undefined) return { host };
  const port = Number(portText);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? { host, port } : null;
}

function formatBinding(binding: Binding): string {
  const host = net.isIP(binding.host) === 6 ? `[${binding.host}]` : binding.host;
  return binding.port === undefined ? host : `${host}:${binding.port}`;
}

/**
 * Validate and normalise the hosts a token is minted for. Throws on anything that is not a plain
 * `host` or `host:port` (a URL, a wildcard, userinfo, an empty or spaced name, a bad port): a
 * binding that cannot be matched exactly is a binding nobody can reason about.
 */
export function normalizeCredentialHosts(hosts: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of hosts) {
    const binding = typeof entry === "string" ? parseBinding(entry) : null;
    if (binding === null) {
      throw new Error(`egress: refusing to bind a credential to host ${JSON.stringify(entry)}; name a host or host:port, never a URL or a wildcard`);
    }
    const formatted = formatBinding(binding);
    if (!out.includes(formatted)) out.push(formatted);
  }
  return out;
}

/** The target host as the broker compares it: lower case, no port, no brackets, no trailing dot. */
export function bindingTargetHost(host: string): string {
  const text = host.trim().toLowerCase();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (v6) return v6[1]!;
  const parts = text.split(":");
  const bare = parts.length === 2 ? parts[0]! : text;
  return bare.replace(/\.$/, "");
}

/** The record's bindings, ignoring anything a hand-edited store put there that is not a string. */
export function boundHostsOf(record: ProxyTokenRecord): string[] {
  const hosts: unknown = record.hosts;
  return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
}

function bindingMatches(binding: Binding, target: string, port: number | undefined): boolean {
  if (binding.port !== undefined && binding.port !== port) return false;
  if (target === binding.host) return true;
  if (net.isIP(binding.host) !== 0 || net.isIP(target) !== 0) return false;
  return target.endsWith(`.${binding.host}`);
}

/** True when a request to `host` (on `port`, when known) may carry a secret bound to `hosts`. */
export function isHostBound(host: string, port: number | undefined, hosts: readonly string[]): boolean {
  const target = bindingTargetHost(host);
  if (!target) return false;
  return hosts.some((entry) => {
    const binding = parseBinding(entry);
    return binding !== null && bindingMatches(binding, target, port);
  });
}

/** Why the record's secret must not go to this host, or null when it may. */
export function secretWithheldReason(host: string, port: number | undefined, record: ProxyTokenRecord): SecretWithheldReason | null {
  const hosts = boundHostsOf(record);
  if (hosts.length === 0) return "no_host_binding";
  return isHostBound(host, port, hosts) ? null : "host_not_bound";
}
