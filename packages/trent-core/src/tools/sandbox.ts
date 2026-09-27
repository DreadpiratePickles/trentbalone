/**
 * The sandbox every toolset runs in — Hermes's pattern, where file tools are shell commands on
 * the same environment as `terminal` (`file_tools.py:251-355`).
 *
 * Docker: the workspace is bind-mounted at `/workspace`; `cap-drop ALL`, `no-new-privileges`
 * (`DockerBackend.buildCreateArgs`) and `--network none`. A SECOND container on the bridge
 * network exists only for commands that need egress; it carries the proxy env and CA so every
 * HTTPS call goes through `EgressProxy`, which refuses off-allowlist hosts at CONNECT.
 * Local: `LocalBackend` with a scrubbed environment, confined to the workspace by the callers.
 */
import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DockerBackend, type DockerCreateOptions } from "../terminal/DockerBackend.js";
import { LocalBackend } from "../terminal/LocalBackend.js";
import { SANDBOX_IMAGE } from "../terminal/sandbox-image.js";
import { ensureEgressNetwork, type EgressNetwork } from "../terminal/egress-network.js";
import { isOffline } from "../egress/offline.js";
import type { TerminalBackend, TerminalExecutionResult } from "../terminal/types.js";
import { spilloverDir } from "./spillover.js";
import type { ToolContext } from "./types.js";

export const WORKSPACE_MOUNT = "/workspace";
export const SPILLOVER_MOUNT = "/trent/spillover";
const DEFAULT_PROXY_PORT = 8089;
// [SEC-3 T-10] Default memory ceiling for a seat container. Generous enough for normal build/test
// work, bounded so an agent-run process cannot exhaust the host's RAM. `--pids-limit` capped process
// count but not memory.
const DEFAULT_SANDBOX_MEMORY = "2g";

/** The proxy port the sandbox reaches the proxy on, from `egress.proxyUrl`. */
export function proxyPortFromUrl(proxyUrl: string): number {
  try {
    const port = Number(new URL(proxyUrl).port);
    return Number.isInteger(port) && port > 0 ? port : DEFAULT_PROXY_PORT;
  } catch {
    return DEFAULT_PROXY_PORT;
  }
}

/** The forwarder's address inside the egress sandbox: `host.docker.internal` is repointed here. */
export interface EgressWiring {
  readonly networkName: string;
  readonly forwarderIp: string;
}

/**
 * The `docker create` options for one sandbox container. Pure, so the isolation flags and the
 * egress-firewall wiring (`--network <internal net>`, `--add-host host.docker.internal:<forwarder>`,
 * never `host-gateway`) are unit-testable.
 */
export function sandboxDockerOptions(
  ctx: ToolContext,
  containerName: string,
  opts: { network: string; egressWiring?: EgressWiring },
): DockerCreateOptions {
  const egress = opts.egressWiring !== undefined ? ctx.egress : undefined;
  return {
    containerName,
    image: ctx.docker?.image ?? SANDBOX_IMAGE,
    network: opts.network,
    workdir: WORKSPACE_MOUNT,
    volumes: [
      { hostPath: ctx.workspace, containerPath: WORKSPACE_MOUNT },
      { hostPath: spilloverDir(ctx.profileDir), containerPath: SPILLOVER_MOUNT, readOnly: true },
    ],
    pidsLimit: 256,
    memory: DEFAULT_SANDBOX_MEMORY, // [SEC-3 T-10] a host-OOM ceiling; --pids-limit alone left memory unbounded

    ...(egress
      ? {
          caCertPath: egress.caCertPath,
          proxyUrl: egress.proxyUrl,
          proxyToken: egress.token,
          credentialEnvNames: [...(egress.credentialEnvNames ?? [])],
          // host.docker.internal points at the forwarder's internal IP — the ONLY reachable L3
          // destination on the `--internal` network. Never `host-gateway`, which would re-open a
          // broad route to the host and defeat the firewall.
          extraHosts: [`host.docker.internal:${opts.egressWiring!.forwarderIp}`],
        }
      : {}),
  };
}

/** Injectable seams for `DockerSandbox`, so the egress-firewall path is testable without a daemon. */
export interface SandboxDeps {
  readonly ensureEgressNetwork?: typeof ensureEgressNetwork;
}

export interface SandboxRunOptions {
  /** Working directory as the sandbox sees it. Defaults to the workspace root. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /** Run in the egress-capable sandbox (Docker: the bridge container behind the proxy). */
  readonly network?: boolean;
}

export interface Sandbox {
  readonly kind: "docker" | "local";
  /** The workspace root as the sandbox sees it. */
  readonly workspaceRoot: string;
  /** Translates an absolute host path under the workspace (or the spillover dir) to a sandbox path. */
  toSandboxPath(hostPath: string): string;
  run(command: string, options?: SandboxRunOptions): Promise<TerminalExecutionResult>;
  /** Docker container names, for `docker inspect` in tests; empty for local. */
  containerNames(): string[];
  cleanup(): Promise<void>;
}

function mapPath(hostPath: string, roots: ReadonlyArray<readonly [string, string]>): string {
  for (const [hostRoot, sandboxRoot] of roots) {
    if (hostPath === hostRoot) return sandboxRoot;
    if (hostPath.startsWith(`${hostRoot}${path.sep}`)) {
      return `${sandboxRoot}/${path.relative(hostRoot, hostPath).split(path.sep).join("/")}`;
    }
  }
  throw new Error(`path is outside every sandbox mount: ${hostPath}`);
}

class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;
  readonly workspaceRoot = WORKSPACE_MOUNT;
  private readonly roots: ReadonlyArray<readonly [string, string]>;
  private isolated: DockerBackend | undefined;
  private egress: DockerBackend | undefined;
  private egressNetwork: EgressNetwork | undefined;
  private readonly label = randomBytes(4).toString("hex");
  private readonly ensureNetwork: typeof ensureEgressNetwork;

  constructor(
    private readonly ctx: ToolContext,
    deps: SandboxDeps = {},
  ) {
    this.ensureNetwork = deps.ensureEgressNetwork ?? ensureEgressNetwork;
    this.roots = [
      [ctx.workspace, WORKSPACE_MOUNT],
      [spilloverDir(ctx.profileDir), SPILLOVER_MOUNT],
    ];
  }

  toSandboxPath(hostPath: string): string {
    return mapPath(hostPath, this.roots);
  }

  private makeBackend(name: string, network: string, egressWiring?: EgressWiring): DockerBackend {
    // Docker creates a missing bind-mount source as a root-owned directory; make it ours first.
    mkdirSync(spilloverDir(this.ctx.profileDir), { recursive: true });
    return new DockerBackend(
      sandboxDockerOptions(this.ctx, name, egressWiring ? { network, egressWiring } : { network }),
    );
  }

  private seatName(role: "egress" | "isolated"): string {
    return `trent-seat-${role}-${process.pid}-${this.label}`;
  }

  private isolatedBackend(): DockerBackend {
    // The isolated sandbox is unchanged: full L3 isolation, `--network none`, no egress plumbing.
    this.isolated ??= this.makeBackend(this.seatName("isolated"), "none");
    return this.isolated;
  }

  /**
   * The egress sandbox, built behind the L3 firewall: a per-seat `--internal` network plus a
   * forwarder sidecar. FAIL CLOSED — if the firewall cannot be built the error propagates and no
   * egress container is created; there is never a silent fallback to the default bridge.
   */
  private async ensureEgressBackend(): Promise<DockerBackend> {
    if (this.egress) return this.egress;
    if (!this.ctx.egress) {
      throw new Error("egress firewall unavailable: no egress proxy is configured for this sandbox");
    }
    const net = await this.ensureNetwork({
      label: this.label,
      // The forwarder always runs the pinned sandbox image, never `ctx.docker.image`: the relay
      // needs python3, which the sandbox image carries and an arbitrary configured image may not.
      image: SANDBOX_IMAGE,
      proxyPort: proxyPortFromUrl(this.ctx.egress.proxyUrl),
    });
    this.egressNetwork = net;
    this.egress = this.makeBackend(this.seatName("egress"), net.networkName, {
      networkName: net.networkName,
      forwarderIp: net.forwarderInternalIp,
    });
    return this.egress;
  }

  async run(command: string, options?: SandboxRunOptions): Promise<TerminalExecutionResult> {
    let backend: DockerBackend;
    if (options?.network === true) {
      // [SEC-2 S2b-2 / gap 2, Fable change 5] Offline creates NO egress container and NO egress
      // network: there is no allowlisted non-loopback host to reach, so the network-backed path is
      // skipped with an honest reason rather than standing up a firewall that can reach nothing.
      if (isOffline()) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "offline mode: no egress container is created (there is no allowlisted non-loopback host to reach). Run without offline mode for network tooling.",
          durationMs: 0,
        };
      }
      try {
        backend = await this.ensureEgressBackend();
      } catch (error) {
        // Fail closed: no egress container, and a clear reason — not today's proxy-honour-only bridge.
        const reason = error instanceof Error ? error.message : String(error);
        const stderr = /egress firewall unavailable/i.test(reason)
          ? reason
          : `egress firewall unavailable: ${reason}`;
        return { exitCode: 1, stdout: "", stderr, durationMs: 0 };
      }
    } else {
      backend = this.isolatedBackend();
    }
    try {
      return await backend.exec(command, { cwd: options?.cwd ?? WORKSPACE_MOUNT, timeoutMs: options?.timeoutMs });
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error), durationMs: 0 };
    }
  }

  containerNames(): string[] {
    return [this.isolated, this.egress].filter((b): b is DockerBackend => b !== undefined).map((b) => b.getContainerName());
  }

  async cleanup(): Promise<void> {
    // Remove the seat containers first (they are attached to the internal network), then the
    // forwarder and the per-seat network the firewall created.
    await Promise.all([this.isolated?.cleanup(), this.egress?.cleanup()]);
    await this.egressNetwork?.cleanup();
    this.isolated = undefined;
    this.egress = undefined;
    this.egressNetwork = undefined;
  }
}

class LocalSandbox implements Sandbox {
  readonly kind = "local" as const;
  readonly workspaceRoot: string;
  private readonly backend: TerminalBackend = new LocalBackend();

  constructor(private readonly ctx: ToolContext) {
    this.workspaceRoot = ctx.workspace;
  }

  toSandboxPath(hostPath: string): string {
    return mapPath(hostPath, [
      [this.ctx.workspace, this.ctx.workspace],
      [spilloverDir(this.ctx.profileDir), spilloverDir(this.ctx.profileDir)],
    ]);
  }

  run(command: string, options?: SandboxRunOptions): Promise<TerminalExecutionResult> {
    return this.backend.execute(command, { cwd: options?.cwd ?? this.ctx.workspace, timeoutMs: options?.timeoutMs });
  }

  containerNames(): string[] {
    return [];
  }

  async cleanup(): Promise<void> {
    /* nothing persistent */
  }
}

export function createSandbox(ctx: ToolContext, deps: SandboxDeps = {}): Sandbox {
  return ctx.backend === "docker" ? new DockerSandbox(ctx, deps) : new LocalSandbox(ctx);
}

/** POSIX single-quote escaping: the only way a path or literal enters a `sh -c` string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
