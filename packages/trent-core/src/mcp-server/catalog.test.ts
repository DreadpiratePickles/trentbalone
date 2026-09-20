/**
 * U5 — the tool list a host sees is derived from the built adapters, never restated: one MCP
 * tool per callable Trent tool, schema from the adapter, advertised and deferred alike. What the
 * catalog leaves out is named: the disclosure bridge's own three tools (the server lists every
 * tool itself) and the two founder-prompt tools whose answer channel is a Trent surface.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdempotencyManager } from "../governance/IdempotencyManager.js";
import { record as toRecord } from "../tools/action.js";
import { buildTrentTools } from "../tools/index.js";
import type { TrentToolAdapter } from "../tools/types.js";
import { renderToolInstructions, type ToolSchema } from "../tools/web/schemas.js";
import { buildToolCatalog, EXCLUDED_ADAPTERS } from "./catalog.js";

let home: string;
let workspace: string;
let profileDir: string;
let built: ReturnType<typeof buildTrentTools> | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-catalog-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-mcp-catalog-ws-"));
  profileDir = path.join(home, "profile");
  fs.mkdirSync(profileDir, { recursive: true });
});

afterEach(async () => {
  for (const adapter of built?.adapters ?? []) await adapter.cleanup();
  built = undefined;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

function connector(count: number): TrentToolAdapter {
  const schemas: ToolSchema[] = Array.from({ length: count }, (_, i) => ({
    name: `mcp_acme_job_${i}`,
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

describe("buildToolCatalog", () => {
  it("lists every callable tool with a schema, routes deferred ones through the bridge, and leaves the bridge and founder prompts out", () => {
    built = buildTrentTools(
      { toolsets: ["file_ops", "terminal", "human"], disabled_toolsets: [] },
      { workspace, profileDir, backend: "local", home, idempotency: new IdempotencyManager({ dir: profileDir }), extraAdapters: [connector(2)] },
    );
    const catalog = buildToolCatalog(built.adapters);
    const names = catalog.map((tool) => tool.name);
    for (const expected of ["read_file", "write_file", "patch", "search_files", "terminal", "process_manage", "todo", "session_search", "mcp_acme_job_0", "mcp_acme_job_1"]) {
      expect(names, `missing ${expected}`).toContain(expected);
    }
    for (const absent of ["tool_search", "tool_describe", "tool_call", "ask_human", "clarify", "file_ops", "tools", "human"]) {
      expect(names, `${absent} must not be listed`).not.toContain(absent);
    }
    expect(new Set(names).size).toBe(names.length);
    for (const tool of catalog) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(0);
    }
    const job = catalog.find((tool) => tool.name === "mcp_acme_job_0")!;
    expect(job.via).toBe("bridge");
    expect(job.adapter).toBe("mcp");
    expect(job.inputSchema.required).toEqual(["input"]);
    const terminal = catalog.find((tool) => tool.name === "terminal")!;
    expect(terminal.via).toBe("direct");
    expect(terminal.target.name).toBe("terminal");
    expect(EXCLUDED_ADAPTERS).toContain("human");
  });

  it("carries a promoted description over the shipped one, because that is what the seat reads too", () => {
    built = buildTrentTools(
      { toolsets: ["file_ops"], disabled_toolsets: [] },
      {
        workspace,
        profileDir,
        backend: "local",
        home,
        idempotency: new IdempotencyManager({ dir: profileDir }),
        toolOverrides: [{ tool: "todo", description: "Keep the run's task list current; one line per item.", draftId: "draft_1", promotedAt: "2026-09-20T00:00:00.000Z" }],
      },
    );
    const todo = buildToolCatalog(built.adapters).find((tool) => tool.name === "todo");
    expect(todo?.description).toBe("Keep the run's task list current; one line per item.");
  });
});
