/**
 * `trent desktop` and `trent update` driven through `runCli`, against the same local HTTPS release
 * server the core tests use. `--insecure-base-url` is the only thing that lets the env override the
 * release source, so every test here passes it explicitly, and the dry-run tests prove that the
 * server saw nothing at all.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EXIT } from "@trent/core/errors/index.js";
import { desktopBundleName } from "@trent/core/updater/index.js";
import {
  fakeBinary,
  layoutRelease,
  makeKeypair,
  startReleaseServer,
  type ReleaseServer,
  type TestKeypair,
} from "../../../../../packages/trent-core/src/updater/__tests__/fixture.js";
import { CLI_VERSION, runCli } from "../index.js";

let server: ReleaseServer;
let key: TestKeypair;
let home: string;
let env: NodeJS.ProcessEnv;
const ENV_KEYS = ["HOME", "TRENT_HOME", "TRENT_RELEASE_BASE_URL", "TRENT_RELEASE_CA_FILE", "TRENT_RELEASE_PUBLIC_KEY_FILE"] as const;
let savedEnv: Record<string, string | undefined> = {};

const ASSET = `trent-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;

beforeAll(async () => {
  server = await startReleaseServer();
  key = makeKeypair();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-desktop-"));
  const caFile = path.join(home, "ca.pem");
  const keyFile = path.join(home, "minisign.pub");
  fs.writeFileSync(caFile, server.caPem);
  fs.writeFileSync(keyFile, key.publicKeyFile);
  // The updater reads process.env (ConfigManager already does for TRENT_HOME), so set and restore it.
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  env = {
    HOME: path.join(home, "user"),
    TRENT_HOME: path.join(home, ".trent"),
    TRENT_RELEASE_BASE_URL: server.baseUrl,
    TRENT_RELEASE_CA_FILE: caFile,
    TRENT_RELEASE_PUBLIC_KEY_FILE: keyFile,
  };
  Object.assign(process.env, env);
  fs.mkdirSync(env.HOME ?? "", { recursive: true });
  fs.mkdirSync(env.TRENT_HOME ?? "", { recursive: true });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(home, { recursive: true, force: true });
  server.files.clear();
  server.requests.length = 0;
});

function parse<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

describe("--dry-run makes zero network calls and zero writes", () => {
  const invocations = [
    ["desktop", "install"],
    ["desktop", "launch"],
    ["desktop", "status"],
    ["desktop", "uninstall"],
    ["update"],
    ["update", "--check"],
    ["update", "--rollback"],
  ];
  for (const argv of invocations) {
    it(`${argv.join(" ")} --dry-run`, async () => {
      layoutRelease(server, { version: "9.0.0", assets: { [ASSET]: fakeBinary("9.0.0") } }, key);
      const before = fs.readdirSync(env.TRENT_HOME ?? "");
      const result = await runCli([...argv, "--json", "--dry-run", "--insecure-base-url"], { env });
      expect(result.exitCode, result.stdout).toBe(EXIT.OK);
      expect(parse<{ dryRun: boolean }>(result.stdout).dryRun).toBe(true);
      expect(server.requests).toHaveLength(0);
      expect(fs.readdirSync(env.TRENT_HOME ?? "")).toEqual(before);
    });
  }
});

describe("trent update", () => {
  it("--check exits 0 when up to date", async () => {
    layoutRelease(server, { version: CLI_VERSION, assets: { [ASSET]: fakeBinary(CLI_VERSION) } }, key);
    const result = await runCli(["update", "--check", "--json", "--insecure-base-url"], { env });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(parse<{ updateAvailable: boolean }>(result.stdout).updateAvailable).toBe(false);
  });

  it("--check exits non-zero with the available version", async () => {
    layoutRelease(server, { version: "9.0.0", assets: { [ASSET]: fakeBinary("9.0.0") } }, key);
    const result = await runCli(["update", "--check", "--json", "--insecure-base-url"], { env });
    expect(result.exitCode).not.toBe(EXIT.OK);
    const data = parse<{ updateAvailable: boolean; latestVersion: string }>(result.stdout);
    expect(data.updateAvailable).toBe(true);
    expect(data.latestVersion).toBe("9.0.0");
  });

  it("ignores TRENT_RELEASE_BASE_URL without --insecure-base-url (dry-run shows the github source)", async () => {
    const result = await runCli(["update", "--check", "--json", "--dry-run"], { env });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(parse<{ source: string }>(result.stdout).source).toMatch(/github\.com/);
    expect(server.requests).toHaveLength(0);
  });

  it.skipIf(process.platform === "win32")("installs, verifies --version, writes a receipt, and rolls back", async () => {
    layoutRelease(server, { version: "9.0.0", assets: { [ASSET]: fakeBinary("9.0.0") } }, key);
    const bin = path.join(env.TRENT_HOME ?? "", "bin", "trent");
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, fakeBinary(CLI_VERSION), { mode: 0o755 });

    const applied = await runCli(["update", "--json", "--insecure-base-url"], { env });
    expect(applied.exitCode, applied.stdout).toBe(EXIT.OK);
    const receipt = parse<{ ok: boolean; toVersion: string; installedPath: string; receiptPath: string }>(applied.stdout);
    expect(receipt.ok).toBe(true);
    expect(receipt.toVersion).toBe("9.0.0");
    expect(execFileSync(receipt.installedPath).toString().trim()).toBe("9.0.0");
    expect(receipt.receiptPath.startsWith(path.join(env.TRENT_HOME ?? "", "logs", "update_receipts"))).toBe(true);

    const back = await runCli(["update", "--rollback", "--json"], { env });
    expect(back.exitCode, back.stdout).toBe(EXIT.OK);
    expect(fs.readFileSync(bin)).toEqual(fakeBinary(CLI_VERSION));
  });

  it("refuses a downgrade without --force", async () => {
    layoutRelease(server, { version: "0.0.1", assets: { [ASSET]: fakeBinary("0.0.1") } }, key);
    const result = await runCli(["update", "--json", "--insecure-base-url"], { env });
    expect(result.exitCode).not.toBe(EXIT.OK);
    expect(result.stdout).toMatch(/--force/);
  });
});

describe("trent desktop", () => {
  it("status reports not installed with exit 0", async () => {
    const result = await runCli(["desktop", "status", "--json", "--no-check"], { env });
    expect(result.exitCode).toBe(EXIT.OK);
    expect(parse<{ installed: boolean }>(result.stdout).installed).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  it("uninstall removes only the manifest-listed paths", async () => {
    const trentHome = env.TRENT_HOME ?? "";
    const installed = path.join(home, "installed-app");
    const bystander = path.join(home, "bystander");
    fs.writeFileSync(installed, "app");
    fs.writeFileSync(bystander, "not mine");
    fs.mkdirSync(path.join(trentHome, "desktop"), { recursive: true });
    fs.writeFileSync(
      path.join(trentHome, "desktop", "manifest.json"),
      JSON.stringify({ version: "1.0.0", platform: process.platform, arch: process.arch, format: "test", bundle: "x", sha256: "0".repeat(64), installedAt: "2026-01-01T00:00:00.000Z", paths: [installed], launch: { command: installed, args: [] } }),
    );
    const result = await runCli(["desktop", "uninstall", "--json"], { env });
    expect(result.exitCode, result.stdout).toBe(EXIT.OK);
    expect(parse<{ removed: string[] }>(result.stdout).removed).toEqual([installed]);
    expect(fs.existsSync(installed)).toBe(false);
    expect(fs.existsSync(bystander)).toBe(true);
    expect(fs.existsSync(path.join(trentHome, "desktop", "manifest.json"))).toBe(true);
  });

  it("launch fails clearly when nothing is installed", async () => {
    const result = await runCli(["desktop", "launch", "--json"], { env });
    expect(result.exitCode).not.toBe(EXIT.OK);
    expect(result.stdout).toMatch(/not installed/i);
  });

  it.runIf(process.platform === "darwin")("install mounts a real DMG and copies the app into $HOME/Applications", async () => {
    const stage = path.join(home, "dmg-src");
    const macos = path.join(stage, "Trent Fleet.app", "Contents", "MacOS");
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(macos, "Trent Fleet"), "#!/bin/sh\necho 1.2.3\n", { mode: 0o755 });
    const dmg = path.join(home, "out.dmg");
    execFileSync("hdiutil", ["create", "-quiet", "-srcfolder", stage, "-volname", "Trent Fleet", "-fs", "HFS+", dmg]);
    const bundle = desktopBundleName("darwin", process.arch, "1.2.3");
    layoutRelease(server, { version: "1.2.3", assets: { [bundle]: fs.readFileSync(dmg) } }, key);

    const result = await runCli(["desktop", "install", "--json", "--insecure-base-url"], { env });
    expect(result.exitCode, result.stdout).toBe(EXIT.OK);
    const app = path.join(env.HOME ?? "", "Applications", "Trent Fleet.app", "Contents", "MacOS", "Trent Fleet");
    expect(execFileSync(app).toString().trim()).toBe("1.2.3");
    const status = await runCli(["desktop", "status", "--json", "--no-check"], { env });
    expect(parse<{ installed: boolean; version: string }>(status.stdout)).toMatchObject({ installed: true, version: "1.2.3" });
  }, 120_000);
});
