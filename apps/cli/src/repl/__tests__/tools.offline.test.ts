/**
 * [O-03] Offline, the REPL's host proxy starts with the loopback allowlist, not the configured one.
 *
 * `wireTools` starts the host `EgressProxy` whether or not offline mode is on. Handing it the full
 * `egress.intercept_domains` offline would let a host-side tool reach a cloud host through the
 * loopback listener; the proxy itself now refuses any non-loopback upstream offline (the chokepoint,
 * `egress/EgressProxy.offline.test.ts`), and this is the second layer: the allowlist it starts with.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import type { TrentConfig } from "@trent/core/config/index.js";
import { LOOPBACK_ALLOWLIST } from "@trent/core/egress/index.js";
import { wireTools, type EgressHandle, type StartEgressInput } from "../tools.js";

let profileDir = "";
let workspace = "";
let savedOffline: string | undefined;
beforeAll(() => {
  profileDir = mkdtempSync(path.join(os.tmpdir(), "trent-o03-profile-"));
  workspace = mkdtempSync(path.join(os.tmpdir(), "trent-o03-ws-"));
  savedOffline = process.env.TRENT_OFFLINE;
});
afterEach(() => {
  if (savedOffline === undefined) delete process.env.TRENT_OFFLINE;
  else process.env.TRENT_OFFLINE = savedOffline;
});
afterAll(() => {
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function localConfig(): TrentConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.terminal.backend = "local";
  config.egress.intercept_domains = ["api.openai.com", "api.anthropic.com"];
  return { ...config, provider: "ollama", toolsets: ["file_ops"] };
}

function recordingEgress(): { startEgress: (input: StartEgressInput) => Promise<EgressHandle>; seen: StartEgressInput[] } {
  const seen: StartEgressInput[] = [];
  const startEgress = async (input: StartEgressInput): Promise<EgressHandle> => {
    seen.push(input);
    return { port: 1, url: "http://127.0.0.1:1", token: "trnt_egress_fake", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined };
  };
  return { startEgress, seen };
}

describe("[O-03] wireTools hands the proxy an allowlist that matches the mode", () => {
  it("offline: wireTools hands the proxy the loopback allowlist, not the configured intercept_domains", async () => {
    process.env.TRENT_OFFLINE = "1";
    const egress = recordingEgress();
    const wiring = await wireTools({ config: localConfig(), workspace, profileDir, buildAdapters: () => [], startEgress: egress.startEgress });
    await wiring.cleanup();
    expect(egress.seen).toHaveLength(1);
    expect(egress.seen[0]?.interceptDomains).toEqual([...LOOPBACK_ALLOWLIST]);
  });

  it("online: wireTools hands the proxy the configured intercept_domains unchanged", async () => {
    delete process.env.TRENT_OFFLINE;
    const egress = recordingEgress();
    const wiring = await wireTools({ config: localConfig(), workspace, profileDir, buildAdapters: () => [], startEgress: egress.startEgress });
    await wiring.cleanup();
    expect(egress.seen[0]?.interceptDomains).toEqual(["api.openai.com", "api.anthropic.com"]);
  });
});
