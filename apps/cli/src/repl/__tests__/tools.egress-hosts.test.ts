/**
 * [egress host binding] The REPL's broker token is minted bound to the configured provider's host.
 *
 * `wireTools` hands the proxy the provider key (`providerCredentials`) and, with it, the host that
 * key belongs to (`credentialHostsForProvider`, from the same endpoint table the doctor uses), and
 * `startEgressProxy` mints the token with that binding. Without it the broker would write the key
 * onto every allowlisted host the sandbox reaches with the token, or (fail closed) onto none.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import type { TrentConfig } from "@trent/core/config/index.js";
import { TokenManager } from "@trent/core/egress/index.js";
import { startEgressProxy, wireTools, type EgressHandle, type StartEgressInput } from "../tools.js";

const FAKE_GEMINI_KEY = "fake-gemini-key-for-host-binding-test";
const ENV_NAMES = ["GEMINI_API_KEY", "GOOGLE_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL"] as const;

let profileDir = "";
let workspace = "";
const savedEnv = new Map<string, string | undefined>();
beforeAll(() => {
  profileDir = mkdtempSync(path.join(os.tmpdir(), "trent-hb-profile-"));
  workspace = mkdtempSync(path.join(os.tmpdir(), "trent-hb-ws-"));
  for (const name of ENV_NAMES) savedEnv.set(name, process.env[name]);
});
afterEach(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
afterAll(() => {
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function localConfig(patch: Partial<TrentConfig>): TrentConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.terminal.backend = "local";
  return { ...config, toolsets: ["file_ops"], ...patch };
}

function recordingEgress(): { startEgress: (input: StartEgressInput) => Promise<EgressHandle>; seen: StartEgressInput[] } {
  const seen: StartEgressInput[] = [];
  const startEgress = async (input: StartEgressInput): Promise<EgressHandle> => {
    seen.push(input);
    return { port: 1, url: "http://127.0.0.1:1", token: "trnt_egress_fake", caCertPath: "/dev/null", isListening: () => true, stop: async () => undefined };
  };
  return { startEgress, seen };
}

describe("the REPL's broker token is bound to the provider's host", () => {
  it("wireTools passes the configured provider's key together with the host it belongs to", async () => {
    process.env.GEMINI_API_KEY = FAKE_GEMINI_KEY;
    delete process.env.GOOGLE_BASE_URL;
    const egress = recordingEgress();
    const wiring = await wireTools({ config: localConfig({ provider: "google" }), workspace, profileDir, buildAdapters: () => [], startEgress: egress.startEgress });
    await wiring.cleanup();
    expect(egress.seen[0]?.credentials).toEqual({ apiKey: FAKE_GEMINI_KEY });
    expect(egress.seen[0]?.credentialHosts).toEqual(["generativelanguage.googleapis.com"]);
  });

  it("follows an OpenAI-compatible base URL, port included, when the operator moved it", async () => {
    process.env.OPENAI_API_KEY = "fake-openai-key-for-host-binding-test";
    process.env.OPENAI_BASE_URL = "http://127.0.0.1:8000/v1";
    const egress = recordingEgress();
    const wiring = await wireTools({ config: localConfig({ provider: "openai" }), workspace, profileDir, buildAdapters: () => [], startEgress: egress.startEgress });
    await wiring.cleanup();
    expect(egress.seen[0]?.credentialHosts).toEqual(["127.0.0.1:8000"]);
  });

  it("startEgressProxy mints the session token with that binding", async () => {
    const tokenManager = new TokenManager({ ephemeral: true });
    const handle = await startEgressProxy({
      bindHosts: ["127.0.0.1"],
      tokenManager,
      credentials: { apiKey: FAKE_GEMINI_KEY },
      credentialHosts: ["generativelanguage.googleapis.com"],
    });
    try {
      expect(tokenManager.resolveToken(handle.token)?.hosts).toEqual(["generativelanguage.googleapis.com"]);
    } finally {
      await handle.stop();
    }
  });
});
