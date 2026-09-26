/**
 * [P2-9] How `buildTrentTools` builds the a2a toolset: through the egress proxy in production (a
 * peer is always off this process, so no proxy means no transport, exactly as for `web` and
 * `business`), or through the seams a test passes. Through the proxy every request carries the
 * broker's own-credential marker (`egress/CredentialBroker.ts`), so a peer receives its own bearer
 * and never the credential the broker token stands for. Kept out of `tools/index.ts` so the
 * registry stays a registry.
 */
import { A2A_CLIENT_TIMEOUT_MS, type FetchLike } from "../../a2a/client.js";
import type { A2aConfig } from "../../config/sections/a2a.js";
import { OWN_CREDENTIAL_HEADER } from "../../egress/CredentialBroker.js";
import type { TrentToolAdapter } from "../types.js";
import { createEgressFetch, type EgressClientOptions } from "../web/proxied-fetch.js";
import { createA2aAdapter } from "./index.js";
import type { PeerTokenLookup } from "./peers.js";

export interface A2aBuildSeams {
  /** A direct transport for tests only; bypasses the proxy. */
  readonly fetchImpl?: FetchLike;
  /** Where a peer's bearer is read by name; defaults to the profile secrets file, then the environment. */
  readonly tokens?: PeerTokenLookup;
  readonly now?: () => Date;
}

export type A2aBuild = { readonly adapter: TrentToolAdapter; readonly reason?: undefined } | { readonly adapter?: undefined; readonly reason: string };

export function buildA2aToolset(
  config: Partial<A2aConfig> | undefined,
  seams: A2aBuildSeams | undefined,
  egress: Omit<EgressClientOptions, "lookup"> | undefined,
  egressReason: string | undefined,
  profileDir: string,
  seat?: string,
): A2aBuild {
  const options = seams ?? {};
  const viaProxy = options.fetchImpl === undefined && egress !== undefined;
  const fetchImpl = options.fetchImpl ?? (egress === undefined ? undefined : createEgressFetch({ ...egress, timeoutMs: A2A_CLIENT_TIMEOUT_MS }));
  if (fetchImpl === undefined) return { reason: egressReason ?? "the egress proxy is not running; the toolset has no transport" };
  return {
    adapter: createA2aAdapter({
      peers: config?.peers ?? [],
      profileDir,
      fetchImpl,
      ...(viaProxy ? { headers: { [OWN_CREDENTIAL_HEADER]: "1" } } : {}),
      ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(seat === undefined ? {} : { seat }),
    }),
  };
}
