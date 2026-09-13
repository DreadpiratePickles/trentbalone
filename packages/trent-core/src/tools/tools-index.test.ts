/** `buildTrentToolAdapters` follows `config.toolsets - config.disabled_toolsets` for the new toolsets. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildTrentToolAdapters, enabledToolsets, IMPLEMENTED_TOOLSETS } from "./index.js";
import { BUILTIN_TOOL_NAMES } from "./tool-names.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-tools-index-"));
const deps = { workspace: root, profileDir: path.join(root, "profile"), backend: "local" as const };
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("buildTrentToolAdapters", () => {
  it("builds code, delegation and plugins only when enabled and not disabled", async () => {
    const all = buildTrentToolAdapters({ toolsets: ["file_ops", "terminal", "code", "delegation", "plugins"], disabled_toolsets: ["terminal"] }, deps);
    expect(all.map((a) => a.name)).toEqual(["file_ops", "code_execution", "delegation", "plugins"]);
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

  it("every adapter scope this builder can produce is a reserved built-in name", () => {
    const built = buildTrentToolAdapters({ toolsets: ["file_ops", "terminal", "code", "delegation", "plugins"], disabled_toolsets: [] }, deps);
    for (const adapter of built) for (const scope of adapter.scopes) expect(BUILTIN_TOOL_NAMES, scope).toContain(scope);
  });
});
