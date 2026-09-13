/**
 * `mcp`: every configured MCP server's tools as ONE adapter, discovered over the real protocol
 * against a fake stdio server (`__fixtures__/fake-mcp-server.mjs`). Nothing here mocks the SDK.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { McpServersConfig } from "../../config/schema.js";
import { SUMMARY_LIMIT } from "../spillover.js";
import { isBuiltinToolName } from "../tool-names.js";
import { mcpToolName, MCP_SERVER_NAME_PATTERN, resolveTemplate } from "./config.js";
import { createMcpAdapters, MCP_ADAPTER_NAME, MCP_STATUS_TOOL, type McpAdapterBuild } from "./index.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "fake-mcp-server.mjs");

let root = "";
let profileDir = "";
const builds: McpAdapterBuild[] = [];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-"));
  profileDir = path.join(root, "profile");
  fs.mkdirSync(profileDir, { recursive: true });
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

afterEach(async () => {
  for (const build of builds.splice(0)) for (const adapter of build.adapters) await adapter.cleanup();
});

/** A host env with a canary that must never reach the child, plus the source of a declared var. */
const HOST_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  CANARY_HOST_VAR: "must-not-leak",
  OPENAI_API_KEY: "sk-must-not-leak-either",
  SOURCE_VAR: "resolved-at-connect",
};

function stdioServer(extra: Partial<Extract<McpServersConfig[string], { transport: "stdio" }>> = {}): McpServersConfig[string] {
  return { transport: "stdio", command: process.execPath, args: [FIXTURE], env: {}, auto_approve: [], enabled: true, ...extra };
}

async function build(servers: McpServersConfig, env: NodeJS.ProcessEnv = HOST_ENV): Promise<McpAdapterBuild> {
  const built = await createMcpAdapters({ mcp_servers: servers }, { profileDir, env });
  builds.push(built);
  return built;
}

describe("names", () => {
  it("server names follow the pattern and tools are exposed as mcp_<server>_<tool>", () => {
    expect(MCP_SERVER_NAME_PATTERN.test("fake")).toBe(true);
    expect(MCP_SERVER_NAME_PATTERN.test("Fake")).toBe(false);
    expect(MCP_SERVER_NAME_PATTERN.test("a")).toBe(false);
    expect(mcpToolName("fake", "env-names")).toBe("mcp_fake_env_names");
    expect(isBuiltinToolName(mcpToolName("fake", "echo"))).toBe(false);
  });

  it("resolves ${VAR} references from the given env and reports missing ones by name only", () => {
    expect(resolveTemplate("Bearer ${SOURCE_VAR}", HOST_ENV)).toEqual({ value: "Bearer resolved-at-connect", missing: [] });
    expect(resolveTemplate("${NOPE}", HOST_ENV)).toEqual({ value: "", missing: ["NOPE"] });
    expect(resolveTemplate("plain", HOST_ENV)).toEqual({ value: "plain", missing: [] });
  });
});

describe("discovery over stdio", () => {
  it("connects, lists the server's tools under namespaced names and carries the JSON schema", async () => {
    const { adapters, unavailable } = await build({ fake: stdioServer() });
    expect(unavailable).toEqual([]);
    expect(adapters).toHaveLength(1);
    const a = adapters[0]!;
    expect(a.name).toBe(MCP_ADAPTER_NAME);
    expect(a.availability).toBe("real");
    expect(a.scopes).toEqual(expect.arrayContaining([MCP_STATUS_TOOL, "mcp_fake_echo", "mcp_fake_env_names", "mcp_fake_big", "mcp_fake_boom"]));
    expect(a.instructions).toContain("mcp_fake_echo");
    expect(a.instructions).toContain("text (string, required)");
    expect(a.routingText).toContain("mcp_fake_echo");
    expect(await a.healthCheck()).toBe("connected");
  });

  it("calls a tool and returns its text content", async () => {
    const { adapters } = await build({ fake: stdioServer() });
    const rec = await adapters[0]!.execute('mcp_fake_echo {"text":"hi"}', {});
    expect(rec.status).toBe("completed");
    expect(rec.summary).toBe("echo: hi");
    const boom = await adapters[0]!.execute("mcp_fake_boom {}", {});
    expect(boom.status).toBe("failed");
    expect(boom.summary).toContain("it broke");
  });

  it("a result over the summary limit is spilled to the profile cache", async () => {
    const { adapters } = await build({ fake: stdioServer() });
    const rec = await adapters[0]!.execute(`mcp_fake_big {"chars":${SUMMARY_LIMIT + 5000}}`, {});
    expect(rec.status).toBe("completed");
    expect(rec.summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    const spilled = /full text saved to (\S+)/.exec(rec.summary)?.[1];
    expect(spilled && fs.existsSync(spilled)).toBe(true);
    expect(fs.readFileSync(spilled!, "utf8").length).toBe(SUMMARY_LIMIT + 5000);
  });
});

describe("approval floor", () => {
  it("every MCP tool requires approval unless the server whitelists it in auto_approve", async () => {
    const { adapters } = await build({ fake: stdioServer({ auto_approve: ["echo"] }) });
    const a = adapters[0]!;
    expect(a.requiresApproval('mcp_fake_echo {"text":"x"}')).toBe(false);
    expect(a.requiresApproval('mcp_fake_big {"chars":1}')).toBe(true);
    expect(a.requiresApproval(`${MCP_STATUS_TOOL} {}`)).toBe(false);
    const dry = await a.dryRun!('mcp_fake_big {"chars":1}', {});
    expect(dry.status).toBe("needs_approval");
  });
});

describe("env scrubbing", () => {
  it("the child sees the scrubbed host env plus only the declared vars, resolved at connect time", async () => {
    const { adapters } = await build({ fake: stdioServer({ env: { DECLARED_VAR: "${SOURCE_VAR}" } }) });
    const rec = await adapters[0]!.execute("mcp_fake_env_names {}", {});
    expect(rec.status).toBe("completed");
    const seen = JSON.parse(rec.summary) as { names: string[]; declared: string | null };
    expect(seen.names).not.toContain("CANARY_HOST_VAR");
    expect(seen.names).not.toContain("OPENAI_API_KEY");
    expect(seen.names).not.toContain("SOURCE_VAR");
    expect(seen.names).toContain("PATH");
    expect(seen.declared).toBe("resolved-at-connect");
  });

  it("a declared var whose ${SOURCE} is unset makes the server unavailable, naming the var, never a value", async () => {
    const { adapters, unavailable } = await build({ fake: stdioServer({ env: { DECLARED_VAR: "${MISSING_SOURCE}" } }) });
    expect(unavailable).toEqual([{ name: "fake", reason: expect.stringContaining("MISSING_SOURCE") }]);
    expect(adapters[0]!.scopes).not.toContain("mcp_fake_echo");
  });
});

describe("unavailable servers", () => {
  it("a server that fails to connect is listed as unavailable with the reason, and the rest still work", async () => {
    const { adapters, unavailable } = await build({
      dead: stdioServer({ args: [FIXTURE, "--crash"] }),
      fake: stdioServer(),
    });
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]!.name).toBe("dead");
    expect(unavailable[0]!.reason.length).toBeGreaterThan(0);
    const a = adapters[0]!;
    expect(a.scopes).toContain("mcp_fake_echo");
    expect(a.scopes).not.toContain("mcp_dead_echo");
    const status = await a.execute(`${MCP_STATUS_TOOL} {}`, {});
    expect(status.summary).toContain("dead: unavailable");
    expect(status.summary).toContain("fake: connected");
  });

  it("an http server with no egress transport is unavailable, and a private URL is refused by the SSRF floor", async () => {
    const { unavailable } = await build({
      remote: { transport: "http", url: "https://mcp.example.com/mcp", headers: {}, auto_approve: [], enabled: true },
    });
    const fetchImpl: typeof fetch = async () => new Response("unreachable", { status: 503 });
    const inside = await createMcpAdapters(
      { mcp_servers: { inside: { transport: "http", url: "http://127.0.0.1:9/mcp", headers: {}, auto_approve: [], enabled: true } } },
      { profileDir, env: HOST_ENV, fetchImpl },
    );
    builds.push(inside);
    unavailable.push(...inside.unavailable);
    const byName = Object.fromEntries(unavailable.map((u) => [u.name, u.reason]));
    expect(byName.remote).toMatch(/egress/i);
    expect(byName.inside).toMatch(/private|loopback|refused/i);
  });

  it("a disabled server is skipped and reported", async () => {
    const { adapters, unavailable } = await build({ fake: stdioServer({ enabled: false }) });
    expect(unavailable).toEqual([{ name: "fake", reason: "disabled in config" }]);
    expect(adapters[0]!.availability).toBe("unavailable");
  });

  it("with no servers configured the adapter is unavailable but still answers mcp_status", async () => {
    const { adapters } = await build({});
    expect(adapters[0]!.availability).toBe("unavailable");
    const rec = await adapters[0]!.execute(`${MCP_STATUS_TOOL} {}`, {});
    expect(rec.status).toBe("completed");
    expect(rec.summary).toContain("no MCP servers configured");
  });
});
