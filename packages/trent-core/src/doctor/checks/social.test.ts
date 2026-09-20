/**
 * The social line of `trent doctor`: which social providers are connected (by name, from the
 * profile secrets file), which platforms that reaches and by which route, and the review each
 * platform still needs. No value is read out, no network is touched.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "../../config/ConfigManager.js";
import type { DoctorContext } from "../types.js";
import { checkSocial } from "./social.js";

describe("checkSocial", () => {
  let root = "";
  let configManager: ConfigManager;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-doctor-social-"));
    configManager = new ConfigManager({ baseDir: path.join(root, "home") });
    configManager.ensureDirs();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function context(): DoctorContext {
    return { baseDir: path.join(root, "home"), profile: "default", configManager, env: {}, probeTimeoutMs: 2000 };
  }

  it("with nothing connected it skips, names the three connect commands and says the toolset publishes nowhere", async () => {
    const result = await checkSocial.run(context());
    expect(result.status).toBe("skip");
    expect(result.message).toMatch(/no social provider/i);
    expect(result.fixHint).toContain("trent connect meta");
    expect(result.fixHint).toContain("trent connect bluesky");
    expect(result.fixHint).toContain("trent connect buffer");
    expect(result.details).toMatchObject({ connected: [], toolsetEnabled: false });
  });

  it("with Bluesky and Buffer connected it is ok, lists each platform's route and review state, and leaks no value", async () => {
    configManager.saveSecrets({ BLUESKY_HANDLE: "spa.bsky.social", BLUESKY_APP_PASSWORD: "app-pass-secret-xyz", BUFFER_ACCESS_TOKEN: "buffer-secret-abc" });
    configManager.saveConfig({ ...configManager.loadConfig(), toolsets: ["file_ops", "social"] });
    const result = await checkSocial.run(context());
    expect(result.status).toBe("ok");
    expect(result.message).toContain("bluesky");
    expect(result.message).toContain("buffer");
    const platforms = (result.details as { platforms: Array<{ platform: string; route?: string; review: string; caveats: string[] }> }).platforms;
    expect(platforms.find((p) => p.platform === "bluesky")).toMatchObject({ route: "bluesky", review: "none" });
    expect(platforms.find((p) => p.platform === "x")?.route).toBe("buffer");
    expect(platforms.find((p) => p.platform === "instagram")?.review).toMatch(/Meta App Review/);
    expect(platforms.find((p) => p.platform === "tiktok")?.caveats.join(" ")).toMatch(/SELF_ONLY/);
    const dump = JSON.stringify(result);
    expect(dump).not.toContain("app-pass-secret-xyz");
    expect(dump).not.toContain("buffer-secret-abc");
  });

  it("with a provider connected but the toolset off it warns and says how to enable it", async () => {
    configManager.saveSecrets({ BUFFER_ACCESS_TOKEN: "buffer-secret-abc" });
    const result = await checkSocial.run(context());
    expect(result.status).toBe("warn");
    expect(result.fixHint).toMatch(/toolsets/);
    expect(result.details).toMatchObject({ toolsetEnabled: false, connected: ["buffer"] });
  });
});
