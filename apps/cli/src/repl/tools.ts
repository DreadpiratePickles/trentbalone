/**
 * The toolsets and the egress proxy, wired for one REPL session.
 *
 * `wireTools` is what `index.ts` calls between the boot banner and `createOrchestrator`:
 *   1. the sandbox is resolved — Docker with the configured image, the public floor image when
 *      the configured one is absent, or the confined local backend when there is no daemon;
 *   2. with `config.egress.enabled` (the default) an `EgressProxy` is started on a free loopback
 *      port and its URL, token and CA path are handed to the tools. If it fails to start the
 *      tools run with NO network — never with an open one — and the status line says so;
 *   3. the adapters for `config.toolsets - config.disabled_toolsets` are built, with the
 *      orchestrator's `DelegatePort` bound to `delegation`, `plugins` reading `<profile>/plugins`,
 *      `skills` and `cron` under the profile, and `web` on the proxy's host-side URL. A toolset
 *      the builder cannot produce (`web` without a proxy) is reported in `skipped` and on the
 *      status line, never dropped silently.
 * `cleanup()` releases the sandboxes and stops the proxy; `index.ts` calls it on every exit path.
 *
 * Every collaborator is injectable so the tests can record what was built without Docker or a
 * socket, and so the live proxy can be observed listening and then not.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { EgressProxy, TokenManager, credentialHostsForProvider, egressBindHosts } from "@trent/core/egress/index.js";
import type { ConfigManager } from "@trent/core/config/index.js";
import { SANDBOX_IMAGE } from "@trent/core/terminal/index.js";
import {
  buildTrentToolAdapters,
  buildTrentTools,
  enabledToolsets,
  type DelegatePort,
  type ProvenanceLedger, // [C2]
  type SkippedToolset,
  type ToolBuildConfig,
  type ToolBuildDeps,
  type TrentToolAdapter,
  type TrentToolBuild,
} from "@trent/core/tools/index.js";
import type { Theme } from "../ui/index.js";
import type { ReplEgressStatus, ReplSandbox } from "./types.js";

/** The image used when the configured one does not exist locally. Public, tiny, has a POSIX sh. */
export const FLOOR_IMAGE = "alpine:3";
const DOCKER_PROBE_TIMEOUT_MS = 8_000;

/** The env var each provider's key lives in; only the NAME is read here, the value goes to the broker. */
const PROVIDER_KEY_VARS: Readonly<Record<string, string>> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

export interface ToolWiringConfig extends ToolBuildConfig {
  readonly provider?: string;
  readonly egress?: { readonly enabled?: boolean; readonly intercept_domains?: readonly string[] };
}

export interface DockerProbe {
  readonly daemon: boolean;
  readonly imagePresent: boolean;
}

/** A running proxy as the REPL sees it: where it listens, what the sandbox presents, and how to stop it. */
export interface EgressHandle {
  readonly port: number;
  /** As reachable from this host: `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly token: string;
  readonly caCertPath: string;
  isListening(): boolean;
  stop(): Promise<void>;
}

export interface StartEgressInput {
  readonly configManager?: ConfigManager;
  readonly interceptDomains?: readonly string[];
  /** The real credential the broker swaps in at the boundary. Never logged; never enters a sandbox. */
  readonly credentials?: Record<string, string>;
  /**
   * [egress host binding] The host(s) `credentials` belong to (`host` or `host:port`). The broker
   * injects the credential only into requests to these; absent, it injects it nowhere.
   */
  readonly credentialHosts?: readonly string[];
  /** 0 (the default) takes a free loopback port. */
  readonly port?: number;
  /**
   * Addresses to listen on; loopback when absent. `wireTools` adds the Docker bridge gateway on
   * Linux so a container's `host.docker.internal` reaches the proxy. Never a wildcard.
   */
  readonly bindHosts?: readonly string[];
  /**
   * The token store. The REPL's default is ephemeral (the token dies with the session); the
   * `trent egress start` daemon passes the durable file-backed manager so tokens issued elsewhere resolve.
   */
  readonly tokenManager?: TokenManager;
}

export interface ToolWiringDeps {
  readonly config: ToolWiringConfig;
  /** The directory `trent` was launched in. Never the home directory. */
  readonly workspace: string;
  readonly profileDir: string;
  readonly configManager?: ConfigManager;
  /** Legacy recorder seam: an adapters-only factory (nothing is reported as skipped). */
  readonly buildAdapters?: typeof buildTrentToolAdapters;
  /** The full factory, with `skipped`; wins over `buildAdapters`. */
  readonly buildTools?: typeof buildTrentTools;
  readonly startEgress?: (input: StartEgressInput) => Promise<EgressHandle>;
  readonly probeDocker?: (image: string) => Promise<DockerProbe>;
  /** Defaults to `process.platform`; decides whether the proxy also binds the Docker bridge gateway. */
  readonly platform?: NodeJS.Platform;
  /** Bridge gateway discovery for Linux + Docker; defaults to `docker network inspect bridge`. */
  readonly discoverBridgeGateway?: () => Promise<string>;
  /** The orchestrator's delegation path; without it `delegate_task` reports `not_available`. */
  readonly delegate?: DelegatePort;
  /** [S2] The runtime's policy dispatcher, so a surface can seed a run's ring (H3 webhook runs); absent, the build makes its own. */
  readonly policy?: ToolBuildDeps["policy"];
}

export interface ToolWiring {
  readonly adapters: TrentToolAdapter[];
  readonly toolsets: string[];
  /** Enabled in config, not registered, and why. */
  readonly skipped: SkippedToolset[];
  /**
   * A2.2: one line per configured hook that did not run, from `buildTrentTools`. A hook is skipped
   * when a tool CALL is made, which is always after this wiring returned, so this is read after a
   * turn rather than at start-up — and the field stays live for exactly that reason.
   */
  readonly hookNotices: readonly string[];
  /** [C2] The ledger the build's provenance gate writes to; the fleet's memory gate must share it (taint is per instance). Absent on the legacy seam. */
  readonly provenance?: ProvenanceLedger;
  readonly sandbox: ReplSandbox;
  readonly egress: ReplEgressStatus;
  cleanup(): Promise<void>;
}

// ── the real collaborators ──────────────────────────────────────────────────

function docker(args: string[]): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) =>
    execFile("docker", args, { timeout: DOCKER_PROBE_TIMEOUT_MS }, (error, stdout) => resolve({ ok: !error, stdout: String(stdout) })),
  );
}

/**
 * `docker info` exiting 0 is the daemon; `docker inspect --type image` is the image. The
 * `docker image inspect` form reports "No such image" for images this daemon (29.x) lists and
 * runs, so it is not used here nor in the doctor's workbench check.
 */
export async function probeDockerCli(image: string): Promise<DockerProbe> {
  const info = await docker(["info", "--format", "{{.ServerVersion}}"]);
  if (!info.ok || info.stdout.trim() === "") return { daemon: false, imagePresent: false };
  const inspect = await docker(["inspect", "--type", "image", "--format", "{{.Id}}", image]);
  return { daemon: true, imagePresent: inspect.ok && inspect.stdout.trim() !== "" };
}

/** Starts the real proxy. By default the token is session-scoped (ephemeral store): it dies with the proxy. */
export async function startEgressProxy(input: StartEgressInput): Promise<EgressHandle> {
  const tokenManager = input.tokenManager ?? new TokenManager({ ephemeral: true });
  const proxy = new EgressProxy({
    port: input.port ?? 0,
    tokenManager,
    configManager: input.configManager,
    ...(input.interceptDomains ? { interceptDomains: [...input.interceptDomains] } : {}),
    ...(input.bindHosts ? { bindHosts: [...input.bindHosts] } : {}),
  });
  await proxy.start();
  let token: string;
  try {
    token = tokenManager.issueToken("trent-repl", input.credentials ?? {}, "repl", {
      ...(input.credentialHosts === undefined ? {} : { hosts: input.credentialHosts }),
    });
  } catch (error) {
    await proxy.stop(); // a refused binding must not leave a listener behind
    throw error;
  }
  const port = proxy.getPort();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    token,
    caCertPath: proxy.getCaCertPath(),
    isListening: () => proxy.isRunning(),
    stop: async () => {
      tokenManager.revokeToken(token);
      await proxy.stop();
    },
  };
}

// ── the wiring ──────────────────────────────────────────────────────────────

async function resolveSandbox(deps: ToolWiringDeps): Promise<ReplSandbox> {
  const configured = deps.config.terminal?.backend;
  if (configured === "local") return { backend: "local", note: "configured" };
  const image = deps.config.terminal?.docker?.image ?? SANDBOX_IMAGE;
  const probe = await (deps.probeDocker ?? probeDockerCli)(image);
  if (!probe.daemon) {
    return { backend: "local", note: "docker unavailable; local backend, confined to the workspace" };
  }
  if (probe.imagePresent) return { backend: "docker", image };
  return { backend: "docker", image: FLOOR_IMAGE, note: `${image} not found; floor image` };
}

/** The credential the broker will swap in for the configured provider; only the env NAME is decided here. */
function providerCredentials(config: ToolWiringConfig): Record<string, string> {
  const name = config.provider === undefined ? undefined : PROVIDER_KEY_VARS[config.provider];
  const value = name === undefined ? undefined : process.env[name];
  return value === undefined || value.trim() === "" ? {} : { apiKey: value };
}

export async function wireTools(deps: ToolWiringDeps): Promise<ToolWiring> {
  const sandbox = await resolveSandbox(deps);
  const toolsets = enabledToolsets(deps.config);

  let handle: EgressHandle | undefined;
  let egress: ReplEgressStatus;
  if (deps.config.egress?.enabled === false) {
    egress = { state: "off" };
  } else {
    try {
      // On Linux the bridge container reaches the host through the bridge gateway, not loopback.
      const bindHosts = await egressBindHosts({
        backend: sandbox.backend,
        ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
        ...(deps.discoverBridgeGateway !== undefined ? { discover: deps.discoverBridgeGateway } : {}),
      });
      handle = await (deps.startEgress ?? startEgressProxy)({
        configManager: deps.configManager,
        interceptDomains: deps.config.egress?.intercept_domains,
        credentials: providerCredentials(deps.config),
        // [egress host binding] the key goes only to the host the provider's model calls go to
        credentialHosts: credentialHostsForProvider(deps.config.provider, process.env),
        bindHosts,
      });
      egress = { state: "on", port: handle.port };
    } catch (error) {
      egress = { state: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  }

  const buildDeps: ToolBuildDeps = {
    workspace: deps.workspace,
    profileDir: deps.profileDir,
    pluginsDir: path.join(deps.profileDir, "plugins"),
    backend: sandbox.backend,
    ...(deps.delegate !== undefined ? { delegate: deps.delegate } : {}),
    ...(deps.policy !== undefined ? { policy: deps.policy } : {}), // [S2]
    ...(sandbox.image !== undefined ? { dockerImage: sandbox.image } : {}),
    ...(handle !== undefined
      ? {
          egress: {
            // The bridge container reaches a host loopback listener only through the gateway alias.
            proxyUrl: sandbox.backend === "docker" ? `http://host.docker.internal:${handle.port}` : handle.url,
            token: handle.token,
            caCertPath: handle.caCertPath,
          },
          // `web` runs in this process, so it dials the loopback listener, not the bridge alias.
          egressHostUrl: handle.url,
        }
      : {}),
  };
  let build: TrentToolBuild;
  try {
    if (deps.buildTools) build = deps.buildTools(deps.config, buildDeps);
    // The legacy adapters-only seam reports nothing skipped and runs no hooks of its own.
    else if (deps.buildAdapters) build = { adapters: deps.buildAdapters(deps.config, buildDeps), skipped: [], hookNotices: [] };
    else build = buildTrentTools(deps.config, buildDeps);
  } catch (error) {
    await handle?.stop();
    throw error;
  }
  const { adapters, skipped } = build;

  let cleaned = false;
  return {
    adapters,
    toolsets,
    skipped,
    // A getter, not a copy: `buildTrentTools` fills this as calls are made, not as it returns.
    get hookNotices(): readonly string[] {
      return build.hookNotices;
    },
    ...(build.provenance === undefined ? {} : { provenance: build.provenance }), // [C2]
    sandbox,
    egress,
    cleanup: async () => {
      if (cleaned) return;
      cleaned = true;
      for (const adapter of adapters) {
        await adapter.cleanup().catch(() => undefined);
      }
      await handle?.stop().catch(() => undefined);
    },
  };
}

// ── the status line ─────────────────────────────────────────────────────────

function sandboxText(sandbox: ReplSandbox): string {
  if (sandbox.backend === "local") {
    return sandbox.note === "configured" ? "sandbox local" : `sandbox local (${sandbox.note ?? "docker unavailable"})`;
  }
  return `sandbox docker ${sandbox.image ?? ""}${sandbox.note === undefined ? "" : ` (${sandbox.note})`}`;
}

function egressText(egress: ReplEgressStatus): string {
  if (egress.state === "on") return `egress on :${egress.port ?? "?"}`;
  if (egress.state === "off") return "egress off (no network)";
  return `egress FAILED, tools have no network: ${egress.error ?? "unknown"}`;
}

/** One line under the banner: what the seats can touch, where it runs, and whether it can reach out. */
export function toolsStatusLine(wiring: Pick<ToolWiring, "toolsets" | "sandbox" | "egress"> & { skipped?: SkippedToolset[] }, theme: Theme): string {
  const skipped = wiring.skipped ?? [];
  const skippedNames = new Set(skipped.map((s) => s.toolset));
  const registered = wiring.toolsets.filter((t) => !skippedNames.has(t));
  const tools = registered.length === 0 ? "no toolsets" : `tools ${registered.join(", ")}`;
  const parts = [tools, sandboxText(wiring.sandbox), egressText(wiring.egress)];
  for (const s of skipped) parts.push(`skipped ${s.toolset} (${s.reason})`);
  const paint = wiring.egress.state === "failed" || skipped.length > 0 ? theme.needsApproval.bind(theme) : theme.meta.bind(theme);
  return paint(parts.join("    "));
}
