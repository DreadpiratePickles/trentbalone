/**
 * Docker sandbox backend with a real container lifecycle.
 *
 * The previous version built `docker run --rm ... sh -c "<command>"` as a single string and handed
 * it to `child_process.exec`, so the host shell parsed the command, the working directory and every
 * environment value - a command-injection vector reachable by any agent-authored string. It also
 * set no network flags, so a sandbox could reach anything the host could.
 *
 * Every process here is spawned with `execFile` and an argument ARRAY. No host shell is ever
 * involved; the only shell that sees a command is `sh -c` inside the container, which receives it
 * as one opaque argv element.
 */
import { execFile } from "node:child_process";
import type { TerminalBackend, TerminalCommandOptions, TerminalExecutionResult } from "./types.js";
import {
  CONTAINER_CA_PATH,
  buildSandboxEnv,
  toDockerEnvArgs,
} from "../egress/SandboxEnvironment.js";

export interface DockerVolumeMount {
  hostPath: string;
  containerPath: string;
  readOnly?: boolean;
}

export interface DockerCreateOptions {
  containerName: string;
  image: string;
  /** Docker network. "none" is full isolation; a named bridge is used when egress is proxied. */
  network?: string;
  volumes?: DockerVolumeMount[];
  workdir?: string;
  env?: Record<string, string>;
  /** Host path of the egress CA certificate to mount read-only into the container. */
  caCertPath?: string;
  proxyUrl?: string;
  proxyToken?: string;
  credentialEnvNames?: string[];
  memory?: string;
  pidsLimit?: number;
  readOnlyRootfs?: boolean;
  /** Extra hosts as `name:ip`, e.g. host.docker.internal:host-gateway. */
  extraHosts?: string[];
}

export interface DockerBackendOptions extends Partial<DockerCreateOptions> {
  execTimeoutMs?: number;
}

const DEFAULT_IMAGE = "trent-sandbox:latest";
const DEFAULT_NETWORK = "none";
const DEFAULT_TIMEOUT_MS = 120_000;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the docker CLI. `args` is an array; nothing is ever concatenated into a shell string. */
function docker(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      args,
      { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === "number"
            ? ((error as unknown as { code: number }).code ?? 1)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    );
  });
}

/** Build the argv for `docker create`. Pure, so the isolation flags are unit-testable. */
export function buildCreateArgs(options: DockerCreateOptions): string[] {
  const args: string[] = ["create"];
  args.push("--name", options.containerName);
  args.push("--network", options.network ?? DEFAULT_NETWORK);
  args.push("--cap-drop=ALL");
  args.push("--security-opt=no-new-privileges");
  if (options.readOnlyRootfs) args.push("--read-only");
  if (options.memory) args.push("--memory", options.memory);
  if (options.pidsLimit) args.push("--pids-limit", String(options.pidsLimit));
  for (const host of options.extraHosts ?? []) args.push("--add-host", host);

  if (options.caCertPath) {
    args.push("-v", `${options.caCertPath}:${CONTAINER_CA_PATH}:ro`);
  }
  for (const volume of options.volumes ?? []) {
    args.push(
      "-v",
      `${volume.hostPath}:${volume.containerPath}${volume.readOnly ? ":ro" : ""}`
    );
  }
  if (options.workdir) args.push("-w", options.workdir);

  const env: Record<string, string> = { ...(options.env ?? {}) };
  if (options.proxyToken && options.proxyUrl) {
    Object.assign(
      env,
      buildSandboxEnv({
        token: options.proxyToken,
        proxyUrl: options.proxyUrl,
        caCertPath: CONTAINER_CA_PATH,
        credentialEnvNames: options.credentialEnvNames,
        base: options.env,
      })
    );
  } else if (options.caCertPath) {
    env.NODE_EXTRA_CA_CERTS = CONTAINER_CA_PATH;
    env.REQUESTS_CA_BUNDLE = CONTAINER_CA_PATH;
    env.SSL_CERT_FILE = CONTAINER_CA_PATH;
  }
  args.push(...toDockerEnvArgs(env));

  args.push(options.image);
  // Keep the container alive so exec has a lifecycle to attach to.
  args.push("sh", "-c", "while true; do sleep 3600; done");
  return args;
}

/** Build the argv for `docker exec`. The command stays one argv element. */
export function buildExecArgs(
  container: string,
  command: string,
  options: TerminalCommandOptions
): string[] {
  const args: string[] = ["exec"];
  if (options.cwd) args.push("-w", options.cwd);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    args.push("-e", `${key}=${value}`);
  }
  if (options.proxyToken) args.push("-e", `TRENT_PROXY_TOKEN=${options.proxyToken}`);
  args.push(container, "sh", "-c", command);
  return args;
}

export class DockerBackend implements TerminalBackend {
  public id = "docker";
  public name = "Docker Sandbox Backend";

  private readonly createOptions: DockerCreateOptions;
  private readonly execTimeoutMs: number;
  private containerId: string | null = null;
  private started = false;

  constructor(options?: DockerBackendOptions) {
    this.createOptions = {
      containerName: options?.containerName ?? `trent-sandbox-${Date.now()}-${process.pid}`,
      image: options?.image ?? DEFAULT_IMAGE,
      network: options?.network ?? DEFAULT_NETWORK,
      volumes: options?.volumes,
      workdir: options?.workdir,
      env: options?.env,
      caCertPath: options?.caCertPath,
      proxyUrl: options?.proxyUrl,
      proxyToken: options?.proxyToken,
      credentialEnvNames: options?.credentialEnvNames,
      memory: options?.memory,
      pidsLimit: options?.pidsLimit,
      readOnlyRootfs: options?.readOnlyRootfs,
      extraHosts: options?.extraHosts,
    };
    this.execTimeoutMs = options?.execTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  public getContainerName(): string {
    return this.createOptions.containerName;
  }

  public getCreateArgs(): string[] {
    return buildCreateArgs(this.createOptions);
  }

  public async isAvailable(): Promise<boolean> {
    const result = await docker(["info"], 5000);
    return result.code === 0;
  }

  public async containerExists(): Promise<boolean> {
    const result = await docker(
      ["ps", "-a", "--filter", `name=^${this.createOptions.containerName}$`, "--format", "{{.ID}}"],
      10_000
    );
    return result.code === 0 && result.stdout.trim().length > 0;
  }

  public async create(): Promise<string> {
    if (this.containerId) return this.containerId;
    const result = await docker(buildCreateArgs(this.createOptions), 120_000);
    if (result.code !== 0) {
      throw new Error(`docker create failed (${result.code}): ${result.stderr.trim()}`);
    }
    this.containerId = result.stdout.trim();
    return this.containerId;
  }

  public async start(): Promise<void> {
    if (this.started) return;
    const ref = this.containerId ?? (await this.create());
    const result = await docker(["start", ref], 60_000);
    if (result.code !== 0) {
      throw new Error(`docker start failed (${result.code}): ${result.stderr.trim()}`);
    }
    this.started = true;
  }

  public async exec(
    command: string,
    options?: TerminalCommandOptions
  ): Promise<TerminalExecutionResult> {
    const startTime = Date.now();
    if (!this.started) await this.start();
    const ref = this.containerId ?? this.createOptions.containerName;
    const result = await docker(
      buildExecArgs(ref, command, options ?? {}),
      options?.timeoutMs ?? this.execTimeoutMs
    );
    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Date.now() - startTime,
    };
  }

  public async stop(): Promise<void> {
    if (!this.containerId && !this.started) return;
    const ref = this.containerId ?? this.createOptions.containerName;
    await docker(["stop", "--time", "5", ref], 60_000);
    this.started = false;
  }

  public async remove(): Promise<void> {
    const ref = this.containerId ?? this.createOptions.containerName;
    await docker(["rm", "-f", ref], 60_000);
    this.containerId = null;
    this.started = false;
  }

  /** Convenience path used by the terminal facade: ensure a container, then exec. */
  public async execute(
    command: string,
    options?: TerminalCommandOptions
  ): Promise<TerminalExecutionResult> {
    const startTime = Date.now();
    if (!(await this.isAvailable())) {
      return {
        exitCode: 127,
        stdout: "",
        stderr:
          "Docker daemon is not running or the docker CLI is not installed. " +
          "Start Docker, or switch terminal.backend to 'local'.",
        durationMs: Date.now() - startTime,
      };
    }
    try {
      return await this.exec(command, options);
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  public async cleanup(): Promise<void> {
    if (!this.containerId && !this.started) return;
    await this.stop();
    await this.remove();
  }
}
