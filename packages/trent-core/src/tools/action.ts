/**
 * The wire shape of a Trent tool call. The seat loop hands an adapter only `(action, {companyId})`
 * (`seat-agent-loop.ts:611-622`), so the whole input is the action string: `<tool> <json>`,
 * parsed exactly like the MCP bridge's `parseMcpAction` (`mcp-tool-adapter.ts:56-70`).
 *
 * Two lenient forms are accepted because the seat may name the scope instead of the adapter
 * (`{name:"read_file", action:'{"path":"x"}'}`): a bare JSON object is attributed to a tool by
 * its keys, and `<tool> <rest>` with non-JSON rest fills the tool's primary argument.
 */
import type { ToolCallRecord, ToolCallStatus } from "./types.js";

export interface ParsedAction {
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** Set when the action could not be attributed to a tool; the summary tells the model how to call. */
  readonly error?: string;
}

export interface ToolSpec {
  readonly name: string;
  /** The argument a bare `<tool> <text>` form fills. */
  readonly primary: string;
  /** Keys that identify this tool when the action is a bare JSON object. */
  readonly signature: readonly string[];
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function inferTool(args: Record<string, unknown>, specs: readonly ToolSpec[]): ToolSpec | undefined {
  const keys = new Set(Object.keys(args));
  // The most specific signature wins: `patch` needs old_string AND new_string, `write_file` content.
  const ranked = [...specs].sort((a, b) => b.signature.length - a.signature.length);
  return ranked.find((spec) => spec.signature.every((key) => keys.has(key)));
}

export function parseAction(action: string, specs: readonly ToolSpec[]): ParsedAction {
  const trimmed = action.trim();
  const braceIndex = trimmed.indexOf("{");
  const head = (braceIndex === -1 ? trimmed : trimmed.slice(0, braceIndex)).trim();
  const tool = head.split(/\s+/)[0] ?? "";
  const known = specs.find((spec) => spec.name === tool.toLowerCase());

  if (braceIndex === -1) {
    if (!known) return { tool, args: {}, error: usage(specs, tool) };
    const rest = head.slice(tool.length).trim();
    return { tool: known.name, args: rest ? { [known.primary]: rest } : {} };
  }

  const args = parseJsonObject(trimmed.slice(braceIndex));
  if (!args) return { tool: known?.name ?? tool, args: {}, error: `Malformed JSON in action. ${usage(specs, tool)}` };
  if (known) return { tool: known.name, args };
  if (head === "") {
    const inferred = inferTool(args, specs);
    if (inferred) return { tool: inferred.name, args };
  }
  return { tool, args, error: usage(specs, tool) };
}

function usage(specs: readonly ToolSpec[], tool: string): string {
  const names = specs.map((spec) => spec.name).join(", ");
  const unknown = tool ? `Unknown tool "${tool}". ` : "";
  return `${unknown}Use toolCall.action = "<tool> <json>" with tool one of: ${names}.`;
}

export function record(adapter: string, action: string, status: ToolCallStatus, summary: string): ToolCallRecord {
  return { adapter, action, status, summary };
}

/** Coerces an argument to a bounded integer, falling back when absent or invalid. */
export function intArg(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}
