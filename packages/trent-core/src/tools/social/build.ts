/**
 * [T-04] How `buildTrentTools` builds the social toolset: through the egress proxy in production
 * (every post, reply, inbox read and insight leaves the machine, so no proxy means no transport,
 * exactly as for `web`, `business` and `a2a`), or through the seams a test passes — a fake fetch,
 * fake connected providers and token resolvers. Kept out of `tools/index.ts` so the registry stays
 * a registry, and it mirrors `business/build.ts` line for line.
 *
 * Social sends with the USER'S OWN connect token (a Bluesky app password, a Buffer access token, a
 * `trent connect` platform token), so the egress transport is wrapped in {@link withOwnCredential}
 * — the same as `business` — and the proxy forwards that token and swaps in none of its own. Before
 * this the toolset published with a RAW global `fetch` (`publish.ts` `fetchImpl` default), so it was
 * the one outbound toolset outside the proxy's allowlist and SSRF floor.
 */
import type { ToolContext, TrentToolAdapter } from "../types.js";
import { withOwnCredential } from "../business/http.js";
import { createEgressFetch, type EgressClientOptions } from "../web/proxied-fetch.js";
import { createSocialAdapter, type SocialAdapterOptions } from "./index.js";

/** The seams a caller may inject; identical to the adapter's own options, minus the seat. */
export type SocialBuildSeams = SocialAdapterOptions;

export type SocialBuild =
  | { readonly adapter: TrentToolAdapter; readonly reason?: undefined }
  | { readonly adapter?: undefined; readonly reason: string };

export function buildSocialToolset(
  seams: SocialBuildSeams | undefined,
  egress: Omit<EgressClientOptions, "lookup"> | undefined,
  egressReason: string | undefined,
  seat: string | undefined,
  ctx: ToolContext,
): SocialBuild {
  const options = seams ?? {};
  if (options.fetchImpl === undefined && egress === undefined) return { reason: egressReason ?? "the egress proxy is not running; the toolset has no transport" };
  return {
    adapter: createSocialAdapter(ctx, {
      ...options,
      // [P2-14] Through the proxy, the user's own connect token keeps its own credential.
      ...(options.fetchImpl === undefined && egress !== undefined ? { fetchImpl: withOwnCredential(createEgressFetch(egress)) } : {}),
      ...(seat === undefined ? {} : { seat }),
    }),
  };
}
