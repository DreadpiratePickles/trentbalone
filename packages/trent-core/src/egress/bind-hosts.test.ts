/**
 * Where the egress proxy listens. Loopback always; on Linux with the Docker backend also the
 * bridge gateway, because that is what `host.docker.internal:host-gateway` resolves to there.
 * Docker Desktop (macOS, Windows) forwards the alias to host loopback, so nothing more is bound.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_BRIDGE_GATEWAY, LOOPBACK, dockerBridgeGateway, egressBindHosts } from "./bind-hosts.js";

describe("egressBindHosts", () => {
  it("stays loopback-only on darwin and win32, even with the docker backend", async () => {
    const discover = async () => "172.17.0.1";
    expect(await egressBindHosts({ platform: "darwin", backend: "docker", discover })).toEqual([LOOPBACK]);
    expect(await egressBindHosts({ platform: "win32", backend: "docker", discover })).toEqual([LOOPBACK]);
  });

  it("stays loopback-only on linux with the local backend", async () => {
    expect(await egressBindHosts({ platform: "linux", backend: "local", discover: async () => "172.17.0.1" })).toEqual([LOOPBACK]);
  });

  it("adds the discovered bridge gateway on linux with the docker backend", async () => {
    expect(await egressBindHosts({ platform: "linux", backend: "docker", discover: async () => "10.99.0.1" })).toEqual([LOOPBACK, "10.99.0.1"]);
  });

  it("never yields a wildcard, whatever discovery returns", async () => {
    for (const bad of ["0.0.0.0", "::", "", "garbage"]) {
      expect(await egressBindHosts({ platform: "linux", backend: "docker", discover: async () => bad })).toEqual([LOOPBACK, DEFAULT_BRIDGE_GATEWAY]);
    }
  });

  it("dockerBridgeGateway reads `docker network inspect bridge` and falls back to 172.17.0.1", async () => {
    expect(await dockerBridgeGateway(async () => "172.18.0.1\n")).toBe("172.18.0.1");
    expect(await dockerBridgeGateway(async () => "")).toBe(DEFAULT_BRIDGE_GATEWAY);
    expect(await dockerBridgeGateway(async () => { throw new Error("no daemon"); })).toBe(DEFAULT_BRIDGE_GATEWAY);
    expect(DEFAULT_BRIDGE_GATEWAY).toBe("172.17.0.1");
  });
});
