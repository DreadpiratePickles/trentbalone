/**
 * `plugins`: every tool from every accepted `<plugins>/<name>/plugin.json`, as ONE adapter whose
 * scopes are the plugin tool names. A call `<tool> <json>` runs the manifest's `command` through
 * the seat's sandbox with the JSON arguments on stdin and returns stdout (stderr appended),
 * fitted to the summary limit like every other toolset.
 *
 * Security posture: no plugin code is imported; the manifest must be 0600-or-stricter; names are
 * validated and cannot shadow built-ins; every plugin tool call requires approval (strictly above
 * `terminal`'s floor, which only asks for dangerous findings) and the hardline floor is re-checked
 * inside `execute`. On the local backend the command's cwd is the plugin directory; on Docker it
 * is the workspace, so the command must be resolvable inside the sandbox image.
 */
import path from "node:path";
import { parseAction, record as toRecord, type ToolSpec } from "../action.js";
import { floorBlock } from "../approval-floors.js";
import { createSandbox, shellQuote, type Sandbox } from "../sandbox.js";
import { fitSummary } from "../spillover.js";
import type { ToolCallRecord, ToolContext, TrentToolAdapter } from "../types.js";
import { renderToolInstructions, type ToolSchema } from "../web/schemas.js";
import { loadPluginManifests, type PluginLoadReport, type PluginTool } from "./manifest.js";

export {
  loadPluginManifests,
  loadPluginDir,
  manifestPermissionProblem,
  MANIFEST_FILE,
  PLUGIN_NAME_PATTERN,
  type LoadedPlugin,
  type PluginLoadReport,
  type PluginTool,
  type RefusedPlugin,
} from "./manifest.js";

export const PLUGINS_ADAPTER_NAME = "plugins";
export const PLUGINS_LIST_TOOL = "plugins_list";
const DEFAULT_TIMEOUT_S = 120;
const ROUTING_TEXT = "installed plugin tools, third-party plugin, list plugins, run a plugin command";

const LIST_SCHEMA: ToolSchema = {
  name: PLUGINS_LIST_TOOL,
  description: "List the installed plugins, their tools, and every manifest that was refused with the reason.",
  parameters: { type: "object", properties: {} },
};

export interface PluginsAdapterOptions {
  /** Defaults to `<profileDir>/plugins` (`~/.trent/plugins` for the default profile). */
  readonly pluginsDir?: string;
  readonly timeoutS?: number;
}

export function defaultPluginsDir(profileDir: string): string {
  return path.join(profileDir, "plugins");
}

function renderReport(report: PluginLoadReport): string {
  const loaded = report.plugins.length
    ? report.plugins.map((p) => `- ${p.name}@${p.version}: ${p.tools.map((t) => t.schema.name).join(", ")}`)
    : ["(no plugins loaded)"];
  const refused = report.refused.map((r) => `- ${r.plugin}: refused, ${r.reason}`);
  return [`Loaded plugins:`, ...loaded, ...(refused.length ? ["Refused manifests:", ...refused] : [])].join("\n");
}

export function createPluginsAdapter(ctx: ToolContext, options: PluginsAdapterOptions = {}, sandbox: Sandbox = createSandbox(ctx)): TrentToolAdapter {
  const pluginsDir = options.pluginsDir ?? defaultPluginsDir(ctx.profileDir);
  const timeoutS = options.timeoutS ?? DEFAULT_TIMEOUT_S;
  const report = loadPluginManifests(pluginsDir);
  const tools = new Map<string, PluginTool>();
  for (const plugin of report.plugins) for (const tool of plugin.tools) tools.set(tool.schema.name, tool);
  const specs: readonly ToolSpec[] = [
    { name: PLUGINS_LIST_TOOL, primary: "", signature: ["__plugins_list__"] },
    ...[...tools.values()].map((t) => ({
      name: t.schema.name,
      primary: t.schema.parameters.required?.[0] ?? Object.keys(t.schema.parameters.properties)[0] ?? "input",
      signature: [`__${t.schema.name}__`],
    })),
  ];
  const schemas = [LIST_SCHEMA, ...[...tools.values()].map((t) => t.schema)];
  const record = (action: string, status: ToolCallRecord["status"], summary: string) =>
    toRecord(PLUGINS_ADAPTER_NAME, action, status, fitSummary(summary, ctx.profileDir, "plugin"));

  async function runTool(action: string, tool: PluginTool, args: Record<string, unknown>): Promise<ToolCallRecord> {
    const floor = floorBlock(tool.command);
    if (floor !== null) return record(action, "blocked", `Blocked by the hardline floor: ${floor}.`);
    const stdin = JSON.stringify(args);
    const command = `printf '%s' ${shellQuote(stdin)} | ${tool.command}`;
    const cwd = sandbox.kind === "local" ? tool.dir : sandbox.workspaceRoot;
    const res = await sandbox.run(command, { cwd, timeoutMs: timeoutS * 1000, network: false });
    const timedOut = res.exitCode !== 0 && res.durationMs >= timeoutS * 1000;
    const stderr = res.stderr.startsWith("Command failed: ") ? "" : res.stderr;
    const output = res.stdout + (stderr.trim() ? `${res.stdout && !res.stdout.endsWith("\n") ? "\n" : ""}[stderr]\n${stderr}` : "");
    const note = timedOut ? `[timed_out after ${timeoutS}s]` : res.exitCode !== 0 ? `[exit code ${res.exitCode}]` : "";
    const body = output.trimEnd() || "(no output)";
    return record(action, res.exitCode === 0 ? "completed" : "failed", note ? `${body}\n${note}` : body);
  }

  return {
    name: PLUGINS_ADAPTER_NAME,
    scopes: [PLUGINS_ADAPTER_NAME, PLUGINS_LIST_TOOL, ...tools.keys()],
    availability: "real",
    instructions: renderToolInstructions(schemas),
    routingText: `${ROUTING_TEXT}${tools.size ? `: ${[...tools.keys()].join(", ")}` : ""}`,
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval(action) {
      const { tool, error } = parseAction(action, specs);
      return !error && tools.has(tool);
    },
    async dryRun(action) {
      const { tool } = parseAction(action, specs);
      const entry = tools.get(tool);
      if (!entry) return record(action, "mocked", `plugins dry-run: "${action.slice(0, 120)}" is not a plugin tool.`);
      return record(action, "needs_approval", `Plugin tool ${tool} (plugin ${entry.plugin}) needs approval before it runs its command in the sandbox.`);
    },
    async execute(action) {
      const { tool, args, error } = parseAction(action, specs);
      if (error) return record(action, "failed", error);
      if (tool === PLUGINS_LIST_TOOL) return record(action, "completed", renderReport(report));
      const entry = tools.get(tool);
      if (!entry) return record(action, "failed", `Unknown plugin tool "${tool}". Known: ${[...tools.keys()].join(", ") || "none"}.`);
      try {
        return await runTool(action, entry, args);
      } catch (err) {
        return record(action, "failed", `${tool} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    cleanup: () => sandbox.cleanup(),
  };
}
