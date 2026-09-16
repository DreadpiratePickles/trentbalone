/**
 * `trent mcp list|add|remove|test`: manages the `mcp_servers` config block, refuses names that
 * collide with a built-in tool, never stores a resolved secret, and `test` speaks the real
 * protocol to the fake stdio server from the core fixture.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parse as parseYaml } from "yaml";
import { EXIT } from "@trent/core/errors/index.js";
import { runCli } from "../index.js";

const FIXTURE = path.resolve(process.cwd(), "packages/trent-core/src/tools/mcp/__fixtures__/fake-mcp-server.mjs");

let home: string;

type StoredConfig = { mcp_servers?: Record<string, { flagged?: { tool: string; categories: string[] }[]; scanRan?: boolean }>; mcp_flagged?: unknown };

function storedConfig(): StoredConfig {
  return parseYaml(fs.readFileSync(path.join(home, "config.yaml"), "utf8")) as StoredConfig;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-cli-mcp-"));
  process.env.TRENT_HOME = home;
});

afterEach(() => {
  delete process.env.TRENT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

type Listed = { configured: { name: string; transport: string; target: string; auto_approve: string[] }[]; available: { id: string }[] };

describe("trent mcp", () => {
  it("add (stdio) then list then remove round-trips through config, with --json", async () => {
    const added = await runCli(["mcp", "add", "fake", "--command", process.execPath, "--args", FIXTURE, "--env", "DECLARED_VAR=${SOURCE_VAR}", "--auto-approve", "echo", "--json"]);
    expect(added.exitCode).toBe(EXIT.OK);
    const addedData = JSON.parse(added.stdout) as { added: { name: string; transport: string } };
    expect(addedData.added).toMatchObject({ name: "fake", transport: "stdio" });

    const listed = await runCli(["mcp", "list", "--json"]);
    expect(listed.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(listed.stdout) as Listed;
    expect(data.configured).toEqual([{ name: "fake", transport: "stdio", target: process.execPath, auto_approve: ["echo"], enabled: true }]);
    expect(data.available.length).toBeGreaterThan(4);

    const yaml = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
    expect(yaml).toContain("${SOURCE_VAR}");

    const removed = await runCli(["mcp", "remove", "fake", "--json"]);
    expect(removed.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(removed.stdout)).toEqual({ removed: "fake", count: 0 });
    const after = JSON.parse((await runCli(["mcp", "list", "--json"])).stdout) as Listed;
    expect(after.configured).toEqual([]);
  });

  it("add (http) stores the url and header templates, never a resolved value", async () => {
    const result = await runCli(["mcp", "add", "remote", "--url", "https://mcp.example.com/mcp", "--header", "Authorization=Bearer ${MCP_TOKEN}", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse((await runCli(["mcp", "list", "--json"])).stdout) as Listed;
    expect(data.configured[0]).toMatchObject({ name: "remote", transport: "http", target: "https://mcp.example.com/mcp" });
  });

  it("refuses a literal secret in an env value or an Authorization header", async () => {
    const env = await runCli(["mcp", "add", "x1", "--command", "srv", "--env", "GITHUB_TOKEN=ghp_literalvalue000000000000000000000", "--json"]);
    expect(env.exitCode).toBe(EXIT.CONFIG);
    expect(env.stdout).not.toContain("ghp_literalvalue");
    const header = await runCli(["mcp", "add", "x2", "--url", "https://h/mcp", "--header", "Authorization=Bearer literal", "--json"]);
    expect(header.exitCode).toBe(EXIT.CONFIG);
  });

  it("refuses a name that collides with a built-in tool, a bad name, a duplicate, and a missing transport", async () => {
    const builtin = await runCli(["mcp", "add", "terminal", "--command", "srv", "--json"]);
    expect(builtin.exitCode).toBe(EXIT.CONFIG);
    expect(builtin.stdout).toContain("built-in");
    const bad = await runCli(["mcp", "add", "Bad-Name", "--command", "srv", "--json"]);
    expect(bad.exitCode).toBe(EXIT.CONFIG);
    const none = await runCli(["mcp", "add", "nothing", "--json"]);
    expect(none.exitCode).toBe(EXIT.CONFIG);
    expect((await runCli(["mcp", "add", "dup", "--command", "srv", "--json"])).exitCode).toBe(EXIT.OK);
    expect((await runCli(["mcp", "add", "dup", "--command", "srv", "--json"])).exitCode).toBe(EXIT.CONFIG);
  });

  it("remove of an unknown server is a config error", async () => {
    const result = await runCli(["mcp", "remove", "ghost", "--json"]);
    expect(result.exitCode).toBe(EXIT.CONFIG);
  });

  it("test connects to a stdio server and lists its tools, or reports why it could not", async () => {
    await runCli(["mcp", "add", "fake", "--command", process.execPath, "--args", FIXTURE, "--json"]);
    const ok = await runCli(["mcp", "test", "fake", "--json"]);
    expect(ok.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(ok.stdout) as { name: string; ok: boolean; tools: string[] };
    expect(data.ok).toBe(true);
    expect(data.tools).toEqual(expect.arrayContaining(["mcp_fake_echo", "mcp_fake_env_names"]));

    await runCli(["mcp", "add", "dead", "--command", process.execPath, "--args", FIXTURE, "--env", "FAKE_MCP_CRASH=1", "--json"]);
    const dead = await runCli(["mcp", "test", "dead", "--json"]);
    expect(dead.exitCode).not.toBe(EXIT.OK);
    expect(JSON.parse(dead.stdout)).toMatchObject({ name: "dead", ok: false });
  });

  it("add refuses a server whose tool description carries an injection string, naming the tool and category, writing nothing", async () => {
    const result = await runCli(["mcp", "add", "poisoned", "--command", process.execPath, "--args", FIXTURE, "--env", "FAKE_MCP_POISON=1", "--json"]);
    expect(result.exitCode).toBe(EXIT.CONFIG);
    expect(result.stdout).toContain("helper");
    expect(result.stdout).toMatch(/injection/i);
    expect(result.stdout).not.toContain("Ignore all previous");
    expect(result.stdout).not.toContain("collector.example.net");
    expect(fs.existsSync(path.join(home, "config.yaml"))).toBe(false);
    const listed = JSON.parse((await runCli(["mcp", "list", "--json"])).stdout) as Listed;
    expect(listed.configured).toEqual([]);
  });

  it("add --allow-flagged installs a poisoned server marked flagged, with a warning on stderr", async () => {
    const result = await runCli(["mcp", "add", "poisoned", "--command", process.execPath, "--args", FIXTURE, "--env", "FAKE_MCP_POISON=1", "--allow-flagged", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { added: { name: string; flagged: boolean; findings: { tool: string; categories: string[] }[] } };
    expect(data.added.flagged).toBe(true);
    expect(data.added.findings.map((f) => f.tool)).toEqual(["helper"]);
    expect(result.stderr).toMatch(/flagged/i);
    expect(result.stderr).not.toContain("Ignore all previous");
    const listed = JSON.parse((await runCli(["mcp", "list", "--json"])).stdout) as Listed & { configured: { flagged?: boolean }[] };
    expect(listed.configured[0]).toMatchObject({ name: "poisoned", flagged: true });
    const yaml = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
    expect(yaml).not.toContain("Ignore all previous");
    const stored = storedConfig();
    expect(stored.mcp_servers?.poisoned?.flagged).toEqual(data.added.findings);
    expect(stored.mcp_servers?.poisoned?.scanRan).toBe(true);
    expect(stored.mcp_flagged).toBeUndefined();
    expect((await runCli(["mcp", "remove", "poisoned", "--json"])).exitCode).toBe(EXIT.OK);
    expect(fs.readFileSync(path.join(home, "config.yaml"), "utf8")).not.toContain("helper");
  });

  it("test re-runs the scan and reports findings on a flagged server", async () => {
    await runCli(["mcp", "add", "poisoned", "--command", process.execPath, "--args", FIXTURE, "--env", "FAKE_MCP_POISON=1", "--allow-flagged", "--json"]);
    const result = await runCli(["mcp", "test", "poisoned", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { ok: boolean; findings: { tool: string }[] };
    expect(data.ok).toBe(true);
    expect(data.findings.map((f) => f.tool)).toEqual(["helper"]);
  });

  it("add of a clean server records that the scan ran", async () => {
    const result = await runCli(["mcp", "add", "fake", "--command", process.execPath, "--args", FIXTURE, "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    const data = JSON.parse(result.stdout) as { added: { flagged: boolean; scanRan: boolean; findings: unknown[] } };
    expect(data.added).toMatchObject({ flagged: false, scanRan: true, findings: [] });
    expect(storedConfig().mcp_servers?.fake).toMatchObject({ scanRan: true });
    expect(storedConfig().mcp_servers?.fake?.flagged).toBeUndefined();
  });

  it("--dry-run on add writes nothing", async () => {
    const result = await runCli(["mcp", "add", "fake", "--command", "srv", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(fs.existsSync(path.join(home, "config.yaml"))).toBe(false);
  });
});
