/**
 * Where the egress proxy listens.
 *
 * Loopback always. On Linux with the Docker backend, also the bridge gateway: that is what
 * `--add-host host.docker.internal:host-gateway` resolves to there, and a loopback-only proxy is
 * unreachable from a container (curl: (7) on ubuntu-latest, run 34767631807). Docker Desktop on
 * macOS and Windows forwards the alias to host loopback through its VM, so nothing more is bound.
 * Never a wildcard: `EgressProxy` refuses one, and this module never produces one.
 */
import { execFile } from "node:child_process";

export const LOOPBACK = "127.0.0.1";
/** Docker's default bridge gateway, used when `docker network inspect` cannot answer. */
export const DEFAULT_BRIDGE_GATEWAY = "172.17.0.1";

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isSpecificIpv4(value: string): boolean {
  const m = IPV4.exec(value);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) && octets[0] !== 0;
}

function dockerNetworkInspectBridge(): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      "docker",
      ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"],
      { timeout: 8_000 },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout ?? ""))),
    ),
  );
}

/** The bridge gateway as Docker reports it, or the default when the daemon does not answer. */
export async function dockerBridgeGateway(inspect: () => Promise<string> = dockerNetworkInspectBridge): Promise<string> {
  try {
    const gateway = (await inspect()).trim();
    return isSpecificIpv4(gateway) ? gateway : DEFAULT_BRIDGE_GATEWAY;
  } catch {
    return DEFAULT_BRIDGE_GATEWAY;
  }
}

export interface BindHostsInput {
  readonly backend: "docker" | "local";
  readonly platform?: NodeJS.Platform;
  /** Bridge gateway discovery; defaults to `docker network inspect bridge`. */
  readonly discover?: () => Promise<string>;
}

/** Loopback, plus the bridge gateway only on Linux with the Docker backend. */
export async function egressBindHosts(input: BindHostsInput): Promise<string[]> {
  const platform = input.platform ?? process.platform;
  if (platform !== "linux" || input.backend !== "docker") return [LOOPBACK];
  const gateway = await dockerBridgeGateway(input.discover);
  return gateway === LOOPBACK ? [LOOPBACK] : [LOOPBACK, gateway];
}
