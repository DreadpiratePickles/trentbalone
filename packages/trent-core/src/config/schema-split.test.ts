import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TrentConfigSchema } from "./schema.js";
import { DEFAULT_CONFIG } from "./defaults.js";

/**
 * `TrentConfigSchema` is composed in `schema.ts` from section modules under `config/sections/`.
 * The split is a pure move: the composed schema must parse to exactly what the single-file
 * schema parsed to, key for key and in the same key ORDER (the config writer serialises the
 * parsed object, so a reordered shape reorders every `config.yaml` it rewrites).
 *
 * `schema-split.snapshot.json` was generated from the UNMODIFIED single-file `schema.ts`,
 * before any section was moved, over two inputs: the shipped `DEFAULT_CONFIG`, and
 * `schema-split.input.json`, which sets a non-default value in every section (including the
 * `mcp_servers` transport inference and an unknown top-level key, to pin `.passthrough()`).
 * It is the oracle, not a record of current behaviour: regenerating it to make this pass would
 * assert nothing.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => JSON.parse(readFileSync(join(HERE, name), "utf8"));

const SNAPSHOT = read("schema-split.snapshot.json") as { defaults: unknown; full: unknown };
const FULL_INPUT = read("schema-split.input.json") as unknown;

describe("config schema split — parsed output is unchanged", () => {
  it("parses the shipped defaults to the pre-split result", () => {
    expect(TrentConfigSchema.parse(DEFAULT_CONFIG)).toEqual(SNAPSHOT.defaults);
  });

  it("parses a config exercising every section to the pre-split result", () => {
    expect(TrentConfigSchema.parse(FULL_INPUT)).toEqual(SNAPSHOT.full);
  });

  it("keeps the top-level key order of the composed object", () => {
    const parsed = TrentConfigSchema.parse(FULL_INPUT) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(Object.keys(SNAPSHOT.full as Record<string, unknown>));
    expect(Object.keys(TrentConfigSchema.shape)).toEqual(
      Object.keys(SNAPSHOT.full as Record<string, unknown>).filter((k) => k !== "an_unknown_future_key"),
    );
  });

  it("keeps `personality:` and `theme:` literally in schema.ts", () => {
    // The block-cutting tooling inserts new config keys immediately before the `personality:`
    // line of `TrentConfigSchema`, so that line must survive in this file, not a section module.
    const source = readFileSync(join(HERE, "schema.ts"), "utf8");
    expect(source).toMatch(/^ {2}personality: /m);
    expect(source).toMatch(/^ {2}theme: /m);
  });

  it("re-exports every name the rest of the repo imports from schema.ts", async () => {
    const schema = (await import("./schema.js")) as Record<string, unknown>;
    for (const name of [
      "ProviderSchema",
      "ModelOverrideSchema",
      "ToolsetSchema",
      "TerminalBackendSchema",
      "DEFAULT_BUDGET_PER_RUN_CAP",
      "BudgetConfigSchema",
      "TerminalConfigSchema",
      "EgressConfigSchema",
      "GatewayConfigSchema",
      "HeartbeatConfigSchema",
      "MemoryBlockSchema",
      "EmbedderConfigSchema",
      "MemoryConfigSchema",
      "FleetConfigSchema",
      "MCP_SERVER_NAME_PATTERN",
      "McpStdioServerSchema",
      "McpHttpServerSchema",
      "McpServerConfigSchema",
      "McpServersConfigSchema",
      "CONFIG_SCHEMA_VERSION",
      "TrentConfigSchema",
      "TrentSecretsSchema",
    ]) {
      expect(schema[name], `schema.ts must still export ${name}`).toBeDefined();
    }
  });
});
