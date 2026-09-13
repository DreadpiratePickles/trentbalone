/**
 * The desktop installer, platform by platform, with the process runner injected so a Linux path
 * can be proven on a Mac and no test mounts a real disk image (the CLI test does, on macOS).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  desktopBundleName,
  desktopInstall,
  desktopLaunch,
  desktopPlan,
  desktopStatus,
  desktopUninstall,
  readDesktopManifest,
  type CommandRunner,
  type DesktopEnv,
  type ReleaseOptions,
} from "../index.js";
import { layoutRelease, makeKeypair, startReleaseServer, tempHome, type ReleaseServer, type TestKeypair } from "./fixture.js";

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
  server.requests.length = 0;
});

/** Records every command; on `hdiutil attach` it fakes a mounted volume holding the .app. */
function recordingRunner(calls: string[][]): CommandRunner {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (command === "hdiutil" && args[0] === "attach") {
      const mountpoint = args[args.indexOf("-mountpoint") + 1] ?? "";
      const app = path.join(mountpoint, "Trent Fleet.app", "Contents", "MacOS");
      fs.mkdirSync(app, { recursive: true });
      fs.writeFileSync(path.join(app, "Trent Fleet"), "#!/bin/sh\necho app\n", { mode: 0o755 });
    }
    return { stdout: "", stderr: "" };
  };
}

function makeEnv(platform: NodeJS.Platform, arch: string, calls: string[][]): DesktopEnv {
  home = tempHome("trent-desktop-");
  const userHome = path.join(home, "user");
  fs.mkdirSync(userHome, { recursive: true });
  return {
    home: path.join(home, ".trent"),
    userHome,
    platform,
    arch,
    release,
    publicKey: key.publicKeyFile,
    run: recordingRunner(calls),
  };
}

describe("desktopBundleName", () => {
  it("names the Tauri bundle for each platform", () => {
    expect(desktopBundleName("darwin", "arm64", "1.2.3")).toBe("Trent Fleet_1.2.3_aarch64.dmg");
    expect(desktopBundleName("darwin", "x64", "1.2.3")).toBe("Trent Fleet_1.2.3_x64.dmg");
    expect(desktopBundleName("win32", "x64", "1.2.3")).toBe("Trent Fleet_1.2.3_x64-setup.exe");
    expect(desktopBundleName("linux", "x64", "1.2.3")).toBe("trent-fleet_1.2.3_amd64.AppImage");
    expect(() => desktopBundleName("linux", "arm64", "1.2.3")).toThrow(/unsupported/);
  });
});

describe("desktop install on macOS", () => {
  it("fetches, verifies, mounts, copies to ~/Applications and records a manifest", async () => {
    const calls: string[][] = [];
    const e = makeEnv("darwin", "arm64", calls);
    const bundle = desktopBundleName("darwin", "arm64", "1.2.3");
    layoutRelease(server, { version: "1.2.3", assets: { [bundle]: Buffer.from("fake dmg bytes") } }, key);

    const manifest = await desktopInstall(e, {});
    const appPath = path.join(e.userHome, "Applications", "Trent Fleet.app");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.paths).toContain(appPath);
    expect(fs.existsSync(path.join(appPath, "Contents", "MacOS", "Trent Fleet"))).toBe(true);
    expect(calls.some((c) => c[0] === "hdiutil" && c[1] === "attach")).toBe(true);
    expect(calls.some((c) => c[0] === "hdiutil" && c[1] === "detach")).toBe(true);
    expect(readDesktopManifest(e.home)?.version).toBe("1.2.3");
    // The download was never left behind.
    expect(fs.existsSync(manifest.bundle)).toBe(false);
  });

  it("refuses a downgrade without force and reinstalls with it", async () => {
    const calls: string[][] = [];
    const e = makeEnv("darwin", "arm64", calls);
    layoutRelease(server, { version: "1.2.3", assets: { [desktopBundleName("darwin", "arm64", "1.2.3")]: Buffer.from("x") } }, key);
    layoutRelease(server, { version: "1.0.0", assets: { [desktopBundleName("darwin", "arm64", "1.0.0")]: Buffer.from("y") } }, key);
    await desktopInstall(e, { version: "1.2.3" });
    await expect(desktopInstall(e, { version: "1.0.0" })).rejects.toThrow(/downgrade|--force/i);
    const forced = await desktopInstall(e, { version: "1.0.0", force: true });
    expect(forced.version).toBe("1.0.0");
  });

  it("refuses /Applications without --system", async () => {
    const e = makeEnv("darwin", "arm64", []);
    expect(desktopPlan(e, { version: "1.0.0" }).installDir).toBe(path.join(e.userHome, "Applications"));
    expect(desktopPlan(e, { version: "1.0.0", system: true }).installDir).toBe("/Applications");
  });

  it("launch uses open -a on the installed app", async () => {
    const calls: string[][] = [];
    const e = makeEnv("darwin", "arm64", calls);
    layoutRelease(server, { version: "1.2.3", assets: { [desktopBundleName("darwin", "arm64", "1.2.3")]: Buffer.from("x") } }, key);
    await desktopInstall(e, {});
    const launched = await desktopLaunch(e);
    expect(launched.command).toBe("open");
    expect(launched.args).toEqual(["-a", path.join(e.userHome, "Applications", "Trent Fleet.app")]);
  });

  it("launch refuses when nothing is installed", async () => {
    const e = makeEnv("darwin", "arm64", []);
    await expect(desktopLaunch(e)).rejects.toThrow(/not installed/i);
  });
});

describe("desktop install on Linux", () => {
  it("places the AppImage under ~/.local/bin and writes a .desktop entry", async () => {
    const calls: string[][] = [];
    const e = makeEnv("linux", "x64", calls);
    const bundle = desktopBundleName("linux", "x64", "1.2.3");
    layoutRelease(server, { version: "1.2.3", assets: { [bundle]: Buffer.from("#!/bin/sh\necho appimage\n") } }, key);
    const manifest = await desktopInstall(e, {});
    const appImage = path.join(e.userHome, ".local", "bin", "trent-fleet.AppImage");
    const entry = path.join(e.userHome, ".local", "share", "applications", "trent-fleet.desktop");
    expect(manifest.paths).toEqual(expect.arrayContaining([appImage, entry]));
    expect(fs.statSync(appImage).mode & 0o111).not.toBe(0);
    expect(fs.readFileSync(entry, "utf8")).toContain(`Exec=${appImage}`);
    expect(calls).toHaveLength(0);
    const launched = await desktopLaunch(e);
    expect(launched.command).toBe(appImage);
  });
});

describe("desktop status and uninstall", () => {
  it("status reports installed version, path and whether a newer release exists", async () => {
    const e = makeEnv("darwin", "arm64", []);
    layoutRelease(server, { version: "1.2.3", assets: { [desktopBundleName("darwin", "arm64", "1.2.3")]: Buffer.from("x") } }, key);
    expect((await desktopStatus(e, { checkLatest: false })).installed).toBe(false);
    await desktopInstall(e, {});
    layoutRelease(server, { version: "1.3.0", assets: { [desktopBundleName("darwin", "arm64", "1.3.0")]: Buffer.from("y") } }, key);
    const status = await desktopStatus(e, { checkLatest: true });
    expect(status.installed).toBe(true);
    expect(status.version).toBe("1.2.3");
    expect(status.latestVersion).toBe("1.3.0");
    expect(status.updateAvailable).toBe(true);
  });

  it("uninstall removes exactly the manifest paths and asks before touching ~/.trent", async () => {
    const e = makeEnv("linux", "x64", []);
    layoutRelease(server, { version: "1.2.3", assets: { [desktopBundleName("linux", "x64", "1.2.3")]: Buffer.from("z") } }, key);
    const manifest = await desktopInstall(e, {});
    const bystander = path.join(e.userHome, ".local", "bin", "unrelated-tool");
    fs.writeFileSync(bystander, "keep me");

    const result = await desktopUninstall(e, { yes: false });
    for (const p of manifest.paths) expect(fs.existsSync(p), p).toBe(false);
    expect(fs.existsSync(bystander)).toBe(true);
    expect(result.removed).toEqual(manifest.paths);
    // Without --yes the manifest dir under ~/.trent stays, marked uninstalled.
    expect(fs.existsSync(path.join(e.home, "desktop", "manifest.json"))).toBe(true);
    expect(readDesktopManifest(e.home)?.uninstalledAt).toBeTypeOf("string");

    const again = await desktopUninstall(e, { yes: true });
    expect(again.removedData).toBe(true);
    expect(fs.existsSync(path.join(e.home, "desktop"))).toBe(false);
  });
});
