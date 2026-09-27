/**
 * [SEC-2 S2b-1] The enumerated egress surface.
 *
 * One static row per network-capable path in the offline-completeness audit's §1 table
 * (`01_discovery/output/security-offline-completeness-2026-09-26.md`). This is the single list the
 * offline proof (`doctor/checks/offline.ts`, `trent security --offline`) walks to certify that every
 * path that could open a socket is covered by one of the three offline layers — and the list a
 * coverage test (`registry.test.ts`) holds to the source tree, so a new hosted-egress module that is
 * never registered breaks CI rather than silently widening the surface.
 *
 * The registry describes; it never dials. `dials` is HOW a path reaches the network; `offlineGate`
 * is WHICH layer makes it safe when `TRENT_OFFLINE` is on:
 *   - `loopback-only`   the dial is physically constrained to loopback — either it rides `trentFetch`
 *                       (which throws `EgressBlocked` for any non-loopback target, proven live by the
 *                       offline check's canary) or it rides the egress proxy, whose allowlist offline
 *                       collapses to the loopback set, or it only ever targets the configured local
 *                       base URL a local provider pins to 127.0.0.1.
 *   - `config-rejected` the setting that would turn this path on is refused at config load offline
 *                       (`egress/offline-config.ts`): a hosted provider, `models.escalate`, a hosted
 *                       embedder, a remote OTLP endpoint, an enabled gateway/social route.
 *   - `disabled`        the tool is switched off entirely offline (the browser; `trent update`).
 *   - `cached-only`     the tool runs only against a model already on disk (faster-whisper), naming
 *                       the cache path when it is absent.
 */

/** How a path reaches the network. */
export type EgressDial = "trentFetch" | "proxy" | "node:https" | "socket" | "subprocess";

/** The offline layer that covers a path. See the module header. */
export type OfflineGate = "loopback-only" | "disabled" | "cached-only" | "config-rejected";

export interface EgressPath {
  /** Stable id, used in the proof output and tests. */
  readonly id: string;
  /** Repo-relative path of the module that owns the dial. */
  readonly module: string;
  /** How this path reaches the network. */
  readonly dials: EgressDial;
  /** Whether the path is live on a stock profile (off ones are still enumerated and proven). */
  readonly defaultEnabled: boolean;
  /** Which offline layer makes this path safe when offline is on. */
  readonly offlineGate: OfflineGate;
  /** One line for the proof output: what this path is. */
  readonly note: string;
}

const M = "packages/trent-core/src/";

/**
 * Every network-capable path. Rows whose module imports a network primitive are also held by the
 * coverage test; rows that dial only through a helper (escalation, cron alert) or a native/subprocess
 * transport (browser, faster-whisper) are enumerated here for the proof even though the scan cannot
 * see them.
 */
export const EGRESS_PATHS: readonly EgressPath[] = [
  // ── Model calls ────────────────────────────────────────────────────────────────────────────
  { id: "model-openai-compat", module: `${M}model-gateway/openai-compat.ts`, dials: "trentFetch", defaultEnabled: true, offlineGate: "loopback-only", note: "chat completion (OpenAI/Google dialect); local base under a local provider" },
  { id: "model-anthropic", module: `${M}model-gateway/anthropic-client.ts`, dials: "trentFetch", defaultEnabled: true, offlineGate: "loopback-only", note: "Anthropic messages; unused under a local provider, and a hosted provider is config-rejected" },
  { id: "model-escalation", module: `${M}model-gateway/escalation.ts`, dials: "trentFetch", defaultEnabled: false, offlineGate: "config-rejected", note: "hosted planner/critic escalation; models.escalate is refused at load offline" },
  { id: "model-local-probe", module: `${M}model-gateway/local-probe.ts`, dials: "trentFetch", defaultEnabled: true, offlineGate: "loopback-only", note: "local runtime capability probe (ctx window, slots)" },
  { id: "model-local-runtime", module: `${M}model-gateway/local-runtime.ts`, dials: "node:https", defaultEnabled: true, offlineGate: "loopback-only", note: "local model stream transport; targets the configured loopback base only" },
  // ── Embeddings & retrieval ─────────────────────────────────────────────────────────────────
  { id: "embedder", module: `${M}fleet-memory/embedder.ts`, dials: "trentFetch", defaultEnabled: true, offlineGate: "loopback-only", note: "recall embedder; a hosted memory.embedder.provider is config-rejected" },
  { id: "embedder-local", module: `${M}fleet-memory/embedder-local.ts`, dials: "trentFetch", defaultEnabled: true, offlineGate: "loopback-only", note: "local embedder route (127.0.0.1)" },
  // ── Tool egress through the proxy ──────────────────────────────────────────────────────────
  { id: "proxy-fetch", module: `${M}tools/web/proxied-fetch.ts`, dials: "proxy", defaultEnabled: true, offlineGate: "loopback-only", note: "the egress-proxy client every tool-layer fetch rides; offline allowlist is loopback-only" },
  { id: "web", module: `${M}tools/web/index.ts`, dials: "proxy", defaultEnabled: true, offlineGate: "loopback-only", note: "web / web_extract, bounded by the proxy allowlist" },
  { id: "vision-url", module: `${M}tools/vision/image-source.ts`, dials: "proxy", defaultEnabled: false, offlineGate: "loopback-only", note: "vision_analyze URL fetch, through the proxy" },
  { id: "business", module: `${M}tools/business/index.ts`, dials: "proxy", defaultEnabled: false, offlineGate: "loopback-only", note: "business HTTP adapters, through the proxy" },
  { id: "mcp-http-transport", module: `${M}tools/mcp/http-transport.ts`, dials: "proxy", defaultEnabled: false, offlineGate: "loopback-only", note: "MCP streamable-http/SSE request transport, through the proxy" },
  { id: "mcp-client", module: `${M}tools/mcp/client.ts`, dials: "proxy", defaultEnabled: false, offlineGate: "loopback-only", note: "MCP client transport wiring, through the proxy" },
  { id: "a2a-peer", module: `${M}tools/a2a/build.ts`, dials: "proxy", defaultEnabled: false, offlineGate: "loopback-only", note: "a2a peer calls, through the proxy" },
  // ── Tools that need a native/subprocess/OAuth transport of their own ───────────────────────
  { id: "mcp-http-oauth", module: `${M}tools/mcp/http-oauth.ts`, dials: "trentFetch", defaultEnabled: false, offlineGate: "loopback-only", note: "MCP OAuth issuer discovery + token exchange, via trentFetch" },
  { id: "connect-oauth", module: `${M}connect/flow.ts`, dials: "trentFetch", defaultEnabled: false, offlineGate: "loopback-only", note: "trent connect provider token endpoint, via trentFetch" },
  { id: "media-image", module: `${M}tools/media/image.ts`, dials: "trentFetch", defaultEnabled: false, offlineGate: "loopback-only", note: "hosted image generation/fetch, via trentFetch" },
  { id: "media-faster-whisper", module: `${M}tools/media/transcribe.ts`, dials: "subprocess", defaultEnabled: false, offlineGate: "cached-only", note: "faster-whisper downloads a model on first use; offline refuses it unless the model is cached" },
  { id: "browser", module: `${M}tools/browser/index.ts`, dials: "subprocess", defaultEnabled: false, offlineGate: "disabled", note: "launched/attached Chromium makes arbitrary requests; offline disables the toolset" },
  // ── Gateway / messaging (all off unless gateway.enabled) ───────────────────────────────────
  { id: "gateway-slack", module: `${M}gateway/platforms/slack.ts`, dials: "socket", defaultEnabled: false, offlineGate: "config-rejected", note: "Slack HTTP + socket-mode WebSocket; an enabled gateway is refused at load offline" },
  { id: "gateway-discord", module: `${M}gateway/platforms/discord.ts`, dials: "socket", defaultEnabled: false, offlineGate: "config-rejected", note: "Discord gateway WebSocket + HTTP" },
  { id: "gateway-mattermost", module: `${M}gateway/platforms/mattermost.ts`, dials: "socket", defaultEnabled: false, offlineGate: "config-rejected", note: "Mattermost WebSocket + HTTP" },
  { id: "gateway-email", module: `${M}gateway/platforms/email/lineSocket.ts`, dials: "socket", defaultEnabled: false, offlineGate: "config-rejected", note: "IMAP/SMTP raw sockets for the email platform" },
  { id: "social-publish", module: `${M}tools/social/build.ts`, dials: "proxy", defaultEnabled: false, offlineGate: "loopback-only", note: "social publishers (Bluesky, Buffer, Matrix), routed through the proxy" },
  { id: "cron-alert", module: `${M}cron/CronRunner.ts`, dials: "socket", defaultEnabled: false, offlineGate: "config-rejected", note: "cron [CRON_FAILURE] alert out the gateway.owner platform path" },
  // ── Background / telemetry / updates ───────────────────────────────────────────────────────
  { id: "otel-exporter", module: `${M}traces/OTelExporter.ts`, dials: "trentFetch", defaultEnabled: false, offlineGate: "loopback-only", note: "OTLP trace export; a remote otlp_endpoint is config-rejected, and the dial rides trentFetch" },
  { id: "updater-release", module: `${M}updater/release.ts`, dials: "node:https", defaultEnabled: false, offlineGate: "disabled", note: "trent update fetches GitHub releases over node:https; offline refuses the command" },
  // ── Local probes / setup / doctor (loopback-only by construction) ──────────────────────────
  { id: "setup-local-detect", module: `${M}setup/local-detect.ts`, dials: "trentFetch", defaultEnabled: true, offlineGate: "loopback-only", note: "setup runtime detection; probes only local runtime URLs" },
  { id: "setup-local-runtime", module: `${M}setup/local-runtime.ts`, dials: "trentFetch", defaultEnabled: true, offlineGate: "loopback-only", note: "setup local runtime probes (loopback)" },
  { id: "doctor-probe", module: `${M}doctor/probe.ts`, dials: "trentFetch", defaultEnabled: true, offlineGate: "loopback-only", note: "doctor HTTP probe helper" },
  { id: "doctor-embedder", module: `${M}doctor/checks/embedder.ts`, dials: "trentFetch", defaultEnabled: true, offlineGate: "loopback-only", note: "doctor embedder smoke check (loopback)" },
  { id: "doctor-local-stream", module: `${M}doctor/checks/local-stream.ts`, dials: "trentFetch", defaultEnabled: true, offlineGate: "loopback-only", note: "doctor local-stream smoke check (loopback)" },
];

/** The distinct module paths the registry names — the set the coverage test holds the tree to. */
export const NETWORK_CAPABLE_MODULES: ReadonlySet<string> = new Set(EGRESS_PATHS.map((p) => p.module));

/** The rows grouped by their offline gate, in the order the gates are declared. */
export function egressPathsByGate(): Record<OfflineGate, EgressPath[]> {
  const out: Record<OfflineGate, EgressPath[]> = {
    "loopback-only": [],
    disabled: [],
    "cached-only": [],
    "config-rejected": [],
  };
  for (const path of EGRESS_PATHS) out[path.offlineGate].push(path);
  return out;
}
