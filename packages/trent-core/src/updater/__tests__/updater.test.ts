/**
 * The release-artifact module, proven against a local HTTPS server serving a fake release layout.
 * Every security property named in the milestone has its own test here, and each one asserts a
 * refusal — not a log line.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  applyUpdate,
  assertValidVersion,
  checkUpdate,
  compareVersions,
  fetchArtifact,
  installAtomically,
  planUpdate,
  resolveLatest,
  rollbackInstall,
  rollbackUpdate,
  verifyArtifact,
  type ReleaseOptions,
  type UpdaterEnv,
} from "../index.js";
import {
  fakeBinary,
  layoutRelease,
  makeKeypair,
  sha256Hex,
  startReleaseServer,
  tempHome,
  type ReleaseServer,
  type TestKeypair,
} from "./fixture.js";

const ASSET = "trent-darwin-arm64";

let server: ReleaseServer;
let key: TestKeypair;
let release: ReleaseOptions;
let home: string;

beforeAll(async () => {
  server = await startReleaseServer();
  key = makeKeypair();
  release = { insecureBaseUrl: server.baseUrl, ca: server.caPem };
});

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
  server.files.clear();
  server.redirects.clear();
  server.truncate.clear();
  server.requests.length = 0;
});

function env(currentVersion: string): UpdaterEnv {
  home = tempHome("trent-updater-");
  return { home, currentVersion, asset: ASSET, release, publicKey: key.publicKeyFile };
}

describe("version validation", () => {
  it("accepts semver with an optional v prefix and prerelease tag", () => {
    expect(assertValidVersion("v1.2.3")).toBe("1.2.3");
    expect(assertValidVersion("1.2.3-beta.1")).toBe("1.2.3-beta.1");
  });

  it("refuses a spoofed version before any request is made", async () => {
    for (const bad of ["../../etc", "1.2", "v1.2.3/../x", "1.2.3;rm", "", "latest"]) {
      expect(() => assertValidVersion(bad), bad).toThrow(/version/);
    }
    await expect(fetchArtifact(ASSET, "../../etc", undefined, release)).rejects.toThrow(/version/);
    expect(server.requests).toHaveLength(0);
  });

  it("orders versions numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
  });
});

describe("resolveLatest", () => {
  it("reads the stable channel from the GitHub-shaped API", async () => {
    layoutRelease(server, { version: "2.0.0", assets: { [ASSET]: fakeBinary("2.0.0") } }, key);
    const latest = await resolveLatest("stable", release);
    expect(latest.version).toBe("2.0.0");
    expect(latest.assets).toContain(ASSET);
  });

  it("refuses a base URL override that is not https", async () => {
    await expect(resolveLatest("stable", { insecureBaseUrl: "http://127.0.0.1:1" })).rejects.toThrow(/https/);
    expect(server.requests).toHaveLength(0);
  });
});

describe("fetchArtifact", () => {
  it("downloads into a private temp dir and checks Content-Length", async () => {
    const bytes = fakeBinary("2.0.0");
    layoutRelease(server, { version: "2.0.0", assets: { [ASSET]: bytes } }, key);
    const fetched = await fetchArtifact(ASSET, "2.0.0", undefined, release);
    expect(fs.readFileSync(fetched.path)).toEqual(bytes);
    expect(fs.statSync(fetched.dir).mode & 0o077).toBe(0);
    expect(fs.statSync(fetched.path).mode & 0o077).toBe(0);
    fs.rmSync(fetched.dir, { recursive: true, force: true });
  });

  it("refuses a truncated body", async () => {
    layoutRelease(server, { version: "2.0.0", assets: { [ASSET]: fakeBinary("2.0.0") } }, key);
    server.truncate.add(`/releases/download/v2.0.0/${ASSET}`);
    await expect(fetchArtifact(ASSET, "2.0.0", undefined, release)).rejects.toThrow(/truncat|length|closed/i);
  });

  it("refuses a redirect to another host", async () => {
    layoutRelease(server, { version: "2.0.0", assets: { [ASSET]: fakeBinary("2.0.0") } }, key);
    server.redirects.set(`/releases/download/v2.0.0/${ASSET}`, "https://evil.example.com/trent");
    await expect(fetchArtifact(ASSET, "2.0.0", undefined, release)).rejects.toThrow(/redirect/i);
    // The redirect was seen but never followed: only the one request reached the server.
    expect(server.requests).toEqual([`/releases/download/v2.0.0/${ASSET}`]);
  });

  it("refuses an asset name that could escape the release directory", async () => {
    await expect(fetchArtifact("../SHA256SUMS", "2.0.0", undefined, release)).rejects.toThrow(/asset/);
    expect(server.requests).toHaveLength(0);
  });
});

describe("verifyArtifact", () => {
  async function fetchTriple(version: string): Promise<[string, string, string, string]> {
    const artifact = await fetchArtifact(ASSET, version, undefined, release);
    const sums = await fetchArtifact("SHA256SUMS", version, undefined, release);
    const sig = await fetchArtifact("SHA256SUMS.minisig", version, undefined, release);
    return [artifact.path, sums.path, sig.path, artifact.dir];
  }

  it("accepts a correctly signed release", async () => {
    const bytes = fakeBinary("2.0.0");
    layoutRelease(server, { version: "2.0.0", assets: { [ASSET]: bytes } }, key);
    const [a, s, g] = await fetchTriple("2.0.0");
    const result = await verifyArtifact(a, s, g, { publicKey: key.publicKeyFile });
    expect(result.sha256).toBe(sha256Hex(bytes));
  });

  it("refuses a correct checksum with an INVALID signature (compromised release host)", async () => {
    layoutRelease(server, { version: "2.0.0", assets: { [ASSET]: fakeBinary("2.0.0") } }, key, {
      badSignature: true,
    });
    const [a, s, g] = await fetchTriple("2.0.0");
    await expect(verifyArtifact(a, s, g, { publicKey: key.publicKeyFile })).rejects.toThrow(/signature/i);
  });

  it("refuses a tampered artifact byte", async () => {
    const bytes = fakeBinary("2.0.0");
    layoutRelease(server, { version: "2.0.0", assets: { [ASSET]: bytes } }, key);
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 2] ^= 0x01;
    server.files.set(`/releases/download/v2.0.0/${ASSET}`, tampered);
    const [a, s, g] = await fetchTriple("2.0.0");
    await expect(verifyArtifact(a, s, g, { publicKey: key.publicKeyFile })).rejects.toThrow(/sha-?256/i);
  });

  it("refuses when the sums file names no such artifact", async () => {
    layoutRelease(server, { version: "2.0.0", assets: { other: fakeBinary("2.0.0"), [ASSET]: fakeBinary("2.0.0") } }, key);
    const [a, s, g] = await fetchTriple("2.0.0");
    const renamed = path.join(path.dirname(a), "not-listed");
    fs.renameSync(a, renamed);
    await expect(verifyArtifact(renamed, s, g, { publicKey: key.publicKeyFile })).rejects.toThrow(/no entry/i);
  });
});

describe("installAtomically and rollback", () => {
  it("renames into place, keeps .previous, and rollback restores it byte-for-byte", () => {
    home = tempHome("trent-install-");
    const target = path.join(home, "bin", "trent");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const v1 = fakeBinary("1.0.0");
    const v2 = fakeBinary("2.0.0");
    fs.writeFileSync(target, v1, { mode: 0o755 });
    const staged = path.join(home, "staged");
    fs.writeFileSync(staged, v2);

    const result = installAtomically(staged, target);
    expect(result.previous).toBe(`${target}.previous`);
    expect(fs.readFileSync(target)).toEqual(v2);
    expect(fs.readFileSync(`${target}.previous`)).toEqual(v1);
    expect(fs.existsSync(staged)).toBe(false);
    expect(fs.statSync(target).mode & 0o111).not.toBe(0);

    rollbackInstall(target);
    expect(fs.readFileSync(target)).toEqual(v1);
  });

  it("refuses to roll back when there is no previous", () => {
    home = tempHome("trent-install-");
    expect(() => rollbackInstall(path.join(home, "nothing"))).toThrow(/previous/);
  });
});

describe("self-update end to end", () => {
  it("check reports an available version and plan/apply install it; --version works", async () => {
    const e = env("1.0.0");
    layoutRelease(server, { version: "2.0.0", assets: { [ASSET]: fakeBinary("2.0.0") } }, key);
    fs.mkdirSync(path.join(e.home, "bin"), { recursive: true });
    fs.writeFileSync(path.join(e.home, "bin", "trent"), fakeBinary("1.0.0"), { mode: 0o755 });

    const check = await checkUpdate(e, "stable");
    expect(check.updateAvailable).toBe(true);
    expect(check.latestVersion).toBe("2.0.0");

    const plan = await planUpdate(e, { channel: "stable" });
    expect(plan.action).toBe("install");
    const receipt = await applyUpdate(e, plan);
    expect(receipt.ok).toBe(true);
    expect(receipt.installedPath).toBe(path.join(e.home, "bin", "trent"));
    expect(execFileSync(receipt.installedPath).toString().trim()).toBe("2.0.0");
    expect(fs.readFileSync(path.join(e.home, "current"), "utf8").trim()).toBe("2.0.0");

    const receipts = fs.readdirSync(path.join(e.home, "logs", "update_receipts"));
    expect(receipts).toHaveLength(1);
    const written = JSON.parse(fs.readFileSync(path.join(e.home, "logs", "update_receipts", receipts[0] ?? ""), "utf8")) as { ok: boolean; toVersion: string };
    expect(written.ok).toBe(true);
    expect(written.toVersion).toBe("2.0.0");

    const back = await rollbackUpdate(e);
    expect(back.restoredVersion).toBe("1.0.0");
    expect(fs.readFileSync(path.join(e.home, "bin", "trent"))).toEqual(fakeBinary("1.0.0"));
  });

  it("refuses a downgrade without force", async () => {
    const e = env("3.0.0");
    layoutRelease(server, { version: "2.0.0", assets: { [ASSET]: fakeBinary("2.0.0") } }, key);
    await expect(planUpdate(e, { channel: "stable" })).rejects.toThrow(/downgrade|--force/i);
    const forced = await planUpdate(e, { channel: "stable", force: true });
    expect(forced.action).toBe("install");
  });

  it("apply refuses a bad signature and leaves the installed binary untouched", async () => {
    const e = env("1.0.0");
    layoutRelease(server, { version: "2.0.0", assets: { [ASSET]: fakeBinary("2.0.0") } }, key, { badSignature: true });
    fs.mkdirSync(path.join(e.home, "bin"), { recursive: true });
    fs.writeFileSync(path.join(e.home, "bin", "trent"), fakeBinary("1.0.0"), { mode: 0o755 });
    const plan = await planUpdate(e, { channel: "stable" });
    await expect(applyUpdate(e, plan)).rejects.toThrow(/signature/i);
    expect(fs.readFileSync(path.join(e.home, "bin", "trent"))).toEqual(fakeBinary("1.0.0"));
    const receipts = fs.readdirSync(path.join(e.home, "logs", "update_receipts"));
    expect(receipts).toHaveLength(1);
    expect((JSON.parse(fs.readFileSync(path.join(e.home, "logs", "update_receipts", receipts[0] ?? ""), "utf8")) as { ok: boolean }).ok).toBe(false);
  });
});
