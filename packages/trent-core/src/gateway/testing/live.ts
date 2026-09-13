/**
 * Shared scaffolding for `*.live.test.ts`: a real round trip against the real platform,
 * enabled only when TRENT_TEST_LIVE=1 and the platform's credential env var is present.
 * Credentials come from process.env only; they are never written anywhere.
 */

import { ConfigManager } from "../../config/ConfigManager.js";
import { MemoryGatewayStore } from "../store/GatewayStore.js";
import { createAdapter } from "../registry.js";
import type { TransportAdapter } from "../transport/types.js";

export function liveEnabled(requiredEnv: string): boolean {
  return process.env.TRENT_TEST_LIVE === "1" && Boolean(process.env[requiredEnv]);
}

export function liveAdapter(platform: string): TransportAdapter {
  // readSetting falls through to process.env, so no profile on disk is needed.
  return createAdapter(platform, { config: new ConfigManager({ baseDir: "/nonexistent/trent-live" }), store: new MemoryGatewayStore() });
}

export function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : undefined;
}
