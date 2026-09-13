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
import { DockerBackend } from "../terminal/DockerBackend.js";
import { LocalBackend } from "../terminal/LocalBackend.js";
import type { TerminalBackend, TerminalExecutionResult } from "../terminal/types.js";
import { spilloverDir } from "./spillover.js";
import type { ToolContext } from "./types.js";

export const WORKSPACE_MOUNT = "/workspace";
export const SPILLOVER_MOUNT = "/trent/spillover";
const DEFAULT_BRIDGE = "bridge";

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
  private readonly label = randomBytes(4).toString("hex");

  constructor(private readonly ctx: ToolContext) {
    this.roots = [
      [ctx.workspace, WORKSPACE_MOUNT],
      [spilloverDir(ctx.profileDir), SPILLOVER_MOUNT],
    ];
  }

  toSandboxPath(hostPath: string): string {
    return mapPath(hostPath, this.roots);
  }

  private backend(network: boolean): DockerBackend {
    if (!network) {
      this.isolated ??= this.create("none", false);
      return this.isolated;
    }
    this.egress ??= this.create(this.ctx.docker?.bridgeNetwork ?? DEFAULT_BRIDGE, true);
    return this.egress;
  }

  private create(network: string, withEgress: boolean): DockerBackend {
    // Docker creates a missing bind-mount source as a root-owned directory; make it ours first.
    mkdirSync(spilloverDir(this.ctx.profileDir), { recursive: true });
    const egress = withEgress ? this.ctx.egress : undefined;
    return new DockerBackend({
      containerName: `trent-seat-${withEgress ? "egress" : "isolated"}-${process.pid}-${this.label}`,
      image: this.ctx.docker?.image ?? "trent-sandbox:latest",
      network,
      workdir: WORKSPACE_MOUNT,
      volumes: [
        { hostPath: this.ctx.workspace, containerPath: WORKSPACE_MOUNT },
        { hostPath: spilloverDir(this.ctx.profileDir), containerPath: SPILLOVER_MOUNT, readOnly: true },
      ],
      pidsLimit: 256,
      ...(egress
        ? {
            caCertPath: egress.caCertPath,
            proxyUrl: egress.proxyUrl,
            proxyToken: egress.token,
            credentialEnvNames: [...(egress.credentialEnvNames ?? [])],
            extraHosts: ["host.docker.internal:host-gateway"],
          }
        : {}),
    });
  }

  async run(command: string, options?: SandboxRunOptions): Promise<TerminalExecutionResult> {
    const backend = this.backend(options?.network === true);
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
    await Promise.all([this.isolated?.cleanup(), this.egress?.cleanup()]);
    this.isolated = undefined;
    this.egress = undefined;
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

export function createSandbox(ctx: ToolContext): Sandbox {
  return ctx.backend === "docker" ? new DockerSandbox(ctx) : new LocalSandbox(ctx);
}

/** POSIX single-quote escaping: the only way a path or literal enters a `sh -c` string. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
