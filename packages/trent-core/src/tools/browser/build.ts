/**
 * How `buildTrentTools` builds the browser toolset, kept out of `tools/index.ts` so the registry
 * stays a registry (and under the 500-line ceiling). Like web, the browser only ever goes out through
 * the egress proxy. Offline mode disables it: a launched browser is proxied, but attach-mode and UDP
 * (QUIC/WebRTC) egress are not loopback-only (SEC-2 S2b-2 / O-06).
 */
import { isOffline } from "../../egress/offline.js";
import type { TrentToolAdapter } from "../types.js";
import { askVision, type VisionGateway } from "../vision/index.js";
import type { BrowserAttachConfigSource } from "./attach-config.js";
import { browserAttachOptions, createBrowserAdapter } from "./index.js";

export type BrowserBuild = { readonly adapter: TrentToolAdapter; readonly reason?: undefined } | { readonly adapter?: undefined; readonly reason: string };

export interface BrowserBuildDeps {
  readonly profileDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly egress: Parameters<typeof createBrowserAdapter>[0]["egress"];
  readonly runId?: string;
  readonly gateway?: VisionGateway;
  readonly seat?: string;
}

export function buildBrowserToolset(config: BrowserAttachConfigSource, deps: BrowserBuildDeps): BrowserBuild {
  if (isOffline(deps.env)) {
    return { reason: "offline mode: the browser tool is disabled (attach-mode and UDP egress are not loopback-only)" };
  }
  return {
    adapter: createBrowserAdapter({
      profileDir: deps.profileDir,
      egress: deps.egress,
      env: deps.env,
      ...(deps.runId ? { runId: deps.runId } : {}),
      ...(deps.gateway ? { vision: (input) => askVision(deps.gateway!, input) } : {}),
      ...browserAttachOptions(config, deps.seat), // [H5] tools.browser.attach + egress.intercept_domains
    }),
  };
}
