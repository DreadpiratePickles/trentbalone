/**
 * [SEC-1 / T-01] The egress-firewall topology: a per-seat `--internal` Docker network plus a
 * minimal dual-homed forwarder sidecar.
 *
 * Why this exists (measured in `02_plan/output/security-egress-firewall-spike-2026-09-26.md`):
 * before this wave the egress container ran on the default `bridge` with
 * `--add-host host.docker.internal:host-gateway`, so the allowlist only bound clients that honour
 * `HTTPS_PROXY`. A `curl --noproxy '*' https://<ip>` or a raw socket reached any host, which
 * contradicted docs' "cannot reach a host nobody allowlisted".
 *
 * The fix is pure network topology, needing no in-container capabilities (the sandbox keeps
 * `--cap-drop=ALL`): the egress sandbox joins ONLY a per-seat `--internal` network, whose only
 * routable peer is a forwarder container. The forwarder straddles that internal network and the
 * default bridge and relays exactly one TCP port to the host proxy. On Docker Desktop `--internal`
 * alone makes `host.docker.internal` (192.168.65.254) unroutable — that is precisely why the
 * forwarder exists. The sandbox's `--add-host host.docker.internal:<forwarder internal ip>` points
 * the alias at the forwarder; the host proxy bind logic is unchanged. `--internal` also blocks
 * DNS-over-UDP to external names (upstream resolver unroutable ⇒ SERVFAIL), a property this keeps by
 * adding no resolver.
 *
 * The relay is a tiny Python TCP forwarder baked into the pinned sandbox image (`SANDBOX_IMAGE`,
 * alpine + python3), so no extra image is pulled — important for offline mode, where SEC-2 skips the
 * egress container entirely anyway. It inherits the same `--cap-drop=ALL` / `no-new-privileges`
 * posture as every other sandbox container.
 *
 * FAIL CLOSED: if the network or the forwarder cannot be built, or the forwarder has no internal
 * IP, this throws. The caller must then create NO egress container — never a silent fallback to the
 * old bridge.
 */
import { execFile } from "node:child_process";

export interface DockerResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The docker CLI, injected so the topology is unit-testable without a daemon. */
export type DockerRunner = (args: string[], timeoutMs?: number) => Promise<DockerResult>;

const DEFAULT_TIMEOUT_MS = 60_000;
/** The routable network the forwarder uses to reach the host proxy (bridge gateway / Desktop VM). */
export const FORWARDER_ROUTABLE_NETWORK = "bridge";

/**
 * A bidirectional TCP relay: accept on `TRENT_FWD_PORT`, dial
 * `TRENT_FWD_TARGET_HOST:TRENT_FWD_TARGET_PORT` (the host proxy, reached over the bridge leg), and
 * pump bytes both ways. It is protocol-blind, so the proxy's HTTP `CONNECT` tunnels pass through
 * untouched. Kept deliberately tiny and dependency-free (python3 stdlib, present in the sandbox
 * image); runs fine under `--cap-drop=ALL` because it binds an unprivileged high port.
 */
export const FORWARDER_RELAY_PY = [
  "import socket, threading, os",
  'LP = int(os.environ.get("TRENT_FWD_PORT", "8089"))',
  'TH = os.environ.get("TRENT_FWD_TARGET_HOST", "host.docker.internal")',
  'TP = int(os.environ.get("TRENT_FWD_TARGET_PORT", str(LP)))',
  "def pipe(a, b):",
  "    try:",
  "        while True:",
  "            data = a.recv(65536)",
  "            if not data: break",
  "            b.sendall(data)",
  "    except OSError: pass",
  "    finally:",
  "        try: b.shutdown(socket.SHUT_WR)",
  "        except OSError: pass",
  "def handle(client):",
  "    try: up = socket.create_connection((TH, TP))",
  "    except OSError: client.close(); return",
  "    threading.Thread(target=pipe, args=(client, up), daemon=True).start()",
  "    threading.Thread(target=pipe, args=(up, client), daemon=True).start()",
  "srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
  "srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
  'srv.bind(("0.0.0.0", LP)); srv.listen(128)',
  "while True:",
  "    c, _ = srv.accept(); handle(c)",
].join("\n");

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
function isIpv4(value: string): boolean {
  const m = IPV4.exec(value.trim());
  return m !== null && m.slice(1).map(Number).every((o) => o <= 255);
}

export function egressNetworkName(label: string): string {
  return `trent-egress-${label}`;
}

export function egressForwarderName(label: string): string {
  return `trent-fwd-${label}`;
}

function defaultDocker(args: string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<DockerResult> {
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
      },
    );
  });
}

export interface ForwarderCreateInput {
  readonly name: string;
  /** The per-seat internal network the forwarder listens on. */
  readonly network: string;
  /** The pinned relay image (must carry python3); defaults to the sandbox image at the call site. */
  readonly image: string;
  /** The port the sandbox reaches the proxy on; the relay both listens on and targets it. */
  readonly proxyPort: number;
}

/**
 * `docker create` argv for the forwarder sidecar. Pure, so the isolation flags and the relay wiring
 * are unit-testable. The forwarder — not the sandbox — carries `host.docker.internal:host-gateway`,
 * the route to the host proxy over its bridge leg (added by `network connect bridge`).
 */
export function buildForwarderCreateArgs(input: ForwarderCreateInput): string[] {
  return [
    "create",
    "--name",
    input.name,
    "--network",
    input.network,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--pids-limit",
    "64",
    "--add-host",
    "host.docker.internal:host-gateway",
    "-e",
    `TRENT_FWD_PORT=${input.proxyPort}`,
    "-e",
    "TRENT_FWD_TARGET_HOST=host.docker.internal",
    "-e",
    `TRENT_FWD_TARGET_PORT=${input.proxyPort}`,
    input.image,
    "python3",
    "-c",
    FORWARDER_RELAY_PY,
  ];
}

export interface EnsureEgressNetworkInput {
  /** The sandbox label (`DockerSandbox.label`), so the network + forwarder are per-seat. */
  readonly label: string;
  /** The pinned relay image (the sandbox image, which carries python3). */
  readonly image: string;
  /** The port the sandbox reaches the proxy on. */
  readonly proxyPort: number;
  readonly docker?: DockerRunner;
  readonly timeoutMs?: number;
}

export interface EgressNetwork {
  readonly networkName: string;
  readonly forwarderName: string;
  /** The forwarder's IP on the internal network; the sandbox's `host.docker.internal` points here. */
  readonly forwarderInternalIp: string;
  cleanup(): Promise<void>;
}

/**
 * Build the per-seat egress firewall: an `--internal` network and a dual-homed forwarder, returning
 * the forwarder's internal address. Fails closed — any failed step throws (after removing whatever
 * it had built), and the caller must create no egress container.
 */
export async function ensureEgressNetwork(input: EnsureEgressNetworkInput): Promise<EgressNetwork> {
  const docker = input.docker ?? defaultDocker;
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const networkName = egressNetworkName(input.label);
  const forwarderName = egressForwarderName(input.label);

  const removeForwarder = () => docker(["rm", "-f", forwarderName], timeout).catch(() => undefined);
  const removeNetwork = () => docker(["network", "rm", networkName], timeout).catch(() => undefined);

  const fail = async (message: string, cleanup: Array<() => Promise<unknown>>): Promise<never> => {
    for (const step of cleanup) await step();
    throw new Error(`egress firewall unavailable: ${message}`);
  };

  // 1. Per-seat internal network — its own subnet (no cross-seat lateral movement) and no external route.
  const net = await docker(["network", "create", "--internal", networkName], timeout);
  if (net.code !== 0) {
    return fail(`could not create the internal network ${networkName}: ${net.stderr.trim()}`, []);
  }

  // 2. Forwarder sidecar on the internal network, carrying the host-gateway route to the host proxy.
  const created = await docker(
    buildForwarderCreateArgs({ name: forwarderName, network: networkName, image: input.image, proxyPort: input.proxyPort }),
    timeout,
  );
  if (created.code !== 0) {
    return fail(`could not create the forwarder sidecar: ${created.stderr.trim()}`, [removeNetwork]);
  }

  // 3. Give the forwarder its bridge leg (the only route to the host proxy) and start it.
  const connected = await docker(["network", "connect", FORWARDER_ROUTABLE_NETWORK, forwarderName], timeout);
  if (connected.code !== 0) {
    return fail(`could not connect the forwarder to ${FORWARDER_ROUTABLE_NETWORK}: ${connected.stderr.trim()}`, [
      removeForwarder,
      removeNetwork,
    ]);
  }
  const started = await docker(["start", forwarderName], timeout);
  if (started.code !== 0) {
    return fail(`could not start the forwarder: ${started.stderr.trim()}`, [removeForwarder, removeNetwork]);
  }

  // 4. Read the forwarder's internal IP; the sandbox's `--add-host` points its host.docker.internal here.
  const inspected = await docker(
    ["inspect", forwarderName, "--format", `{{(index .NetworkSettings.Networks "${networkName}").IPAddress}}`],
    timeout,
  );
  const forwarderInternalIp = inspected.stdout.trim();
  if (inspected.code !== 0 || !isIpv4(forwarderInternalIp)) {
    return fail(`the forwarder has no internal IP on ${networkName}: ${inspected.stderr.trim() || forwarderInternalIp || "(empty)"}`, [
      removeForwarder,
      removeNetwork,
    ]);
  }

  return {
    networkName,
    forwarderName,
    forwarderInternalIp,
    async cleanup() {
      await removeForwarder();
      await removeNetwork();
    },
  };
}
