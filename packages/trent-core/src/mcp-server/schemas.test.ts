/**
 * U5 — an MCP tool needs a JSON schema, and Trent's adapters publish theirs as the rendered
 * `<tool> <json>` usage block a seat reads (`renderToolInstructions`). This is the inverse of that
 * renderer: the block goes back to a schema, so the host sees the same arguments, types, enums
 * and required keys the seat sees, including a description a human promoted over the shipped one.
 * The two toolsets that describe themselves in prose (`file_ops`, `terminal`) carry a schema table
 * here instead, checked against the tool names those adapters actually answer to.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS_BY_TOOLSET } from "../tools/tool-names.js";
import { renderToolInstructions, type ToolSchema } from "../tools/web/schemas.js";
import { parseToolBlocks } from "../tools/tool_search/index.js";
import { BROWSER_TOOL_SCHEMAS, CRON_TOOL_SCHEMAS, SKILL_TOOL_SCHEMAS, WEB_TOOL_SCHEMAS } from "../tools/index.js";
import { PROSE_TOOL_SCHEMAS, parseInstructionBlock, toolInputSchema } from "./schemas.js";

const SAMPLE: ToolSchema = {
  name: "ledger_post",
  description: "Post an entry to the ledger: amount, memo and the account it lands in.",
  parameters: {
    type: "object",
    properties: {
      amount_cents: { type: "integer", description: "Integer cents, never a float." },
      memo: { type: "string" },
      account: { type: "string", enum: ["cash", "card"], description: "Where it lands." },
      tags: { type: "array", items: { type: "string" }, description: "Labels: free text." },
      dry: { type: "boolean" },
      payload: { type: "object", description: "Free-form." },
      anything: {},
    },
    required: ["amount_cents", "account"],
  },
};

describe("parseInstructionBlock inverts renderToolInstructions", () => {
  it("recovers the name, description, every argument's type, enum, requiredness and description", () => {
    const block = parseToolBlocks(renderToolInstructions([SAMPLE]), ["ledger_post"]).get("ledger_post");
    expect(block).toBeDefined();
    const parsed = parseInstructionBlock(block!, "ledger_post");
    expect(parsed).toBeDefined();
    expect(parsed!.name).toBe("ledger_post");
    expect(parsed!.description).toBe(SAMPLE.description);
    expect(parsed!.parameters.required).toEqual(["amount_cents", "account"]);
    const p = parsed!.parameters.properties as Record<string, { type?: string; enum?: string[]; description?: string }>;
    expect(p.amount_cents).toEqual({ type: "integer", description: "Integer cents, never a float." });
    expect(p.memo).toEqual({ type: "string" });
    expect(p.account).toEqual({ type: "string", enum: ["cash", "card"], description: "Where it lands." });
    expect(p.tags).toEqual({ type: "array", description: "Labels: free text." });
    expect(p.dry).toEqual({ type: "boolean" });
    expect(p.payload).toEqual({ type: "object", description: "Free-form." });
    // `any` is rendered for a property with no type; a JSON schema says that by saying nothing.
    expect(p.anything).toEqual({});
  });

  it("round-trips every shipped schema of the web, skills, cron and browser toolsets", () => {
    for (const schema of [...WEB_TOOL_SCHEMAS, ...SKILL_TOOL_SCHEMAS, ...CRON_TOOL_SCHEMAS, ...BROWSER_TOOL_SCHEMAS]) {
      const block = parseToolBlocks(renderToolInstructions([schema]), [schema.name]).get(schema.name);
      const parsed = parseInstructionBlock(block!, schema.name);
      expect(parsed, schema.name).toBeDefined();
      expect(parsed!.description).toBe(schema.description);
      expect(Object.keys(parsed!.parameters.properties).sort()).toEqual(Object.keys(schema.parameters.properties).sort());
      expect(parsed!.parameters.required ?? []).toEqual(schema.parameters.required ?? []);
    }
  });

  it("returns undefined for prose that is not a rendered block, instead of inventing arguments", () => {
    expect(parseInstructionBlock("file_ops reads and edits files in the repository workspace.", "file_ops")).toBeUndefined();
  });
});

describe("the prose toolsets carry a schema table", () => {
  it("covers every callable tool of file_ops and terminal, and nothing that is not one", () => {
    const callable = [...BUILTIN_TOOLS_BY_TOOLSET.file_ops!, ...BUILTIN_TOOLS_BY_TOOLSET.terminal!].filter((n) => n !== "file_ops");
    expect(Object.keys(PROSE_TOOL_SCHEMAS).sort()).toEqual([...callable].sort());
    for (const schema of Object.values(PROSE_TOOL_SCHEMAS)) {
      expect(schema.description.length).toBeGreaterThan(10);
      expect(Object.keys(schema.parameters.properties).length).toBeGreaterThan(0);
    }
    expect(PROSE_TOOL_SCHEMAS.read_file!.parameters.required).toEqual(["path"]);
    expect(PROSE_TOOL_SCHEMAS.patch!.parameters.required).toEqual(["path", "old_string", "new_string"]);
    expect(PROSE_TOOL_SCHEMAS.terminal!.parameters.required).toEqual(["command"]);
  });
});

describe("toolInputSchema", () => {
  it("renders an MCP inputSchema: an object with properties and required, and an empty object for a tool with no arguments", () => {
    expect(toolInputSchema(SAMPLE)).toMatchObject({ type: "object", required: ["amount_cents", "account"] });
    expect(toolInputSchema({ name: "x", description: "y", parameters: { type: "object", properties: {} } })).toEqual({ type: "object", properties: {} });
  });
});
