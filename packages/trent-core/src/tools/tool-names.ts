/**
 * Every tool name Trent's own toolsets answer to, plus the adapter names the read-only app
 * registers. `plugins` refuses a manifest whose tool would shadow any of these, so a third-party
 * `plugin.json` can never take over `terminal` or `read_file`. Kept as data (no adapter imports)
 * so the plugin loader stays import-free.
 */

/** Hermes toolset -> the tool names it exposes, as Trent implements them. */
export const BUILTIN_TOOLS_BY_TOOLSET: Readonly<Record<string, readonly string[]>> = {
  file_ops: ["file_ops", "read_file", "write_file", "patch", "search_files"],
  terminal: ["terminal", "process_manage"],
  web: ["web", "web_search", "web_extract"],
  memory: ["memory", "fleet_search"],
  skills: ["skills", "skills_list", "skill_view", "skill_manage"],
  cron: ["cron", "cronjob_manage"],
  code_execution: ["code_execution", "execute_code"],
  delegation: ["delegation", "delegate_task"],
  plugins: ["plugins", "plugins_list"],
  browser: [
    "browser", "browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_scroll", "browser_back",
    "browser_press", "browser_get_images", "browser_vision", "browser_console", "browser_screenshot", "browser_get_text",
  ],
  vision: ["vision", "vision_analyze"],
  mcp: ["mcp", "mcp_status"],
  human: ["human", "ask_human"],
  media: ["media", "media_probe", "media_transcribe", "media_scenes", "media_clip", "media_thumbnail", "media_image"],
  // A3. The disclosure bridges and the three tools the catalog was missing. `tools` is the bridge
  // adapter's own name; a plugin that tried to claim it would be claiming the way out of the
  // deferred set, which is exactly what the reservation is for.
  tools: ["tools", "tool_search", "tool_describe", "tool_call"],
  todo: ["todo"],
  clarify: ["clarify"],
  session_search: ["session_search"],
};

/** Adapter names owned by `apps/web/lib/tools.ts`; also reserved. */
export const APP_ADAPTER_NAMES: readonly string[] = ["GitHub", "Steel Browser", "Camofox"];

export const BUILTIN_TOOL_NAMES: readonly string[] = [
  ...new Set([...Object.values(BUILTIN_TOOLS_BY_TOOLSET).flat(), ...APP_ADAPTER_NAMES]),
];

export function isBuiltinToolName(name: string): boolean {
  const lower = name.toLowerCase();
  return BUILTIN_TOOL_NAMES.some((builtin) => builtin.toLowerCase() === lower);
}
