/**
 * S5.3: `trent panic` — the big red button. It revokes ALL gateway pairings at once and asks any
 * in-flight work on the profile to stop, printing exactly what it revoked. A dry-run lists what it
 * WOULD revoke and touches nothing. It composes the real `PairingManager.revokeAll` + the profile's
 * live-lock pids, so nothing it prints is theatre.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { FileGatewayStore, PairingManager } from "@trent/core/gateway/index.js";
import { TokenManager, egressTokenStorePath } from "@trent/core/egress/index.js";
import { runCli } from "../index.js";

interface PanicJson {
  command: string;
  dryRun?: boolean;
  revoked: number;
  pairings: Array<{ platform: string; senderId: string; scope: string; tier: string }>;
  stopTargets: Array<{ pid: number; role: string; label: string }>;
  signalled: boolean;
  signal: string;
  egressTokensRevoked: number;
  egressTokensActive: number;
}

// The egress token broker panic must reach: the same file the running proxy validates against,
// derived from this profile's base dir so the test stays hermetic under TRENT_HOME.
const egressTokens = (): TokenManager =>
  new TokenManager({ filePath: egressTokenStorePath(profileDir()) });

const seedEgressTokens = (): void => {
  const manager = egressTokens();
  manager.issueToken("eng-ai-engineer", { apiKey: "sk-live-1" });
  manager.issueToken("ceo", { apiKey: "sk-live-2" });
};

let home: string;

const profileDir = (): string => new ConfigManager({ profile: "default" }).getProfileDir();
const store = (): FileGatewayStore => new FileGatewayStore(path.join(profileDir(), "gateway.json"));

const seedPairings = (): void => {
  const manager = new PairingManager(store());
  manager.grant({ platform: "telegram", senderId: "555", scope: "dm", tier: "admin" });
  manager.grant({ platform: "slack", senderId: "U9", scope: "dm", tier: "regular" });
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-panic-"));
  process.env.TRENT_HOME = home;
  fs.writeFileSync(path.join(home, "config.yaml"), ["version: 3", "profile: default", "provider: openai", "model: gpt-5.6-terra", ""].join("\n"), { mode: 0o644 });
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trent panic revokes every pairing", () => {
  it("revokes all pairings, prints them, and leaves the store empty", async () => {
    seedPairings();
    expect(store().snapshot().pairings).toHaveLength(2);

    const result = await runCli(["panic", "--json"]);

    expect(result.exitCode, result.stdout).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as PanicJson;
    expect(data.command).toBe("panic");
    expect(data.revoked).toBe(2);
    expect(data.pairings.map((p) => `${p.platform}:${p.senderId}`).sort()).toEqual(["slack:U9", "telegram:555"]);
    expect(data.signal).toBe("SIGTERM");
    // No gateway or run is live in the test, so there is nothing to signal.
    expect(data.stopTargets).toEqual([]);
    expect(store().snapshot().pairings).toEqual([]);
  });

  it("under --dry-run lists what it WOULD revoke and revokes nothing", async () => {
    seedPairings();

    const result = await runCli(["panic", "--dry-run", "--json"]);

    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as PanicJson;
    expect(data.dryRun).toBe(true);
    expect(data.command).toBe("panic");
    expect(data.revoked).toBe(0);
    expect(data.pairings).toHaveLength(2);
    expect(data.signalled).toBe(false);
    // Nothing was touched.
    expect(store().snapshot().pairings).toHaveLength(2);
  });

  it("renders a human report naming the revoked senders", async () => {
    seedPairings();

    const result = await runCli(["panic"]);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain("PANIC");
    expect(result.stdout).toContain("telegram");
    expect(result.stdout).toContain("555");
  });

  it("exits 0 and revokes 0 on a profile with nothing paired", async () => {
    const result = await runCli(["panic", "--json"]);

    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as PanicJson;
    expect(data.revoked).toBe(0);
    expect(data.pairings).toEqual([]);
  });
});

describe("trent panic drops egress trust too", () => {
  it("revokes every brokered egress token and reports the count", async () => {
    seedPairings();
    seedEgressTokens();
    expect(egressTokens().listActiveTokens()).toHaveLength(2);

    const result = await runCli(["panic", "--json"]);

    expect(result.exitCode, result.stdout).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as PanicJson;
    expect(data.egressTokensRevoked).toBe(2);
    // After panic the proxy (which validates against this same file) refuses every former token.
    expect(egressTokens().listActiveTokens()).toEqual([]);
  });

  it("names the egress-token count in the human report", async () => {
    seedEgressTokens();

    const result = await runCli(["panic"]);

    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain("2 egress token");
  });

  it("under --dry-run revokes no egress tokens but reports the would-be count", async () => {
    seedEgressTokens();

    const result = await runCli(["panic", "--dry-run", "--json"]);

    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as PanicJson;
    expect(data.egressTokensRevoked).toBe(0);
    expect(data.egressTokensActive).toBe(2);
    // Nothing was touched: the tokens still resolve.
    expect(egressTokens().listActiveTokens()).toHaveLength(2);
  });

  it("carries egressTokensRevoked even when no egress tokens exist", async () => {
    const result = await runCli(["panic", "--json"]);

    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as PanicJson;
    expect(data.egressTokensRevoked).toBe(0);
    expect(data.egressTokensActive).toBe(0);
  });
});
