/**
 * Plugin manifests: `<plugins>/<name>/plugin.json` =
 * `{name, version, tools:[{name, description, parameters, command}]}`.
 *
 * Nothing here imports plugin code. A manifest is data; a tool is a shell command the sandbox
 * runs with the JSON arguments on stdin. Hermes's own general plugins are Python modules with a
 * `register(ctx)` hook (`hermes_cli/plugins.py`); Trent deliberately ships only this command
 * form so a plugin can never execute inside the Trent process.
 *
 * Refusals, each with its reason:
 *   - the file is a symlink, or its mode grants anything to group/other (0600 or stricter only);
 *   - the plugin name or a tool name misses `^[a-z][a-z0-9_]{1,40}$`, or differs from its directory;
 *   - a tool name shadows a built-in Trent tool or a tool an earlier plugin registered;
 *   - `parameters` is not an object schema, or `command` is empty;
 *   - the command trips the hardline floor (it would never run anyway).
 */
import fs from "node:fs";
import path from "node:path";
import { floorBlock } from "../approval-floors.js";
import { isBuiltinToolName } from "../tool-names.js";
import type { ToolSchema } from "../web/schemas.js";

export const PLUGIN_NAME_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;
export const MANIFEST_FILE = "plugin.json";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_TOOLS_PER_PLUGIN = 32;

export interface PluginTool {
  readonly plugin: string;
  readonly schema: ToolSchema;
  readonly command: string;
  /** Host directory of the plugin; the command's cwd on the local backend. */
  readonly dir: string;
}

export interface LoadedPlugin {
  readonly name: string;
  readonly version: string;
  readonly dir: string;
  readonly tools: readonly PluginTool[];
}

export interface RefusedPlugin {
  readonly plugin: string;
  readonly reason: string;
}

export interface PluginLoadReport {
  readonly plugins: readonly LoadedPlugin[];
  readonly refused: readonly RefusedPlugin[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** 0600 or stricter, a regular file, not a symlink. Returns the reason to refuse, or null. */
export function manifestPermissionProblem(file: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return `${MANIFEST_FILE} is missing`;
  }
  if (stat.isSymbolicLink()) return `${MANIFEST_FILE} is a symlink; it must be a regular file`;
  if (!stat.isFile()) return `${MANIFEST_FILE} is not a regular file`;
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return `${MANIFEST_FILE} mode is 0${mode.toString(8)}; it must be 0600 or stricter (no group/other permission)`;
  }
  if (stat.size > MAX_MANIFEST_BYTES) return `${MANIFEST_FILE} exceeds ${MAX_MANIFEST_BYTES} bytes`;
  return null;
}

function parseTool(raw: unknown, plugin: string, dir: string, taken: Set<string>): PluginTool | string {
  if (!isRecord(raw)) return "each entry in tools must be an object";
  const { name, description, parameters, command } = raw;
  if (typeof name !== "string" || !PLUGIN_NAME_PATTERN.test(name)) {
    return `tool name ${JSON.stringify(name)} must match ${PLUGIN_NAME_PATTERN}`;
  }
  if (isBuiltinToolName(name)) return `tool name "${name}" collides with a built-in Trent tool`;
  if (taken.has(name)) return `tool name "${name}" is already registered by another plugin`;
  if (typeof description !== "string" || !description.trim()) return `tool "${name}" needs a non-empty description`;
  if (!isRecord(parameters) || parameters.type !== "object" || !isRecord(parameters.properties)) {
    return `tool "${name}" parameters must be a JSON schema object with type "object" and properties`;
  }
  if (typeof command !== "string" || !command.trim()) return `tool "${name}" needs a non-empty command`;
  const floor = floorBlock(command);
  if (floor !== null) return `tool "${name}" command trips the hardline floor: ${floor}`;
  const required = Array.isArray(parameters.required) ? parameters.required.filter((r): r is string => typeof r === "string") : undefined;
  return {
    plugin,
    dir,
    command: command.trim(),
    schema: {
      name,
      description: description.trim(),
      parameters: { type: "object", properties: parameters.properties as Record<string, unknown>, ...(required ? { required } : {}) },
    },
  };
}

/** Parses one plugin directory. Returns the plugin or the reason it was refused. */
export function loadPluginDir(dir: string, taken: Set<string>): LoadedPlugin | string {
  const file = path.join(dir, MANIFEST_FILE);
  const permission = manifestPermissionProblem(file);
  if (permission) return permission;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return `${MANIFEST_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!isRecord(parsed)) return `${MANIFEST_FILE} must be a JSON object`;
  const { name, version, tools } = parsed;
  const dirName = path.basename(dir);
  if (typeof name !== "string" || !PLUGIN_NAME_PATTERN.test(name)) return `plugin name ${JSON.stringify(name)} must match ${PLUGIN_NAME_PATTERN}`;
  if (name !== dirName) return `plugin name "${name}" must equal its directory name "${dirName}"`;
  if (typeof version !== "string" || !version.trim()) return "version must be a non-empty string";
  if (!Array.isArray(tools) || !tools.length) return "tools must be a non-empty array";
  if (tools.length > MAX_TOOLS_PER_PLUGIN) return `tools lists ${tools.length} entries; at most ${MAX_TOOLS_PER_PLUGIN}`;
  const out: PluginTool[] = [];
  const local = new Set<string>();
  for (const raw of tools) {
    const tool = parseTool(raw, name, dir, new Set([...taken, ...local]));
    if (typeof tool === "string") return tool;
    local.add(tool.schema.name);
    out.push(tool);
  }
  return { name, version, dir, tools: out };
}

/** Reads every `<pluginsDir>/<name>/plugin.json`, in name order, refusing each bad one with its reason. */
export function loadPluginManifests(pluginsDir: string): PluginLoadReport {
  const plugins: LoadedPlugin[] = [];
  const refused: RefusedPlugin[] = [];
  const taken = new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return { plugins, refused };
  }
  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = path.join(pluginsDir, entry.name);
    if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) continue;
    const result = loadPluginDir(dir, taken);
    if (typeof result === "string") {
      refused.push({ plugin: entry.name, reason: result });
      continue;
    }
    for (const tool of result.tools) taken.add(tool.schema.name);
    plugins.push(result);
  }
  return { plugins, refused };
}
