/**
 * [S1] The solo prompt.
 *
 * SYSTEM, built once per session and then byte-identical for every turn of it (P2-7's rule: a
 * provider cache hits a PREFIX, so nothing that depends on the objective, the turn or the clock may
 * enter it). In order:
 *   1. the persona: `<profile>/brain/system/solo.md` when it is there, else DEFAULT_SOLO_PERSONA;
 *   2. the fleet-memory STABLE tier (identity, memory blocks, the brain), as `tiers.ts` assembles it;
 *   3. the tool protocol and each adapter's own `instructions` (the tool disclosure; deferred
 *      tools stay behind `tool_search`, because the build's masked adapters already say so).
 *      [S1.1] C1: ONE call format is taught, the model's own `{"name", "arguments"}` body: the
 *      adapters' `action = "..."` lines and `toolCall.*` wording are removed from the disclosure and
 *      their inline `<tool> <json>` examples rewritten into the same body (`renderToolDisclosure`).
 *
 * MESSAGES after it: the session's history (after compaction), then ONE user message holding the
 * CONTEXT tier (this turn's recall, the workspace, the date) and the objective. Roles alternate:
 * a tool result is a user message (the gateway has no tool role) and consecutive messages of one
 * role merge, so a compaction summary and the turn after it arrive as one user message.
 * [S1.1] C2: a result reaches the model capped at `agent.solo.max_tool_result_chars`, the cut named.
 */
import fs from "node:fs";
import path from "node:path";
import { toolNameOf } from "../governance/idempotent-dispatch.js";
import { assembleContext, type AssembledContext, type ContextBlock } from "../fleet-memory/tiers.js";
import type { GatewayMessage } from "../model-gateway/types.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";
import { toolNamesOf } from "./parse.js";
import { DEFAULT_SOLO_MAX_TOOL_RESULT_CHARS, SOLO_MAX_TOOL_RESULT_CHARS_KEY, type SoloMessage, type SoloResponseFormat } from "./types.js";

/** The persona file, under the brain's always-loaded `system/` directory. */
export const SOLO_PERSONA_FILE = "solo.md";

export const DEFAULT_SOLO_PERSONA =
  "You are Trent, one capable assistant working for the person in this conversation. Use the tools " +
  "below when they get you a fact you do not have or do work the person asked for, and say plainly " +
  "what a tool reported: never claim a tool did something its result does not show. A call that is " +
  "held for approval waits until the person decides.";

export const SOLO_TOOL_PROTOCOL = [
  "## How to call a tool",
  "Write one block per call, exactly in this form: the tool's name, and its arguments as a JSON object:",
  "<tool_call>",
  '{"name": "read_file", "arguments": {"path": "README.md"}}',
  "</tool_call>",
  "You may write several blocks in one reply; they run in order and every result comes back to you in",
  "the next message, inside <tool_result> tags. When you have what you need, reply in plain text with no",
  "<tool_call> block: that reply is your answer to the person.",
].join("\n");

const SEPARATOR = "\n\n";

export function soloPersonaPath(profileDir: string): string {
  return path.join(profileDir, "brain", "system", SOLO_PERSONA_FILE);
}

/**
 * The persona text. A missing file (or profile) is the default; any other read failure is thrown,
 * because a persona that silently became the default is a prompt nobody chose.
 */
export function readSoloPersona(profileDir: string | undefined): string {
  if (profileDir === undefined) return DEFAULT_SOLO_PERSONA;
  try {
    const text = fs.readFileSync(soloPersonaPath(profileDir), "utf8").trim();
    return text === "" ? DEFAULT_SOLO_PERSONA : text;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return DEFAULT_SOLO_PERSONA;
    throw error;
  }
}

/** `renderToolInstructions`'s usage line (`tools/web/schemas.ts`), with or without its keys list. */
const ACTION_LINE_WITH_KEYS = /^[ \t]*action = ".*" with JSON keys:[ \t]*$/gm;
const ACTION_LINE = /^[ \t]*action = ".*"[ \t]*\n?/gm;
/** The prose adapters' framing (`file_ops`, `terminal`): the seat contract's field names. */
const TOOLCALL_NAME = /toolCall\.name "[^"]*"(?: \(or the tool name\))?;\s*/g;
const TOOLCALL_ACTION = /toolCall\.action is "<tool> <json>":\s*/g;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The index of the brace closing the one at `open`, strings respected; -1 when it never closes. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every inline `<tool> {json}` example of one of `names`, rewritten as the one call body. */
function rewriteInlineCalls(text: string, names: readonly string[]): string {
  if (names.length === 0) return text;
  const pattern = new RegExp(`(^|[^\\w"])(${names.map(escapeRegExp).join("|")}) (?=\\{)`, "g");
  let out = "";
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = (match.index ?? 0) + (match[1] ?? "").length;
    const brace = (match.index ?? 0) + match[0].length;
    const end = start < last ? -1 : closingBrace(text, brace);
    if (end === -1) continue;
    out += `${text.slice(last, start)}{"name": "${match[2] ?? ""}", "arguments": ${text.slice(brace, end + 1)}}`;
    last = end + 1;
  }
  return out + text.slice(last);
}

/** [S1.1] C1: an adapter's instructions in the one call format: no `action =` line, no `toolCall.*`, examples as bodies. */
export function soloInstructions(adapter: TrentToolAdapter): string {
  const text = adapter.instructions
    .replace(ACTION_LINE_WITH_KEYS, "  arguments (keys of the JSON object):")
    .replace(ACTION_LINE, "")
    .replace(TOOLCALL_NAME, "")
    .replace(TOOLCALL_ACTION, "Calls: ");
  return rewriteInlineCalls(text, toolNamesOf(adapter)).trim();
}

/** Every adapter's own `instructions`, under its name, in build order, in the one call format. */
export function renderToolDisclosure(adapters: readonly TrentToolAdapter[]): string {
  if (adapters.length === 0) return "";
  const sections = adapters.map((adapter) => `### ${adapter.name}\n${soloInstructions(adapter)}`);
  return `## Tools\n\n${sections.join(SEPARATOR)}`;
}

/** [S1.1] C1: the constrained-output envelope for the solo turn, tool names as an enum (local-models G2, G3). */
export function soloResponseFormat(adapters: readonly TrentToolAdapter[]): SoloResponseFormat {
  const names = [...new Set(adapters.flatMap(toolNamesOf))];
  const call = { type: "object", properties: { name: { type: "string", enum: names }, arguments: { type: "object" } }, required: ["name", "arguments"] };
  return {
    type: "json_schema",
    json_schema: {
      name: "solo_turn",
      schema: {
        type: "object",
        properties: { tool_calls: { type: "array", items: call, minItems: 1 }, answer: { type: "string" } },
        oneOf: [{ required: ["tool_calls"] }, { required: ["answer"] }],
      },
    },
  };
}

export interface SystemPromptInput {
  readonly persona: string;
  /** The stable tier's assembled text (`assembleContext` over the stable blocks). */
  readonly stable: string;
  readonly adapters: readonly TrentToolAdapter[];
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const tools = renderToolDisclosure(input.adapters);
  return [input.persona.trim(), input.stable.trim(), SOLO_TOOL_PROTOCOL, tools].filter((part) => part !== "").join(SEPARATOR);
}

export interface ContextTierInput {
  readonly now: Date;
  readonly workspace?: string;
  /** The turn's own CONTEXT blocks from fleet memory (recall). */
  readonly blocks: readonly ContextBlock[];
  /** The session's frozen stable blocks: measured against the ceiling, never trimmed. */
  readonly stable: readonly ContextBlock[];
  readonly ceilingChars?: number;
}

/**
 * The turn's context tier, measured and trimmed by the fleet's own rule (`assembleContext`): the
 * whole injection against the ceiling, the stable tier never touched, context dropped oldest-first.
 * Recall is inserted first and the workspace and the date last, so the one-line facts survive a trim.
 */
export function assembleTurnContext(input: ContextTierInput): { readonly text: string; readonly assembled: AssembledContext } {
  const facts: ContextBlock[] = [
    ...input.blocks.filter((block) => block.tier !== "stable"),
    ...(input.workspace === undefined ? [] : [{ tier: "context" as const, name: "workspace", text: `Workspace: ${input.workspace}` }]),
    { tier: "context", name: "date", text: `Today is ${input.now.toISOString().slice(0, 10)} (UTC).` },
  ];
  const assembled = assembleContext([...input.stable, ...facts], { ceilingChars: input.ceilingChars ?? Number.NaN });
  const text = assembled.kept.filter((block) => block.tier !== "stable").map((block) => block.text).join(SEPARATOR);
  return { text, assembled };
}

/** The new user message: the context tier, then the objective as the person wrote it. */
export function renderTurnOpening(contextText: string, objective: string): string {
  return contextText === "" ? objective : `<context>\n${contextText}\n</context>${SEPARATOR}${objective}`;
}

const count = (n: number): string => n.toLocaleString("en-US");

/** [S1.1] C2: the summary as the model may read it: at most `maxChars`, the cut named. */
export function capToolResult(summary: string, maxChars: number = DEFAULT_SOLO_MAX_TOOL_RESULT_CHARS): string {
  if (summary.length <= maxChars) return summary;
  return `${summary.slice(0, maxChars)}\n[truncated: this result is ${count(summary.length)} characters; the first ${count(maxChars)} are shown (${SOLO_MAX_TOOL_RESULT_CHARS_KEY})]`;
}

/** One tool result as the model reads it. The tool is the action's head, else the adapter. */
export function renderToolResult(record: ToolCallRecord, maxChars: number = DEFAULT_SOLO_MAX_TOOL_RESULT_CHARS): string {
  const tool = toolNameOf(record.action) || record.adapter;
  return `<tool_result tool="${tool}" status="${record.status}">\n${capToolResult(record.summary, maxChars)}\n</tool_result>`;
}

function asGatewayMessage(message: SoloMessage, maxChars: number): GatewayMessage {
  if (message.role === "assistant") return { role: "assistant", content: message.content };
  if (message.role === "tool") return { role: "user", content: message.record === undefined ? capToolResult(message.content, maxChars) : renderToolResult(message.record, maxChars) };
  // `user`, and `system`, which is only ever a compaction summary: it stands in for turns, so it
  // is read as the conversation's own text, never as a second system prompt.
  return { role: "user", content: message.content };
}

/** Consecutive messages of one role become one, so roles alternate for every provider. */
export function mergeRoles(messages: readonly GatewayMessage[]): GatewayMessage[] {
  const out: GatewayMessage[] = [];
  for (const message of messages) {
    const previous = out.at(-1);
    if (previous !== undefined && previous.role === message.role && message.role !== "system") {
      out[out.length - 1] = { role: previous.role, content: `${previous.content}${SEPARATOR}${message.content}` };
    } else out.push({ ...message });
  }
  return out;
}

export function historyMessages(history: readonly SoloMessage[], maxToolResultChars: number = DEFAULT_SOLO_MAX_TOOL_RESULT_CHARS): GatewayMessage[] {
  return mergeRoles(history.map((message) => asGatewayMessage(message, maxToolResultChars)));
}
