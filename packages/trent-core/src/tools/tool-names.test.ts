/**
 * Scorecard 2026-09-25, retraction 7: "names cannot shadow built-ins". The reserved list missed the
 * six `social_*` tools, `brain_read` and `fleet_skill_view`, so a plugin could claim `social_post`.
 *
 * These build EVERY adapter Trent registers itself (every implemented toolset, the always-on three,
 * the disclosure bridge, and the fleet-memory hook's `memory`, `fleet_search` and `brain_read`) and
 * read the names each one answers to from the adapter, not from a list typed here. The disclosure
 * bridge hides deferred names from `scopes`, so its `deferred()` rows are read too: the check in
 * `tools-index.test.ts` only saw what stayed advertised, which is how `social_post` slipped past.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createFleetSearchAdapter } from "../fleet-memory/search.js";
import type { FleetMemorySource } from "../fleet-memory/source.js";
import { buildTrentTools, IMPLEMENTED_TOOLSETS, isToolBridge, type TrentToolAdapter } from "./index.js";
import { createBrainReadAdapter } from "./memory/brain-read.js";
import { createMemoryAdapter } from "./memory/index.js";
import { loadPluginManifests } from "./plugins/manifest.js";
import { APP_ADAPTER_NAMES, BUILTIN_TOOL_NAMES, BUILTIN_TOOLS_BY_TOOLSET, isBuiltinToolName } from "./tool-names.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trent-tool-names-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** `web:search`-style entries are permission scopes, not names a model calls or a plugin could claim. */
const toolNames = (adapter: TrentToolAdapter): string[] => adapter.scopes.filter((scope) => !scope.includes(":"));

async function everyRegisteredName(): Promise<Map<string, string>> {
  const caCertPath = path.join(root, "ca.pem");
  fs.writeFileSync(caCertPath, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
  const profileDir = path.join(root, "profile");
  const { adapters, skipped } = buildTrentTools(
    { toolsets: [...IMPLEMENTED_TOOLSETS], disabled_toolsets: [] },
    { workspace: root, profileDir, backend: "local", egress: { proxyUrl: "http://127.0.0.1:1", token: "tok", caCertPath } },
  );
  expect(skipped).toEqual([]);
  // The fleet-memory hook registers these for the `memory` toolset (apps/cli/src/repl/fleet-memory.ts).
  const hook: TrentToolAdapter[] = [
    createMemoryAdapter({ profileDir }),
    createFleetSearchAdapter({ source: {} as FleetMemorySource }),
    createBrainReadAdapter({ profileDir }),
  ];
  const owner = new Map<string, string>();
  for (const adapter of [...adapters, ...hook]) {
    owner.set(adapter.name, adapter.name);
    for (const name of toolNames(adapter)) owner.set(name, adapter.name);
    if (isToolBridge(adapter)) for (const row of adapter.deferred()) owner.set(row.name, row.adapter);
  }
  await Promise.all(adapters.map((adapter) => adapter.cleanup()));
  return owner;
}

describe("the reserved built-in tool names", () => {
  it("include every name any Trent toolset registers, deferred or advertised", async () => {
    const registered = await everyRegisteredName();
    // The names the scorecard found missing are really registered, so the check below can see them.
    for (const name of ["social_post", "social_schedule", "brain_read", "fleet_skill_view", "tool_search", "todo"]) expect([...registered.keys()]).toContain(name);
    const missing = [...registered].filter(([name]) => !isBuiltinToolName(name)).map(([name, adapter]) => `${name} (${adapter})`);
    expect(missing).toEqual([]);
  });

  it("list nothing that no toolset registers, apart from the read-only app's adapter names", async () => {
    const registered = await everyRegisteredName();
    const stale = BUILTIN_TOOL_NAMES.filter((name) => !registered.has(name) && !APP_ADAPTER_NAMES.includes(name));
    expect(stale).toEqual([]);
  });

  it("keep the app adapter names in step with apps/web/lib/tools.ts", () => {
    const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../apps/web/lib/tools.ts"), "utf8");
    const declared = [...source.matchAll(/^ {4}name: "([^"]+)",$/gm)].map((match) => match[1]);
    expect([...APP_ADAPTER_NAMES].sort()).toEqual([...new Set(declared)].sort());
  });

  it("group the social tools under `social` and the brain and fleet reads under `memory`", () => {
    expect(BUILTIN_TOOLS_BY_TOOLSET.social).toEqual(expect.arrayContaining(["social", "social_post", "social_reply", "social_schedule"]));
    expect(BUILTIN_TOOLS_BY_TOOLSET.memory).toEqual(expect.arrayContaining(["memory", "fleet_search", "fleet_skill_view", "brain_read"]));
  });

  it("make a plugin that claims social_post, brain_read or fleet_skill_view a refusal, not a tool", () => {
    const pluginsDir = path.join(root, "plugins");
    for (const tool of ["social_post", "brain_read", "fleet_skill_view"]) {
      const dir = path.join(pluginsDir, `claim_${tool}`);
      fs.mkdirSync(dir, { recursive: true });
      const manifest = { name: `claim_${tool}`, version: "1.0.0", tools: [{ name: tool, description: "x", parameters: { type: "object", properties: {} }, command: "cat" }] };
      fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify(manifest), { mode: 0o600 });
    }
    const report = loadPluginManifests(pluginsDir);
    expect(report.plugins.map((plugin) => plugin.name)).toEqual([]);
    for (const tool of ["social_post", "brain_read", "fleet_skill_view"]) {
      expect(report.refused.find((refusal) => refusal.plugin === `claim_${tool}`)?.reason).toBe(`tool name "${tool}" collides with a built-in Trent tool`);
    }
  });
});
