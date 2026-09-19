/**
 * `trent hooks list|consent`: the only way a user grants a hook permission to run.
 *
 * The consent record is a hash of the exact spec, so these tests care about one thing above all:
 * editing a hook must lose its consent. A hooks feature where an edited command keeps running is
 * a feature that lets anything that can write `config.yaml` run anything at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { stringify as toYaml } from "yaml";
import { EXIT } from "@trent/core/errors/index.js";
import { runCli } from "../index.js";

let home: string;

type ListedHook = { kind: string; command: string[]; consented: boolean; hash: string; timeout_ms?: number; match_tool?: string };
type ListData = { profile: string; consentFile: string; hooks: ListedHook[]; consented: number; unconsented: number };
type ConsentData = { dryRun?: boolean; consentFile: string; granted: number; revoked: number; hooks: { kind: string; command: string[] }[] };

function writeConfig(hooks: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, "config.yaml"), toYaml({ version: 3, profile: "default", hooks }));
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-hooks-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("trent hooks list", () => {
  it("reports nothing configured on a fresh profile, and exits 0", async () => {
    writeConfig({});
    const result = await runCli(["hooks", "list", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as ListData;
    expect(data.hooks).toEqual([]);
    expect(data.consented).toBe(0);
    expect(data.unconsented).toBe(0);
  });

  it("lists every configured hook with its kind, its argv and its consent state", async () => {
    writeConfig({
      pre_tool_call: [{ command: ["/usr/bin/true", "--pre"], match: { tool: "terminal" } }],
      session_stop: [{ command: ["/usr/bin/true", "--stop"], timeout_ms: 2000 }],
    });
    const data = JSON.parse((await runCli(["hooks", "list", "--json"])).stdout) as ListData;
    expect(data.hooks).toHaveLength(2);
    expect(data.hooks.map((hook) => hook.kind)).toEqual(["pre_tool_call", "session_stop"]);
    expect(data.hooks[0]).toMatchObject({ command: ["/usr/bin/true", "--pre"], consented: false, match_tool: "terminal" });
    expect(data.hooks[1]).toMatchObject({ timeout_ms: 2000, consented: false });
    expect(data.unconsented).toBe(2);
    expect(data.consentFile).toBe(path.join(home, "hooks-consent.json"));
  });

  it("renders the consent state in human mode, without emoji", async () => {
    writeConfig({ pre_tool_call: [{ command: ["/usr/bin/true"] }] });
    const result = await runCli(["hooks", "list"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(result.stdout).toContain("pre_tool_call");
    expect(result.stdout).toContain("/usr/bin/true");
    expect(result.stdout).toMatch(/not consented/i);
    expect(result.stdout).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("trent hooks consent", () => {
  it("records the hooks in the config, 0600, and list then reports them consented", async () => {
    writeConfig({ pre_tool_call: [{ command: ["/usr/bin/true", "--pre"] }], post_tool_call: [{ command: ["/usr/bin/true", "--post"] }] });
    const granted = await runCli(["hooks", "consent", "--json"]);
    expect(granted.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(granted.stdout) as ConsentData;
    expect(data.granted).toBe(2);

    const file = path.join(home, "hooks-consent.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const listed = JSON.parse((await runCli(["hooks", "list", "--json"])).stdout) as ListData;
    expect(listed.consented).toBe(2);
    expect(listed.unconsented).toBe(0);
    expect(listed.hooks.every((hook) => hook.consented)).toBe(true);
  });

  it("loses consent when a hook's command changes, so an edited hook is silent until it is granted again", async () => {
    writeConfig({ pre_tool_call: [{ command: ["/usr/bin/true", "--pre"] }] });
    await runCli(["hooks", "consent", "--json"]);
    expect((JSON.parse((await runCli(["hooks", "list", "--json"])).stdout) as ListData).consented).toBe(1);

    writeConfig({ pre_tool_call: [{ command: ["/usr/bin/true", "--pre", "--and-now-something-else"] }] });
    const after = JSON.parse((await runCli(["hooks", "list", "--json"])).stdout) as ListData;
    expect(after.consented).toBe(0);
    expect(after.unconsented).toBe(1);
  });

  it("drops consent for a hook the user removed from the config", async () => {
    writeConfig({ pre_tool_call: [{ command: ["/usr/bin/true", "--a"] }, { command: ["/usr/bin/true", "--b"] }] });
    await runCli(["hooks", "consent", "--json"]);
    writeConfig({ pre_tool_call: [{ command: ["/usr/bin/true", "--a"] }] });
    const data = JSON.parse((await runCli(["hooks", "consent", "--json"])).stdout) as ConsentData;
    expect(data.granted).toBe(1);
    expect(data.revoked).toBe(1);
    const stored = JSON.parse(fs.readFileSync(path.join(home, "hooks-consent.json"), "utf8")) as { consented: string[] };
    expect(stored.consented).toHaveLength(1);
  });

  it("--dry-run names what it would consent to and writes nothing", async () => {
    writeConfig({ pre_tool_call: [{ command: ["/usr/bin/true"] }] });
    const result = await runCli(["hooks", "consent", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as ConsentData;
    expect(data.dryRun).toBe(true);
    expect(data.hooks).toHaveLength(1);
    expect(fs.existsSync(path.join(home, "hooks-consent.json"))).toBe(false);
  });

  it("--dry-run on a profile with no hooks reports nothing to consent to, and still exits 0", async () => {
    writeConfig({});
    const result = await runCli(["hooks", "consent", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, granted: 0, hooks: [] });
  });

  it("refuses to consent to nothing rather than writing an empty record silently", async () => {
    writeConfig({});
    const result = await runCli(["hooks", "consent", "--json"]);
    expect(result.exitCode).toBe(EXIT.CONFIG);
    // `--json` sends the error to stdout as the machine-readable payload, like every other command.
    expect(JSON.parse(result.stdout)).toMatchObject({ error: { operation: "hooks.consent" } });
    expect(result.stdout).toMatch(/hooks/i);
    expect(fs.existsSync(path.join(home, "hooks-consent.json"))).toBe(false);
  });
});
