/**
 * The `mcp_servers` block of `TrentConfigSchema`. Composed in `config/schema.ts`, which
 * re-exports every name here.
 */

import { z } from "zod";
import { McpScanFindingSchema } from "../../tools/mcp/scan.js";

/**
 * `mcp_servers`: one entry per Model Context Protocol server, keyed by a name that becomes the
 * middle of every exposed tool name (`mcp_<server>_<tool>`). Hermes's `~/.hermes/config.yaml`
 * uses the same block (`{command,args,env}` for stdio, `{url,headers}` for http); `transport` is
 * inferred from which of those is present when it is omitted. `env` and `headers` VALUES may
 * reference `${ENV_VAR}`, resolved from the process env at connect time and never stored resolved.
 * `auto_approve` lists the server's tools (its own names) that may run without approval.
 */
export const MCP_SERVER_NAME_PATTERN = /^[a-z][a-z0-9_-]{1,40}$/;

const McpServerCommonSchema = z.object({
  auto_approve: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  /** Install-time scan record (`trent mcp add`): whether the scan ran, and the findings it was installed over with `--allow-flagged`. */
  scanRan: z.boolean().optional(),
  flagged: z.array(McpScanFindingSchema).optional(),
});

export const McpStdioServerSchema = McpServerCommonSchema.extend({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).default({}),
});

export const McpHttpServerSchema = McpServerCommonSchema.extend({
  transport: z.literal("http"),
  url: z.string().url().refine((u) => /^https?:\/\//i.test(u), { message: "url must be http(s)" }),
  headers: z.record(z.string().min(1), z.string()).default({}),
});

export const McpServerConfigSchema = z.discriminatedUnion("transport", [McpStdioServerSchema, McpHttpServerSchema]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Infers `transport`, and lifts the legacy `[{name, url}]` array the old CLI wrote into the record. */
function normaliseMcpServers(raw: unknown): unknown {
  let entries: Record<string, unknown> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (isRecord(item) && typeof item.name === "string" && typeof item.url === "string") entries[item.name] = { url: item.url };
    }
  } else if (isRecord(raw)) entries = raw;
  else return raw;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(entries)) {
    if (!isRecord(value) || typeof value.transport === "string") {
      out[name] = value;
      continue;
    }
    out[name] = { ...value, transport: typeof value.url === "string" ? "http" : "stdio" };
  }
  return out;
}

export const McpServersConfigSchema = z.preprocess(
  normaliseMcpServers,
  z.record(z.string().regex(MCP_SERVER_NAME_PATTERN, "server name must match ^[a-z][a-z0-9_-]{1,40}$"), McpServerConfigSchema),
);
export type McpServersConfig = z.infer<typeof McpServersConfigSchema>;
