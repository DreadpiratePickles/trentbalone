/**
 * [P2-9] Which peer a call names, whether a URL may be reached, and the peer's bearer.
 *
 * The allowlist is the configured peers' ORIGINS (scheme, host and port): a URL is reachable only
 * when its origin is one of them, which is decided here before any socket opens, and again for the
 * endpoint a peer's card names, so a card cannot point a send somewhere else. The egress proxy's
 * `intercept_domains` is the second gate, applied by the proxy itself.
 *
 * The bearer is read by the NAME the peer entry gives (`token_env`), from the profile's own secrets
 * file first and the process environment second, the way `trent a2a serve` reads its own token
 * (`TRENT_A2A_TOKEN` through `ConfigManager.get`). The file is parsed without exporting anything
 * into `process.env`, so reading one peer's bearer does not hand this process every other secret.
 * A message names the variable and the file, never the value.
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import type { A2aPeer } from "../../config/sections/a2a.js";

export type { A2aPeer } from "../../config/sections/a2a.js";

/** Reads one secret by name; undefined when it is not set. */
export type PeerTokenLookup = (name: string) => string | undefined;

/** The call's target, resolved: the peer it belongs to and the exact URL to start from. */
export type PeerTarget = { readonly ok: true; readonly peer: A2aPeer; readonly url: string } | { readonly ok: false; readonly reason: string };

function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/** The configured peer whose origin `url` is, if any. */
export function peerForUrl(peers: readonly A2aPeer[], url: string): A2aPeer | undefined {
  const origin = originOf(url);
  return origin === undefined ? undefined : peers.find((peer) => originOf(peer.url) === origin);
}

const notConfigured = (url: string): string => `${url} is not a configured peer; add it under a2a.peers in config.yaml (and its host to egress.intercept_domains) to reach it`;

/** `{peer}` or `{url}` from a call's arguments, checked against the allowlist. */
export function resolveTarget(peers: readonly A2aPeer[], args: Record<string, unknown>): PeerTarget {
  const name = typeof args.peer === "string" ? args.peer.trim() : "";
  const url = typeof args.url === "string" ? args.url.trim() : "";
  if (name !== "") {
    const peer = peers.find((candidate) => candidate.name === name);
    if (peer === undefined) {
      const known = peers.map((candidate) => candidate.name).join(", ");
      return { ok: false, reason: `no peer named "${name}" is configured (${known === "" ? "a2a.peers is empty" : `configured: ${known}`})` };
    }
    return { ok: true, peer, url: peer.url };
  }
  if (url === "") return { ok: false, reason: 'name a peer ("peer") or its url ("url")' };
  const peer = peerForUrl(peers, url);
  return peer === undefined ? { ok: false, reason: notConfigured(url) } : { ok: true, peer, url };
}

/** Why an endpoint a card names may not be used, or undefined when it is the peer's own origin. */
export function endpointRefusal(peer: A2aPeer, endpoint: string): string | undefined {
  return originOf(endpoint) === originOf(peer.url) ? undefined : `the card of "${peer.name}" names the endpoint ${endpoint}, which is not the configured origin ${originOf(peer.url) ?? peer.url}; it is not used`;
}

/** The lookup `trent` uses: `<profileDir>/.env` by name, then the environment. */
export function profileTokenLookup(profileDir: string, env: NodeJS.ProcessEnv = process.env): PeerTokenLookup {
  return (name) => {
    const file = path.join(profileDir, ".env");
    const fromFile = fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file, "utf8"))[name] : undefined;
    const value = fromFile !== undefined && fromFile !== "" ? fromFile : env[name];
    return value === undefined || value === "" ? undefined : value;
  };
}

/** The peer's bearer, or the reason there is none to send. A peer with no `token_env` sends none. */
export function peerToken(peer: A2aPeer, lookup: PeerTokenLookup, profileDir: string): { ok: true; token?: string } | { ok: false; reason: string } {
  if (peer.token_env === undefined) return { ok: true };
  const token = lookup(peer.token_env);
  if (token !== undefined) return { ok: true, token };
  return {
    ok: false,
    reason: `peer "${peer.name}" names token_env ${peer.token_env}, which is set neither in ${path.join(profileDir, ".env")} nor in the environment; run trent config set ${peer.token_env} <token>`,
  };
}
