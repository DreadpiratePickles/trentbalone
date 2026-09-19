/** `buildTrentToolAdapters` follows `config.toolsets - config.disabled_toolsets` for the new toolsets. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ALWAYS_ON_ADAPTERS, buildTrentToolAdapters, buildTrentTools, enabledToolsets, IMPLEMENTED_TOOLSETS, NOT_YET_IMPLEMENTED } from "./index.js";
import { TOOL_BRIDGE_ADAPTER_NAME } from "./tool_search/index.js";
import { ToolsetSchema } from "../config/schema.js";
import { BUILTIN_TOOL_NAMES } from "./tool-names.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-tools-index-"));
const deps = { workspace: root, profileDir: path.join(root, "profile"), backend: "local" as const };
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/**
 * The adapters `config.toolsets` decides. A3 also registers `todo`, `clarify` and `session_search`
 * on every build and, past the disclosure threshold, the `tools` bridge; none of those is a
 * toolset, so the toolset assertions below read through this filter rather than restating them.
 */
function toolsetAdapters(adapters: readonly { name: string }[]): string[] {
  const extra = new Set<string>([...ALWAYS_ON_ADAPTERS, TOOL_BRIDGE_ADAPTER_NAME]);
  return adapters.map((a) => a.name).filter((name) => !extra.has(name));
}

describe("buildTrentToolAdapters", () => {
  it("builds code, delegation and plugins only when enabled and not disabled", async () => {
    const all = buildTrentToolAdapters({ toolsets: ["file_ops", "terminal", "code", "delegation", "plugins"], disabled_toolsets: ["terminal"] }, deps);
    expect(toolsetAdapters(all)).toEqual(["file_ops", "code_execution", "delegation", "plugins"]);
    // A3: the three always-on tools are there too, whatever `toolsets` says.
    expect(all.map((a) => a.name)).toEqual(expect.arrayContaining([...ALWAYS_ON_ADAPTERS]));
    expect(enabledToolsets({ toolsets: ["code", "plugins"], disabled_toolsets: ["plugins"] })).toEqual(["code"]);
    expect(IMPLEMENTED_TOOLSETS).toEqual(expect.arrayContaining(["code", "delegation", "plugins"]));
    const delegation = all.find((a) => a.name === "delegation")!;
    expect(delegation.availability).toBe("unavailable");
    expect((await delegation.execute('delegate_task {"goal":"x"}', {})).summary).toContain("not_available");
    await Promise.all(all.map((a) => a.cleanup()));
  });

  it("binds an injected delegate port and plugins dir", async () => {
    const port = { delegate: async () => ({ status: "completed" as const, output: "child says hi" }) };
    const pluginsDir = path.join(root, "custom-plugins");
    const built = buildTrentToolAdapters({ toolsets: ["delegation", "plugins"], disabled_toolsets: [] }, { ...deps, delegate: port, pluginsDir });
    const delegation = built.find((a) => a.name === "delegation")!;
    expect(delegation.availability).toBe("real");
    expect((await delegation.execute('delegate_task {"goal":"x"}', {})).summary).toContain("child says hi");
    await Promise.all(built.map((a) => a.cleanup()));
  });

  it("every tool name this builder can produce is a reserved built-in name", async () => {
    const caCertPath = path.join(root, "ca-scopes.pem");
    fs.writeFileSync(caCertPath, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
    const { adapters, skipped } = buildTrentTools(
      { toolsets: [...IMPLEMENTED_TOOLSETS], disabled_toolsets: [] },
      { ...deps, egress: { proxyUrl: "http://127.0.0.1:1", token: "tok", caCertPath } },
    );
    expect(skipped).toEqual([]);
    expect(toolsetAdapters(adapters)).toEqual(["file_ops", "terminal", "web", "code_execution", "delegation", "cron", "skills", "plugins", "browser", "vision", "mcp", "human"]);
    // Past `tools.disclosure_threshold` the bridges are registered and the deferred names leave
    // the advertised scopes; every name that is still advertised is still a reserved built-in.
    expect(adapters.map((a) => a.name)).toContain(TOOL_BRIDGE_ADAPTER_NAME);
    // `web:search`-style entries are permission scopes, not tool names a plugin could shadow.
    for (const adapter of adapters) for (const scope of adapter.scopes.filter((s) => !s.includes(":"))) expect(BUILTIN_TOOL_NAMES, scope).toContain(scope);
    await Promise.all(adapters.map((a) => a.cleanup()));
  });
});

describe("buildTrentToolAdapters wires web, skills and cron", () => {
  it("returns the three adapters with the Hermes tool names when egress is present", async () => {
    const caCertPath = path.join(root, "ca.pem");
    fs.writeFileSync(caCertPath, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
    const built = buildTrentToolAdapters(
      { toolsets: ["web", "skills", "cron"], disabled_toolsets: [] },
      { ...deps, egress: { proxyUrl: "http://127.0.0.1:1", token: "tok", caCertPath } },
    );
    expect(toolsetAdapters(built)).toEqual(["web", "skills", "cron"]);
    const scopes = built.flatMap((a) => a.scopes);
    for (const name of ["web_search", "web_extract", "skills_list", "skill_view", "skill_manage", "cronjob_manage"]) {
      expect(scopes, name).toContain(name);
    }
    await Promise.all(built.map((a) => a.cleanup()));
  });

  it("skips web with a visible reason when there is no egress, and never registers memory here", async () => {
    const { adapters, skipped } = buildTrentTools({ toolsets: ["web", "skills", "cron", "memory"], disabled_toolsets: [] }, deps);
    expect(toolsetAdapters(adapters)).toEqual(["skills", "cron"]);
    expect(skipped.map((s) => s.toolset)).toEqual(["web", "memory"]);
    expect(skipped[0]?.reason).toMatch(/egress/i);
    expect(skipped[1]?.reason).toMatch(/fleet[- ]memory/i);
    await Promise.all(adapters.map((a) => a.cleanup()));
  });

  it("every ToolsetSchema value is implemented or explicitly not-yet-implemented with a reason", () => {
    const implemented = new Set<string>(IMPLEMENTED_TOOLSETS);
    const pending = new Map<string, string>(NOT_YET_IMPLEMENTED.map((entry) => [entry.toolset, entry.reason]));
    for (const toolset of ToolsetSchema.options) {
      const known = implemented.has(toolset) || pending.has(toolset);
      expect(known, `${toolset} is neither implemented nor listed in NOT_YET_IMPLEMENTED`).toBe(true);
      expect(implemented.has(toolset) && pending.has(toolset), `${toolset} is in both lists`).toBe(false);
      if (pending.has(toolset)) expect(pending.get(toolset)?.length ?? 0).toBeGreaterThan(10);
    }
    for (const toolset of [...implemented, ...pending.keys()]) expect(ToolsetSchema.options as readonly string[]).toContain(toolset);
  });
});

describe("buildTrentToolAdapters wires human", () => {
  it("builds the ask_human adapter when the human toolset is enabled, and the config schema knows the toolset", async () => {
    expect(ToolsetSchema.options).toContain("human");
    const built = buildTrentToolAdapters({ toolsets: ["human"], disabled_toolsets: [] }, deps);
    expect(toolsetAdapters(built)).toEqual(["human"]);
    expect(built[0]!.scopes).toEqual(["human", "ask_human"]);
    expect(built[0]!.requiresApproval('ask_human {"question":"Which region first?"}')).toBe(true);
    await Promise.all(built.map((a) => a.cleanup()));
  });
});
