/**
 * `toolsets` / `disabled_toolsets` and the `tools` disclosure block of `TrentConfigSchema`.
 * Composed in `config/schema.ts`, which re-exports every name here.
 */

import { z } from "zod";
import { BrowserToolsConfigSchema } from "../../tools/browser/attach-config.js"; // [H5] browser attach

export const ToolsetSchema = z.enum([
  "file_ops",
  "terminal",
  "web",
  "browser",
  "code",
  "vision",
  "memory",
  "delegation",
  "cron",
  "skills",
  "plugins",
  "mcp",
  "human",
  "media",
  "social",
  "business",
  // [P2-9] the A2A client: list, discover, send to and read history with configured peers (docs/a2a.md).
  "a2a",
]);

export type Toolset = z.infer<typeof ToolsetSchema>;

// [A3] tool disclosure
/**
 * Progressive disclosure of the tool catalog (docs/tools.md). Above this many registered tools,
 * everything outside the core toolsets is taken out of the seat's advertised list and reached
 * through `tool_search` / `tool_describe` / `tool_call` instead. MCP, plugin and app-catalog
 * tools are deferred at ANY count: their number is not ours to bound. Raising this buys direct
 * schemas at the cost of prompt context on every turn; lowering it buys context at the cost of
 * one extra round trip the first time a tool is needed.
 */
export const ToolDisclosureConfigSchema = z.object({
  disclosure_threshold: z.number().int().positive().default(24),
  // [H5] browser attach
  /**
   * `tools.browser.attach`: the `browser` toolset may attach to the owner's own running Chrome over
   * the DevTools protocol instead of launching its isolated one (`tools/browser/attach-config.ts`,
   * docs/browser.md "Attach to your own Chrome"). Optional: absent is off, and so is `enabled: false`.
   */
  browser: BrowserToolsConfigSchema.optional(),
  // [/H5]
});
