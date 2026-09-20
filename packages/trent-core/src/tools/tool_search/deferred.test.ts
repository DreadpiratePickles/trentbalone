/**
 * U5 — the bridge tells a SURFACE what it is hiding. `trent mcp serve` lists every Trent tool to a
 * host agent, so it needs the deferred set the seat only reaches through `tool_search`; a ranked
 * search with a limit of 40 is not a listing. `deferred()` on the bridge is that listing, and it
 * is the same data `tool_search` ranks, so nothing can be reachable by search and absent here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdempotencyManager } from "../../governance/IdempotencyManager.js";
import { record as toRecord } from "../action.js";
import { buildTrentTools } from "../index.js";
import type { TrentToolAdapter } from "../types.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";
import { isToolBridge } from "./index.js";

let home: string;
let workspace: string;
let profileDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-deferred-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-deferred-ws-"));
  profileDir = path.join(home, "profile");
  fs.mkdirSync(profileDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

function fakeConnector(count: number): TrentToolAdapter {
  const schemas: ToolSchema[] = Array.from({ length: count }, (_, i) => ({
    name: `mcp_acme_job_${String(i).padStart(2, "0")}`,
    description: `Run acme job ${i}.`,
    parameters: { type: "object" as const, properties: { input: { type: "string", description: "Payload." } }, required: ["input"] },
  }));
  return {
    name: "mcp",
    scopes: ["mcp", "mcp_status", ...schemas.map((s) => s.name)],
    availability: "real",
    instructions: renderToolInstructions(schemas),
    routingText: "acme",
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    execute: async (action) => toRecord("mcp", action, "completed", `ran ${action}`),
    cleanup: async () => undefined,
  };
}

describe("the disclosure bridge lists what it defers", () => {
  it("names every deferred tool with its adapter and schema block, and the advertised ones are not in it", async () => {
    const built = buildTrentTools(
      { toolsets: ["file_ops", "terminal"], disabled_toolsets: [] },
      { workspace, profileDir, backend: "local", home, idempotency: new IdempotencyManager({ dir: profileDir }), extraAdapters: [fakeConnector(3)] },
    );
    try {
      const bridge = built.adapters.find(isToolBridge);
      expect(bridge).toBeDefined();
      const deferred = bridge!.deferred();
      const names = deferred.map((tool) => tool.name).sort();
      expect(names).toEqual(["mcp_acme_job_00", "mcp_acme_job_01", "mcp_acme_job_02"]);
      for (const tool of deferred) {
        expect(tool.adapter).toBe("mcp");
        expect(tool.schema).toContain(`${tool.name}: Run acme job`);
      }
      // A restricted bridge (the per-seat view) lists only what that subset still reaches.
      const narrowed = bridge!.restrict((adapter) => adapter.name !== "mcp");
      expect(narrowed.deferred()).toEqual([]);
    } finally {
      for (const adapter of built.adapters) await adapter.cleanup();
    }
  });
});
