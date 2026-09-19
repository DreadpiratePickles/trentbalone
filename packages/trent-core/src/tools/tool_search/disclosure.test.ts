/**
 * A3 — progressive tool disclosure.
 *
 * The defect this is about: a catalog of MCP, plugin and app-registered tools is rendered into
 * every seat prompt in full, so forty connector tools cost forty schemas of context on every turn
 * whether or not the seat touches one. Disclosure hides those names behind three bridges and
 * proves that hiding them takes nothing away: `tool_call` goes through the SAME wrapper chain a
 * direct call goes through, so no gate can be bypassed by routing around the advertised list.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import { TrentConfigSchema } from "../../config/schema.js";
import { IdempotencyManager } from "../../governance/IdempotencyManager.js";
import { record as toRecord } from "../action.js";
import { adaptersForSeat, buildTrentTools } from "../index.js";
import type { TrentToolAdapter } from "../types.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";
import { DEFAULT_DISCLOSURE_THRESHOLD, TOOL_BRIDGE_ADAPTER_NAME, TOOL_BRIDGE_SCOPES } from "./index.js";

let home: string;
let workspace: string;
let profileDir: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "trent-disclosure-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "trent-disclosure-ws-"));
  profileDir = path.join(home, "profile");
  fs.mkdirSync(profileDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

const LEDGER_TOOL = "mcp__acme__expense_receipt_ledger";

/** Forty tools on one MCP server, the shape `createMcpAdapter` produces after `tools/list`. */
function fakeMcpAdapter(count = 40): TrentToolAdapter {
  const schemas: ToolSchema[] = Array.from({ length: count }, (_, i) => ({
    name: i === 7 ? LEDGER_TOOL : `mcp__acme__task_${String(i).padStart(2, "0")}`,
    description:
      i === 7
        ? "File an expense receipt against the accounting ledger and return the posted entry id."
        : `Run acme workflow number ${i} and return its identifier.`,
    parameters: {
      type: "object" as const,
      properties: { input: { type: "string", description: "Serialized workflow payload." } },
      required: ["input"],
    },
  }));
  const names = schemas.map((schema) => schema.name);
  return {
    name: "mcp",
    scopes: ["mcp", "mcp_status", ...names],
    availability: "real",
    instructions: renderToolInstructions(schemas),
    routingText: `acme connector: ${names.join(", ")}`,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    execute: async (action) => toRecord("mcp", action, "completed", `acme ran ${action}`),
    cleanup: async () => undefined,
  };
}

function build(extra: readonly TrentToolAdapter[], config: Record<string, unknown> = {}) {
  return buildTrentTools(
    { toolsets: ["file_ops", "terminal"], disabled_toolsets: [], ...config },
    {
      workspace,
      profileDir,
      backend: "local",
      home,
      idempotency: new IdempotencyManager({ dir: profileDir }),
      extraAdapters: extra,
    },
  );
}

/** What a seat's environment advertises: every adapter name and every scope (`seat-wiring.ts`). */
function advertised(adapters: readonly TrentToolAdapter[]): string[] {
  return adapters.flatMap((adapter) => [adapter.name, ...adapter.scopes]);
}

function bridgeOf(adapters: readonly TrentToolAdapter[]): TrentToolAdapter {
  const found = adapters.find((adapter) => adapter.name === TOOL_BRIDGE_ADAPTER_NAME);
  if (!found) throw new Error("the tool bridge was not registered");
  return found;
}

describe("progressive tool disclosure", () => {
  it("ships the same threshold in the config defaults and in the module", () => {
    expect(DEFAULT_CONFIG.tools.disclosure_threshold).toBe(DEFAULT_DISCLOSURE_THRESHOLD);
    expect(TrentConfigSchema.parse({}).tools.disclosure_threshold).toBe(DEFAULT_DISCLOSURE_THRESHOLD);
  });

  it("advertises the bridges and none of the forty MCP tools", () => {
    const { adapters } = build([fakeMcpAdapter()]);
    const names = advertised(adapters);

    for (const scope of TOOL_BRIDGE_SCOPES) expect(names).toContain(scope);
    expect(names.filter((name) => name.startsWith("mcp__acme__"))).toEqual([]);
    // The core toolsets are untouched: disclosure hides the catalog, never the seat's own hands.
    expect(names).toContain("read_file");
    expect(names).toContain("terminal");
    // And the hidden names are out of the prompt text too, not merely out of the scope list.
    const mcp = adapters.find((adapter) => adapter.name === "mcp");
    expect(mcp?.instructions).not.toContain(LEDGER_TOOL);
    expect(mcp?.instructions).toContain("tool_search");
  });

  it("leaves a small catalog fully advertised, so disclosure costs nothing when it buys nothing", () => {
    const { adapters } = build([]);
    expect(advertised(adapters)).not.toContain("tool_call");
    expect(adapters.map((adapter) => adapter.name)).toEqual(["file_ops", "terminal", "todo", "clarify", "session_search"]);
  });

  it("ranks the deferred tools lexically over name and description", async () => {
    const { adapters } = build([fakeMcpAdapter()]);
    const result = await bridgeOf(adapters).execute('tool_search {"query":"expense receipt ledger"}', {});

    expect(result.status).toBe("completed");
    const first = result.summary.split("\n").find((line) => line.includes("mcp__acme__"));
    expect(first).toContain(LEDGER_TOOL);
  });

  it("describes a deferred tool with its full schema", async () => {
    const { adapters } = build([fakeMcpAdapter()]);
    const result = await bridgeOf(adapters).execute(`tool_describe {"name":${JSON.stringify(LEDGER_TOOL)}}`, {});

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("Serialized workflow payload.");
    expect(result.summary).toContain("input");
  });

  it("reaches the real tool through tool_call", async () => {
    const { adapters } = build([fakeMcpAdapter()]);
    const result = await bridgeOf(adapters).execute(
      `tool_call {"name":${JSON.stringify(LEDGER_TOOL)},"arguments":{"input":"receipt-9"}}`,
      {},
    );

    expect(result.status).toBe("completed");
    expect(result.summary).toContain("acme ran");
    expect(result.summary).toContain("receipt-9");
  });

  it("refuses a hardline command routed through tool_call", async () => {
    const { adapters } = build([fakeMcpAdapter()]);
    const result = await bridgeOf(adapters).execute(
      'tool_call {"name":"terminal","arguments":{"command":"rm -rf /"}}',
      {},
    );

    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("recursive-delete-of-root-home-or-profile");
  });

  it("answers an unknown tool name with a typed error naming tool_search", async () => {
    const { adapters } = build([fakeMcpAdapter()]);
    const result = await bridgeOf(adapters).execute('tool_call {"name":"acme_ledger","arguments":{}}', {});

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("tool_search");
    expect((result as { details?: { kind?: string; name?: string } }).details).toEqual({
      kind: "unknown_tool",
      name: "acme_ledger",
      hint: "tool_search",
    });
  });

  it("keeps the per-seat gate: a seat without terminal cannot reach it through the bridge", async () => {
    const { adapters } = build([fakeMcpAdapter()]);
    const finance = adaptersForSeat(adapters, "finance");
    expect(finance.map((adapter) => adapter.name)).not.toContain("terminal");

    const result = await bridgeOf(finance).execute('tool_call {"name":"terminal","arguments":{"command":"ls"}}', {});
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("tool_search");
  });

  it("defers the core toolsets too once the catalog passes the configured threshold", () => {
    const { adapters } = build([], { tools: { disclosure_threshold: 2 } });
    const names = advertised(adapters);

    expect(names).toContain("tool_call");
    // `file_ops` stays: it is the seat's own hands. `terminal` is not core and goes behind the bridge.
    expect(names).toContain("read_file");
    expect(names).not.toContain("process_manage");
  });
});
