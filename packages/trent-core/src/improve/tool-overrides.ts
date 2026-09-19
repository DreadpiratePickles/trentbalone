/**
 * [D5] item 3 — where a promoted tool draft actually lands.
 *
 * `<profileDir>/tool-overrides.json`, one entry per tool, owner-only and written by rename so a
 * half-written file can never be read. It holds a DESCRIPTION and the draft that proposed it, and
 * nothing else: not a schema, not an argument list, not a handler. `buildTrentTools` reads it at
 * registration and rewrites the one line of the adapter's instruction block that carries that
 * tool's description (`renderToolInstructions` emits `"<name>: <description>"` as the first line
 * of each block, which is why a line is enough and a parser is not needed).
 *
 * The rewrite is a Proxy over the shipped adapter, the same technique the disclosure layer uses,
 * so `execute`, `dryRun`, `healthCheck` and every other member are the shipped ones — an improved
 * description cannot change what a tool DOES, only what the model is told it does. An override
 * whose tool no adapter names is reported and not applied, so a stale entry is visible rather
 * than silent.
 */

import fs from "node:fs";
import path from "node:path";

import type { ToolDescriptionOverride, TrentToolAdapter } from "../tools/types.js";

export const TOOL_OVERRIDES_FILE = "tool-overrides.json";
const FILE_MODE = 0o600;
const SCHEMA_VERSION = 1;

/** One override as it was applied to a built adapter: enough for a surface to name the improvement. */
export interface AppliedToolOverride {
  readonly tool: string;
  readonly adapter: string;
  readonly draftId: string;
}

export function toolOverridesPath(profileDir: string): string {
  return path.join(profileDir, TOOL_OVERRIDES_FILE);
}

function isOverride(value: unknown): value is ToolDescriptionOverride {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.tool === "string" && row.tool !== "" && typeof row.description === "string" && typeof row.draftId === "string";
}

/** Every override this profile holds. A missing, unreadable or corrupt file is no overrides. */
export function readToolOverrides(profileDir: string): ToolDescriptionOverride[] {
  let raw: string;
  try {
    raw = fs.readFileSync(toolOverridesPath(profileDir), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (parsed as { overrides?: unknown })?.overrides;
    return Array.isArray(list) ? list.filter(isOverride).map((row) => ({ ...row })) : [];
  } catch {
    return [];
  }
}

/** Write-then-rename, owner-only, in the profile directory the caller already owns. */
export function writeToolOverrides(profileDir: string, overrides: readonly ToolDescriptionOverride[]): void {
  fs.mkdirSync(profileDir, { recursive: true });
  const file = toolOverridesPath(profileDir);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: SCHEMA_VERSION, overrides: [...overrides] }, null, 2)}\n`, { mode: FILE_MODE });
  fs.chmodSync(temporary, FILE_MODE);
  fs.renameSync(temporary, file);
  fs.chmodSync(file, FILE_MODE);
}

/** One tool has one live description: a second promotion for the same tool replaces the first. */
export function writeToolOverride(profileDir: string, override: ToolDescriptionOverride): void {
  writeToolOverrides(profileDir, [...readToolOverrides(profileDir).filter((row) => row.tool !== override.tool), override]);
}

export function removeToolOverride(profileDir: string, tool: string): void {
  const kept = readToolOverrides(profileDir).filter((row) => row.tool !== tool);
  writeToolOverrides(profileDir, kept);
}

/** A description is one line of an instruction block, so a proposal that wraps is folded into one. */
function oneLine(description: string): string {
  return description.replace(/\s*\n+\s*/g, " ").trim();
}

/**
 * The instruction text with that tool's description line replaced, or undefined when the block
 * does not name the tool — which is how a stale override is reported rather than applied.
 */
export function overrideInstructions(instructions: string, tool: string, description: string): string | undefined {
  const lines = instructions.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${tool}: `));
  if (index === -1) return undefined;
  lines[index] = `${tool}: ${oneLine(description)}`;
  return lines.join("\n");
}

function describedAdapter(adapter: TrentToolAdapter, instructions: string, overrides: readonly ToolDescriptionOverride[]): TrentToolAdapter {
  return new Proxy(adapter, {
    get(target, property) {
      if (property === "instructions") return instructions;
      if (property === "descriptionOverrides") return overrides;
      return Reflect.get(target, property, target);
    },
  });
}

export interface AppliedToolDescriptions {
  readonly adapters: TrentToolAdapter[];
  readonly applied: AppliedToolOverride[];
}

/**
 * The registration-time application: every adapter whose instructions name an overridden tool is
 * served with that one description replaced. Order is preserved and an adapter with no override
 * is the shipped object, not a copy.
 */
export function applyToolDescriptions(adapters: readonly TrentToolAdapter[], overrides: readonly ToolDescriptionOverride[]): AppliedToolDescriptions {
  if (overrides.length === 0) return { adapters: [...adapters], applied: [] };
  const applied: AppliedToolOverride[] = [];
  const out = adapters.map((adapter) => {
    let instructions = adapter.instructions;
    const mine: ToolDescriptionOverride[] = [];
    for (const override of overrides) {
      const rewritten = overrideInstructions(instructions, override.tool, override.description);
      if (rewritten === undefined) continue;
      instructions = rewritten;
      mine.push(override);
      applied.push({ tool: override.tool, adapter: adapter.name, draftId: override.draftId });
    }
    return mine.length === 0 ? adapter : describedAdapter(adapter, instructions, mine);
  });
  return { adapters: out, applied };
}
