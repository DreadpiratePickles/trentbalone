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
import { EXIT } from "@trent/core/errors/index.js";
import { runCli } from "../index.js";

const FIXTURE = path.resolve(process.cwd(), "packages/trent-core/src/tools/mcp/__fixtures__/fake-mcp-server.mjs");

let home: string;

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

  it("--dry-run on add writes nothing", async () => {
    const result = await runCli(["mcp", "add", "fake", "--command", "srv", "--dry-run", "--json"]);
    expect(result.exitCode).toBe(EXIT.OK);
    expect(fs.existsSync(path.join(home, "config.yaml"))).toBe(false);
  });
});
