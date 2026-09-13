/**
 * Pure helpers for the `mcp` toolset: tool naming and `${ENV_VAR}` template resolution.
 *
 * Naming: Trent exposes a server's tool as `mcp_<server>_<tool>`; Hermes registers the same
 * tool as `mcp__<server>__<tool>` (`tools/mcp_tool_schema.py:138-140`). Both sanitise each
 * component to `[a-z0-9_]`, so `env-names` on server `fake` is `mcp_fake_env_names` here.
 *
 * Templates: an `env` or `headers` value may contain `${NAME}` references. They are resolved
 * from the env handed to `connect`, never persisted resolved, and a missing source is reported
 * BY NAME so the reason can be shown without ever printing a value.
 */
export { MCP_SERVER_NAME_PATTERN } from "../../config/schema.js";

const TEMPLATE_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function sanitiseComponent(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "x";
}

/** `mcp_<server>_<tool>`. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp_${sanitiseComponent(server)}_${sanitiseComponent(tool)}`;
}

export interface ResolvedTemplate {
  readonly value: string;
  /** Names of `${VAR}` references that had no value in the env. */
  readonly missing: string[];
}

export function resolveTemplate(template: string, env: NodeJS.ProcessEnv): ResolvedTemplate {
  const missing: string[] = [];
  const value = template.replace(TEMPLATE_REF, (_match, name: string) => {
    const found = env[name];
    if (found === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return "";
    }
    return found;
  });
  return { value, missing };
}

/** Resolves every value of a record; the missing list is the union across values. */
export function resolveTemplateRecord(record: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv): { values: Record<string, string>; missing: string[] } {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [key, template] of Object.entries(record)) {
    const resolved = resolveTemplate(template, env);
    values[key] = resolved.value;
    for (const name of resolved.missing) if (!missing.includes(name)) missing.push(name);
  }
  return { values, missing };
}

/** True when the value carries at least one `${VAR}` reference, so no literal secret is stored. */
export function containsTemplate(value: string): boolean {
  return new RegExp(TEMPLATE_REF.source).test(value);
}
