/**
 * [SEC-2 S2b-2 / gap 2, Fable change 5] Offline creates no egress container and no egress network.
 * A run that asks for network tooling gets an honest refusal instead of a firewall that could reach
 * nothing — and the network builder is never even called.
 */
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { createSandbox } from "./sandbox.js";
import type { ToolContext } from "./types.js";
import type { ensureEgressNetwork } from "../terminal/egress-network.js";

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

const saved = process.env.TRENT_OFFLINE;
beforeEach(() => {
  delete process.env.TRENT_OFFLINE;
});
afterEach(() => {
  if (saved === undefined) delete process.env.TRENT_OFFLINE;
  else process.env.TRENT_OFFLINE = saved;
});

describe("sandbox egress — offline mode", () => {
  it("refuses a network run and never builds the egress network", async () => {
    process.env.TRENT_OFFLINE = "1";
    let built = 0;
    const ensure = (async () => {
      built += 1;
      throw new Error("should not be called offline");
    }) as unknown as typeof ensureEgressNetwork;

    const sandbox = createSandbox(CTX, { ensureEgressNetwork: ensure });
    const result = await sandbox.run("curl https://example.com", { network: true });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("offline");
    expect(result.stderr.toLowerCase()).toContain("no egress container");
    expect(built).toBe(0);
    expect(sandbox.containerNames()).toEqual([]);
  });
});
