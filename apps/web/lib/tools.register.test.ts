/**
 * The one sanctioned seam in the read-only app: `registerExternalAdapters` appends adapters the
 * wrapper (`packages/trent-core`) builds — file_ops, terminal — to the live registry and resets
 * the semantic router's catalog, so `routeToolsForStep` and the seat loop see them. A module
 * named by `TRENT_TOOL_ADAPTERS_MODULE` is loaded into `buildAdapterRegistry` the same way.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { adapters, buildAdapterRegistry, registerExternalAdapters, type ToolAdapter } from "@/lib/tools";
import { resetSemanticRouterForTests, routeToolsForStep, setSemanticRouterEmbedderForTests } from "@/lib/semantic-router";

function fakeAdapter(name: string, extra: Partial<ToolAdapter & { routingText: string }> = {}): ToolAdapter & { routingText?: string } {
  return {
    name,
    scopes: [name, `${name}:read`],
    availability: "real",
    async healthCheck() {
      return "connected";
    },
    estimateCost: () => 0,
    requiresApproval: () => false,
    async execute(action) {
      return { adapter: name, action, status: "completed", summary: `${name} ran ${action}` };
    },
    ...extra,
  };
}

describe("registerExternalAdapters", () => {
  afterEach(() => {
    registerExternalAdapters([], { remove: ["zebra_tool", "quokka_tool"] });
    setSemanticRouterEmbedderForTests(null);
    resetSemanticRouterForTests();
  });

  it("appends to the live registry array and replaces an adapter registered under the same name", () => {
    const before = adapters.length;
    const first = fakeAdapter("zebra_tool");
    registerExternalAdapters([first]);
    expect(adapters).toContain(first);
    expect(adapters.length).toBe(before + 1);
    const second = fakeAdapter("zebra_tool");
    registerExternalAdapters([second]);
    expect(adapters).toContain(second);
    expect(adapters).not.toContain(first);
    expect(adapters.length).toBe(before + 1);
  });

  it("resets the router catalog so a registered adapter is routable, using its routingText", async () => {
    resetSemanticRouterForTests();
    // Warm the catalog first, then register: the seam must invalidate it.
    await routeToolsForStep("anything", { tools: ["GitHub"] });
    registerExternalAdapters([
      fakeAdapter("quokka_tool", { routingText: "quokka marsupial photo smile wombat island" }),
    ]);
    const ranked = await routeToolsForStep("take a quokka marsupial photo on the island", { tools: ["quokka_tool", "GitHub"] });
    expect(ranked.map((tool) => tool.name)[0]).toBe("quokka_tool");
  });
});

describe("TRENT_TOOL_ADAPTERS_MODULE", () => {
  // next/types/global.d.ts augments ProcessEnv with a required NODE_ENV, so an env literal
  // must carry it to satisfy `AdapterRegistryOptions.env`.
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...extra });
  let dir = "";
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads adapters exported by the module into buildAdapterRegistry", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-adapters-"));
    const file = path.join(dir, "adapters.cjs");
    fs.writeFileSync(
      file,
      `module.exports = { adapters: [{ name: "module_tool", scopes: ["module_tool"], availability: "real",
        healthCheck: async () => "connected", estimateCost: () => 0, requiresApproval: () => false,
        execute: async (action) => ({ adapter: "module_tool", action, status: "completed", summary: "ok" }) }] };`,
    );
    const registry = buildAdapterRegistry({ env: env({ TRENT_TOOL_ADAPTERS_MODULE: file }) });
    expect(registry.map((adapter) => adapter.name)).toContain("module_tool");
  });

  it("falls back to the base registry when the module cannot be loaded", () => {
    const base = buildAdapterRegistry({ env: env() }).length;
    const registry = buildAdapterRegistry({ env: env({ TRENT_TOOL_ADAPTERS_MODULE: "/nonexistent/trent-adapters.cjs" }) });
    expect(registry.length).toBe(base);
  });
});
