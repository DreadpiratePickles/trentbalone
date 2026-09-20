/**
 * U5 — the static answer to "which MCP tool names does the server expose for a toolset", which
 * `fleet export --target claude` writes into a subagent's `tools:` line without building a runtime.
 * It is held to the live catalog: every toolset that can be built here without a proxy is built,
 * served through `buildToolCatalog`, and the names must be exactly the table's.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBrainReadAdapter } from "../tools/memory/brain-read.js";
import { createMemoryAdapter } from "../tools/memory/index.js";
import { IdempotencyManager } from "../governance/IdempotencyManager.js";
import { buildTrentTools, IMPLEMENTED_TOOLSETS } from "../tools/index.js";
import { buildToolCatalog } from "./catalog.js";
import type { Toolset } from "../config/schema.js";
import { MCP_TOOLS_BY_TOOLSET, mcpToolNamesFor } from "./toolset-tools.js";

let home: string;
let workspace: string;
let profileDir: string;
let built: ReturnType<typeof buildTrentTools> | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-toolset-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-toolset-ws-"));
  profileDir = path.join(home, "profile");
  fs.mkdirSync(profileDir, { recursive: true });
});

afterEach(async () => {
  for (const adapter of built?.adapters ?? []) await adapter.cleanup();
  built = undefined;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("MCP_TOOLS_BY_TOOLSET", () => {
  it("matches the live catalog for every toolset that builds without the egress proxy, plus the memory adapters", () => {
    const toolsets = ["file_ops", "terminal", "code", "delegation", "cron", "skills", "plugins", "vision", "mcp", "human"] as const;
    built = buildTrentTools(
      { toolsets: [...toolsets], disabled_toolsets: [], tools: { disclosure_threshold: 1000 } },
      {
        workspace,
        profileDir,
        backend: "local",
        home,
        idempotency: new IdempotencyManager({ dir: profileDir }),
        extraAdapters: [createMemoryAdapter({ profileDir }), createBrainReadAdapter({ profileDir })],
      },
    );
    const live = buildToolCatalog(built.adapters);
    const byAdapter = new Map<string, string[]>();
    for (const tool of live) byAdapter.set(tool.adapter, [...(byAdapter.get(tool.adapter) ?? []), tool.name]);
    const adapterOf: Record<string, string> = { code: "code_execution" };
    for (const toolset of toolsets) {
      const expected = [...(byAdapter.get(adapterOf[toolset] ?? toolset) ?? [])].sort();
      expect([...MCP_TOOLS_BY_TOOLSET[toolset]].sort(), toolset).toEqual(expected);
    }
    const memory = [...(byAdapter.get("memory") ?? []), ...(byAdapter.get("brain_read") ?? [])].sort();
    expect([...MCP_TOOLS_BY_TOOLSET.memory].filter((name) => !name.startsWith("fleet_")).sort()).toEqual(memory);
    expect(MCP_TOOLS_BY_TOOLSET.memory).toContain("fleet_search");
    expect(MCP_TOOLS_BY_TOOLSET.human).toEqual([]);
  });

  it("has an entry for every toolset the builder implements, so a new toolset cannot be unlisted silently", () => {
    for (const toolset of [...IMPLEMENTED_TOOLSETS, "memory"] as Toolset[]) expect(MCP_TOOLS_BY_TOOLSET[toolset], toolset).toBeDefined();
  });

  it("names the tools of a seat's toolsets in one sorted list, with the always-on wrapper tools", () => {
    const names = mcpToolNamesFor(["terminal", "memory"]);
    expect(names).toEqual([...names].sort());
    for (const expected of ["terminal", "process_manage", "memory", "fleet_search", "brain_read", "todo", "session_search"]) expect(names).toContain(expected);
    expect(names).not.toContain("read_file");
    expect(mcpToolNamesFor(["web"])).toEqual(["session_search", "todo", "web_extract", "web_search"]);
  });
});
