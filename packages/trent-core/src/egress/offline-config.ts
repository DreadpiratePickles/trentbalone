/**
 * [SEC-2 S2a-3] Offline mode rejects a profile that would still reach the network.
 *
 * `egress/offline.ts` decides whether offline is on and whether a live dial is allowed; this module
 * is the declarative half: at run boot, when offline is on, it scans the loaded config for every
 * setting that names a hosted destination and refuses the run with one actionable list, rather than
 * starting and silently leaving the machine. The runtime tool gates (no egress container, browser
 * off, faster-whisper cached-only) and the loopback-only proxy allowlist land in S2b; this closes the
 * config front door (D6 O-01/O-04/O-05/O-08/O-10).
 */
import { resolveProviderAlias } from "../model-gateway/providers.js";
import { isOffline } from "./offline.js";

/** One reason a profile is not offline-safe, with the fix stated. */
export interface OfflineViolation {
  readonly setting: string;
  readonly detail: string;
  readonly fix: string;
}

/** Embedder providers that embed off this machine. `auto`/`none`/local runtimes are safe. */
const HOSTED_EMBEDDERS = new Set(["gemini", "google", "openai"]);

/** The intercept_domains an offline run collapses its allowlist to (wired where the proxy is built). */
export const LOOPBACK_ALLOWLIST: readonly string[] = ["127.0.0.1", "::1", "localhost"];

function isLoopbackUrl(raw: string): boolean {
  try {
    const host = new URL(raw).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host);
  } catch {
    return false;
  }
}

interface OfflineInspectable {
  readonly provider?: string;
  readonly models?: { readonly escalate?: unknown };
  readonly memory?: { readonly embedder?: { readonly provider?: string; readonly base_url?: string } };
  readonly telemetry?: { readonly otlp_endpoint?: string };
  readonly gateway?: { readonly enabled?: boolean; readonly platforms?: readonly string[] };
}

/** Every hosted setting in `config`, or [] when offline is off or the profile is clean. */
export function offlineConfigViolations(config: unknown, env: NodeJS.ProcessEnv = process.env): OfflineViolation[] {
  if (!isOffline(env)) return [];
  const c = (config ?? {}) as OfflineInspectable;
  const out: OfflineViolation[] = [];

  if (resolveProviderAlias(c.provider)?.local !== true) {
    out.push({
      setting: "provider",
      detail: `'${c.provider ?? "(unset)"}' is a hosted model provider`,
      fix: "set a local provider (ollama, lmstudio, llamacpp) or run without offline mode",
    });
  }
  if (c.models?.escalate !== undefined) {
    out.push({
      setting: "models.escalate",
      detail: "hosted escalation would send calls off the machine for approval",
      fix: "remove models.escalate, or run without offline mode",
    });
  }
  const embedder = c.memory?.embedder;
  if (embedder?.provider !== undefined && HOSTED_EMBEDDERS.has(embedder.provider)) {
    out.push({
      setting: "memory.embedder",
      detail: `embedder provider '${embedder.provider}' embeds off the machine`,
      fix: "use a local embedder (ollama, lmstudio, llamacpp), 'none', or 'auto' under a local provider",
    });
  } else if (embedder?.base_url !== undefined && embedder.base_url !== "" && !isLoopbackUrl(embedder.base_url)) {
    out.push({
      setting: "memory.embedder.base_url",
      detail: `embedder base_url '${embedder.base_url}' is not loopback`,
      fix: "point the embedder base_url at localhost, or run without offline mode",
    });
  }
  const otlp = c.telemetry?.otlp_endpoint;
  if (otlp !== undefined && otlp !== "" && !isLoopbackUrl(otlp)) {
    out.push({
      setting: "telemetry.otlp_endpoint",
      detail: `traces would be exported to '${otlp}'`,
      fix: "point otlp_endpoint at localhost, unset it, or run without offline mode",
    });
  }
  if (c.gateway?.enabled === true && (c.gateway.platforms?.length ?? 0) > 0) {
    out.push({
      setting: "gateway",
      detail: `the messaging gateway is enabled for ${c.gateway.platforms!.join(", ")}`,
      fix: "disable the gateway (or clear gateway.platforms) for an offline run",
    });
  }
  return out;
}

/** Throws with every violation named, or returns when offline is off or the profile is clean. */
export function assertOfflineConfig(config: unknown, env: NodeJS.ProcessEnv = process.env): void {
  const violations = offlineConfigViolations(config, env);
  if (violations.length === 0) return;
  const lines = violations.map((v) => `  - ${v.setting}: ${v.detail} (fix: ${v.fix})`);
  throw new Error(`offline mode is on, but this profile still reaches the network:\n${lines.join("\n")}`);
}
