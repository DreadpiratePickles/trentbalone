/**
 * [P3] `trent gateway setup <platform>` writes the names each adapter actually reads, from the
 * registry (`@trent/core/gateway/registry.ts`), into the profile's `.env`. It used to write
 * `<PLATFORM>_BOT_TOKEN`, which among the four H4 adapters only Mattermost reads. Driven through
 * `runCli` in a scratch TRENT_HOME; the values are test strings and the output must never carry one.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigManager } from "@trent/core/config/index.js";
import { EXIT } from "@trent/core/errors/index.js";
import { PLATFORM_REGISTRY } from "@trent/core/gateway/index.js";
import { runCli } from "../index.js";

let home: string;
const touched = new Set<string>();

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-gateway-setup-"));
  process.env.TRENT_HOME = home;
  // Every name any platform reads, so a value left in process.env by another suite cannot answer for the file.
  for (const entry of Object.values(PLATFORM_REGISTRY)) for (const name of [...entry.requiredSecrets, ...entry.optionalSecrets]) touched.add(name);
  for (const name of touched) delete process.env[name];
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  // saveSecrets exports what it writes; nothing written here may outlive the test.
  for (const name of touched) delete process.env[name];
  fs.rmSync(home, { recursive: true, force: true });
});

/** What the profile's `.env` holds, read by a fresh manager (no cache), as an adapter's `readSetting` reads it. */
function envFile(): Record<string, string> {
  const manager = new ConfigManager({ profile: "default" });
  if (!fs.existsSync(manager.getSecretsPath())) return {};
  return { ...(manager.loadSecrets() as Record<string, string>) };
}

async function setup(args: string[]) {
  const result = await runCli(["gateway", "setup", ...args, "--json"]);
  return { ...result, data: result.stdout.trim() === "" ? undefined : (JSON.parse(result.stdout) as Record<string, unknown>) };
}

const TOKEN = "p3-test-token-value";

describe("[P3] trent gateway setup writes each adapter's real names", () => {
  it("matrix: MATRIX_HOMESERVER_URL and MATRIX_ACCESS_TOKEN, and the platform then reports configured", async () => {
    const result = await setup(["matrix", "--token", TOKEN, "--set", "MATRIX_HOMESERVER_URL=https://matrix.example.test"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(envFile()).toEqual({ MATRIX_ACCESS_TOKEN: TOKEN, MATRIX_HOMESERVER_URL: "https://matrix.example.test" });
    expect(result.data).toMatchObject({ platform: "matrix", secretsConfigured: ["MATRIX_ACCESS_TOKEN", "MATRIX_HOMESERVER_URL"], missing: [] });
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    const status = JSON.parse((await runCli(["gateway", "status", "--json"])).stdout) as { platforms: Array<{ id: string; configured: boolean }> };
    expect(status.platforms.find((p) => p.id === "matrix")?.configured).toBe(true);
  });

  it("line: LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET", async () => {
    const result = await setup(["line", "--token", TOKEN, "--set", "LINE_CHANNEL_SECRET=p3-test-channel-secret"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(envFile()).toEqual({ LINE_CHANNEL_ACCESS_TOKEN: TOKEN, LINE_CHANNEL_SECRET: "p3-test-channel-secret" });
    expect(result.data).toMatchObject({ secretsConfigured: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"], missing: [] });
    expect(result.stdout).not.toContain("p3-test-channel-secret");
  });

  it("ntfy: NTFY_TOPIC, with the optional NTFY_URL, NTFY_TOKEN (--token) and NTFY_REPLY_TOPIC", async () => {
    const result = await setup(["ntfy", "--set", "NTFY_TOPIC=trent-p3-out", "NTFY_REPLY_TOPIC=trent-p3-in", "NTFY_URL=https://ntfy.example.test", "--token", TOKEN]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(envFile()).toEqual({ NTFY_TOPIC: "trent-p3-out", NTFY_REPLY_TOPIC: "trent-p3-in", NTFY_URL: "https://ntfy.example.test", NTFY_TOKEN: TOKEN });
    expect(result.data).toMatchObject({ missing: [] });
  });

  it("ntfy with the topic alone is enough: its token is optional", async () => {
    const result = await setup(["ntfy", "--set", "NTFY_TOPIC=trent-p3-out"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(envFile()).toEqual({ NTFY_TOPIC: "trent-p3-out" });
  });

  it("mattermost: MATTERMOST_BOT_TOKEN, and a missing MATTERMOST_URL is named, not guessed", async () => {
    const result = await setup(["mattermost", "--token", TOKEN]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(envFile()).toEqual({ MATTERMOST_BOT_TOKEN: TOKEN });
    expect(result.data).toMatchObject({ secretsConfigured: ["MATTERMOST_BOT_TOKEN"], missing: ["MATTERMOST_URL"] });
  });

  it("telegram keeps its one-flag form: --token writes TELEGRAM_BOT_TOKEN", async () => {
    const result = await setup(["telegram", "--token", TOKEN]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(envFile()).toEqual({ TELEGRAM_BOT_TOKEN: TOKEN });
  });

  it("no platform ever gets a <PLATFORM>_BOT_TOKEN it does not read", async () => {
    for (const platform of ["matrix", "line", "whatsapp", "homeassistant"]) {
      await setup([platform, "--token", TOKEN]);
      expect(Object.keys(envFile())).not.toContain(`${platform.toUpperCase()}_BOT_TOKEN`);
    }
    expect(envFile()).toMatchObject({ MATRIX_ACCESS_TOKEN: TOKEN, LINE_CHANNEL_ACCESS_TOKEN: TOKEN, WHATSAPP_TOKEN: TOKEN, HASS_TOKEN: TOKEN });
  });

  it("refuses a name the platform does not read, an unknown platform, --token where there is none, and nothing at all", async () => {
    const foreign = await setup(["matrix", "--set", "MATRIX_BOT_TOKEN=x"]);
    expect(foreign.exitCode).toBe(EXIT.USAGE);
    expect(foreign.stdout + foreign.stderr).toContain("MATRIX_ACCESS_TOKEN");
    const unknown = await setup(["myspace", "--token", TOKEN]);
    expect(unknown.exitCode).toBe(EXIT.USAGE);
    expect(unknown.stdout + unknown.stderr).toContain("ntfy");
    const signal = await setup(["signal", "--token", TOKEN]);
    expect(signal.exitCode).toBe(EXIT.USAGE);
    expect(signal.stdout + signal.stderr).toContain("--set SIGNAL_NUMBER=");
    const empty = await setup(["line"]);
    expect(empty.exitCode).toBe(EXIT.AUTH);
    const malformed = await setup(["line", "--set", "LINE_CHANNEL_SECRET"]);
    expect(malformed.exitCode).toBe(EXIT.USAGE);
    expect(envFile()).toEqual({});
    for (const r of [foreign, unknown, signal, empty, malformed]) expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("--dry-run names what it would write and writes nothing", async () => {
    const result = await runCli(["gateway", "setup", "line", "--token", TOKEN, "--set", "LINE_CHANNEL_SECRET=s", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, command: "gateway setup", platform: "line", wouldWriteSecrets: ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_CHANNEL_SECRET"] });
    expect(envFile()).toEqual({});
  });
});
