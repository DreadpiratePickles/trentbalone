/**
 * [SEC-1 / T-01] The egress sandbox is L3-firewalled.
 *
 * Before this wave the egress container ran on the default `bridge` with
 * `--add-host host.docker.internal:host-gateway`, so the allowlist only bound clients that honour
 * HTTPS_PROXY — `curl --noproxy '*' https://<ip>` or a raw socket reached any host. The spike
 * (`02_plan/output/security-egress-firewall-spike-2026-09-26.md`) measured the fix on this Docker
 * Desktop host: a per-seat `--internal` network plus a dual-homed forwarder sidecar, so the egress
 * sandbox's ONLY reachable L3 destination is the forwarder, which relays one port to the host proxy.
 *
 * These are hermetic unit tests over the argv builders and an injected fake docker runner — the
 * live topology assertion lives (gated) in `tools/terminal/terminal.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { buildCreateArgs } from "../terminal/DockerBackend.js";
import {
  ensureEgressNetwork,
  buildForwarderCreateArgs,
  egressNetworkName,
  egressForwarderName,
  FORWARDER_RELAY_PY,
  type DockerRunner,
} from "../terminal/egress-network.js";
import { createSandbox, sandboxDockerOptions, proxyPortFromUrl } from "./sandbox.js";
import type { ToolContext } from "./types.js";

const CTX: ToolContext = {
  workspace: "/repo",
  profileDir: "/profile",
  backend: "docker",
  docker: { image: "trent-sandbox:1" },
  egress: {
    proxyUrl: "http://host.docker.internal:8089",
    token: "trnt_egress_" + "a".repeat(32),
    caCertPath: "/host/ca.crt",
    credentialEnvNames: ["OPENAI_API_KEY"],
  },
};

describe("sandboxDockerOptions — egress backend joins the internal net, points at the forwarder", () => {
  it("emits --network <internal net> and --add-host host.docker.internal:<forwarder ip>, never host-gateway", () => {
    const opts = sandboxDockerOptions(CTX, "trent-seat-egress-1-abcd", {
      network: "trent-egress-abcd",
      egressWiring: { networkName: "trent-egress-abcd", forwarderIp: "172.22.0.3" },
    });
    const args = buildCreateArgs(opts);

    // Joins the per-seat internal network, NOT the default bridge.
    expect(args[args.indexOf("--network") + 1]).toBe("trent-egress-abcd");
    expect(args).not.toContain("bridge");

    // host.docker.internal repointed at the forwarder's internal IP — no broad host-gateway route.
    expect(args).toContain("--add-host");
    expect(args).toContain("host.docker.internal:172.22.0.3");
    expect(args.join(" ")).not.toContain("host-gateway");

    // Egress plumbing is intact: proxy env + CA + token, and the strong flags are not weakened.
    expect(args).toContain("HTTPS_PROXY=http://host.docker.internal:8089");
    expect(args).toContain(`OPENAI_API_KEY=trnt_egress_${"a".repeat(32)}`);
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args[args.indexOf("--pids-limit") + 1]).toBe("256");
    // [SEC-3 T-10] a memory ceiling so a runaway process cannot OOM the host.
    expect(args).toContain("--memory");
    expect(args[args.indexOf("--memory") + 1]).toMatch(/^\d+(?:[bkmg])?$/i);
  });

  it("the isolated backend stays --network none with no proxy env and no extra host", () => {
    const args = buildCreateArgs(sandboxDockerOptions(CTX, "trent-seat-isolated-1-abcd", { network: "none" }));
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args.join(" ")).not.toContain("host.docker.internal");
    expect(args.some((a) => a.startsWith("HTTPS_PROXY="))).toBe(false);
    expect(args).toContain("--cap-drop=ALL");
  });
});

describe("proxyPortFromUrl", () => {
  it("reads the port the sandbox reaches the proxy on", () => {
    expect(proxyPortFromUrl("http://host.docker.internal:8089")).toBe(8089);
    expect(proxyPortFromUrl("http://host.docker.internal:4321")).toBe(4321);
  });
});

describe("buildForwarderCreateArgs — the dual-homed sidecar", () => {
  it("runs the pinned relay image with host-gateway, cap-drop ALL and no-new-privileges", () => {
    const args = buildForwarderCreateArgs({
      name: "trent-fwd-abcd",
      network: "trent-egress-abcd",
      image: "trent-sandbox:1",
      proxyPort: 8089,
    });
    expect(args[0]).toBe("create");
    expect(args[args.indexOf("--network") + 1]).toBe("trent-egress-abcd");
    // The forwarder — not the sandbox — is the one that carries the host-gateway route to the proxy.
    expect(args).toContain("host.docker.internal:host-gateway");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    // The relay listens on and relays the proxy port to the host proxy.
    expect(args).toContain("TRENT_FWD_PORT=8089");
    expect(args).toContain("TRENT_FWD_TARGET_PORT=8089");
    expect(args).toContain("TRENT_FWD_TARGET_HOST=host.docker.internal");
    // Ends with the relay command; the image is right before it.
    expect(args[args.indexOf("trent-sandbox:1") + 1]).toBe("python3");
    expect(args).toContain("-c");
    expect(args).toContain(FORWARDER_RELAY_PY);
  });
});

/** A fake docker CLI that records every call and answers from a scripted table. */
function fakeDocker(script: (args: string[]) => { code: number; stdout?: string; stderr?: string }): {
  runner: DockerRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: DockerRunner = async (args) => {
    calls.push(args);
    const r = script(args);
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { runner, calls };
}

describe("ensureEgressNetwork — builds the topology and fails closed", () => {
  const base = { label: "abcd", image: "trent-sandbox:1", proxyPort: 8089 };

  it("creates the internal network + forwarder, connects the bridge, and returns the forwarder IP", async () => {
    const { runner, calls } = fakeDocker((args) => {
      if (args[0] === "inspect") return { code: 0, stdout: "172.22.0.7\n" };
      return { code: 0, stdout: "" };
    });
    const net = await ensureEgressNetwork({ ...base, docker: runner });
    expect(net.networkName).toBe(egressNetworkName("abcd"));
    expect(net.forwarderName).toBe(egressForwarderName("abcd"));
    expect(net.forwarderInternalIp).toBe("172.22.0.7");

    // Internal network first, forwarder created + bridge-connected + started, then IP inspected.
    expect(`${calls[0]?.[0]} ${calls[0]?.[1]}`).toBe("network create");
    expect(calls[0]).toContain("--internal");
    expect(calls[0]).toContain(egressNetworkName("abcd"));
    expect(calls.some((c) => c[0] === "create")).toBe(true);
    const connect = calls.find((c) => c[0] === "network" && c[1] === "connect");
    expect(connect).toBeDefined();
    expect(connect).toContain("bridge");
    expect(calls.some((c) => c[0] === "start")).toBe(true);
    expect(calls.some((c) => c[0] === "inspect")).toBe(true);
  });

  it("throws and creates NO forwarder when the internal network cannot be created", async () => {
    const { runner, calls } = fakeDocker((args) =>
      args[0] === "network" && args[1] === "create" ? { code: 1, stderr: "network create boom" } : { code: 0 },
    );
    await expect(ensureEgressNetwork({ ...base, docker: runner })).rejects.toThrow(/network|firewall/i);
    // Fail closed: no forwarder container was ever created.
    expect(calls.some((c) => c[0] === "create")).toBe(false);
  });

  it("tears the network down and throws when the forwarder cannot be created", async () => {
    const { runner, calls } = fakeDocker((args) =>
      args[0] === "create" ? { code: 1, stderr: "no image" } : { code: 0 },
    );
    await expect(ensureEgressNetwork({ ...base, docker: runner })).rejects.toThrow();
    // The half-built network is removed, not left dangling.
    expect(calls.some((c) => c[0] === "network" && c[1] === "rm")).toBe(true);
  });

  it("throws when the forwarder has no internal IP (nothing to point the sandbox at)", async () => {
    const { runner } = fakeDocker((args) => (args[0] === "inspect" ? { code: 0, stdout: "\n" } : { code: 0 }));
    await expect(ensureEgressNetwork({ ...base, docker: runner })).rejects.toThrow();
  });
});

describe("DockerSandbox.run — fail closed, never a silent bridge fallback", () => {
  it("surfaces a clear reason and creates no egress container when the firewall cannot be built", async () => {
    const sandbox = createSandbox(CTX, {
      ensureEgressNetwork: async () => {
        throw new Error("network create boom");
      },
    });
    const res = await sandbox.run("curl https://example.com", { network: true });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/egress firewall unavailable/i);
    // No egress container was created — there is no fallback onto the default bridge.
    expect(sandbox.containerNames().some((n) => n.includes("egress"))).toBe(false);
    await sandbox.cleanup();
  });
});
