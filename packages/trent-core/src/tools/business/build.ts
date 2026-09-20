/**
 * How `buildTrentTools` builds the business toolset: through the egress proxy in production
 * (every call leaves the machine, so no proxy means no transport, exactly as for `web`), or
 * through the seams a test passes — a direct transport, fake endpoints, a token stub, a ledger.
 * Kept out of `tools/index.ts` so the registry stays a registry.
 */
import type { TrentToolAdapter } from "../types.js";
import type { EgressClientOptions } from "../web/proxied-fetch.js";
import { createBusinessAdapter, type BusinessAdapterOptions } from "./index.js";

export type BusinessBuildSeams = Pick<BusinessAdapterOptions, "fetchImpl" | "endpoints" | "tokens" | "spend">;

export type BusinessBuild = { readonly adapter: TrentToolAdapter; readonly reason?: undefined } | { readonly adapter?: undefined; readonly reason: string };

export function buildBusinessToolset(
  seams: BusinessBuildSeams | undefined,
  egress: Omit<EgressClientOptions, "lookup"> | undefined,
  egressReason: string | undefined,
  seat: string | undefined,
  profileDir: string,
): BusinessBuild {
  const options = seams ?? {};
  if (options.fetchImpl === undefined && egress === undefined) return { reason: egressReason ?? "the egress proxy is not running; the toolset has no transport" };
  return {
    adapter: createBusinessAdapter({
      ...options,
      ...(options.fetchImpl === undefined && egress !== undefined ? { egress } : {}),
      ...(seat === undefined ? {} : { seat }),
      profileDir,
    }),
  };
}
