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
// [C15] The prompt written for solo (council C15; Hermes `agent/prompt_builder.py`): no seats, no
// founder, no nightly consolidation, none of which a solo conversation has. After the persona come
// the rules every persona keeps (`SOLO_RULES`: use a tool rather than guess and never claim a call,
// make nothing up, several independent calls in one reply, run one after another as `turn.ts` runs
// them, what to save to memory and never a secret, load a listed skill), and the prefix ENDS with the
// platform hint when the conversation is a gateway thread (`soloPlatformHint`), so everything before
// it is the same bytes on every platform. The disclosure shows an adapter's solo text when it offers
// one (`memory`: add, replace and remove) and says "person" where the fleet's text says "founder".
// The rendered default is measured in `prompt-default.test.ts`.
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

// [C15] Identity and voice only: the rules below are kept whatever persona `solo.md` replaces this with.
export const DEFAULT_SOLO_PERSONA =
  "You are Trent, an assistant working for one person: the person in this conversation. You act for them " +
  "with the tools below and keep what matters to them in memory from one conversation to the next. Be " +
  "direct: match the length of your reply to the question, skip filler, and when you finish a piece of work " +
  "say what you did, what it showed and what is left.";

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

// [C15] The solo rules and the platform hint slot.
/** [C15] The rules every solo session is told, after the persona, whoever wrote the persona. */
export const SOLO_RULES = [
  "## Using tools",
  "- When a tool can get a fact you do not have, or do what the person asked, call it instead of guessing or describing what you would do. If you say you will do something, make the call in that same reply.",
  "- Say plainly what each tool reported. Never say a tool ran, or what it returned, unless its result is in this conversation. A call held for approval has not run: say it is waiting for the person.",
  "",
  "## No made-up facts",
  "- Never invent facts, numbers, names, quotes, links, file contents or tool output. When you do not know and cannot find out, say so; when you are unsure, say that too.",
  '- When a tool fails, say what failed and try another way if there is one. A plain "I could not" is better than a plausible guess.',
  "",
  "## Several calls in one reply",
  "When you need several things that do not depend on each other, such as two files or three searches, ask for all of them in one reply: it saves a round trip. They run one after another, in the order you wrote them, so a call that needs another call's result belongs in your next reply.",
  "",
  "## What to save to memory",
  "The memory tool keeps short notes that are loaded into your prompt at the start of every conversation; what you save now is there from the next conversation on. " +
    'Save durable facts about the person (where they live, their work, how they like to be helped), decisions they made and standing conventions, written as plain statements ("Lives in York"), not as orders to yourself. ' +
    "When a fact changes, replace the old entry instead of adding a second one; when the person asks you to forget something, remove it. " +
    "Do not save task progress or anything you can look up again, and never save a secret: no passwords, API keys, tokens, or card or account numbers. " +
    "After you read a web page or other outside content in this conversation, a memory write is held for the person's approval, or refused where nobody can approve it: say which, and do not call it saved.",
  "",
  "## Following a skill",
  "When this prompt lists skills and one covers the task, load it with skill_view before you start, and follow it.",
].join("\n");

/** [C15] The gateway's platform ids (`gateway/registry.ts`), as a person names them. */
const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  telegram: "Telegram",
  whatsapp: "WhatsApp",
  signal: "Signal",
  slack: "Slack",
  discord: "Discord",
  teams: "Microsoft Teams",
  matrix: "Matrix",
  mattermost: "Mattermost",
  line: "LINE",
  email: "email",
  homeassistant: "Home Assistant",
  ntfy: "ntfy",
};

/** [C15] How a reply reads there. A chat shows Markdown tables and headings badly or as raw symbols. */
const CHAT_ADVICE = "keep replies short, no Markdown tables or headings: plain sentences and short lists read best in a chat.";
const PLATFORM_ADVICE: Readonly<Record<string, string>> = {
  email: "write a complete reply in plain text, no Markdown; it is sent as an email in this thread.",
  homeassistant: "reply in one or two plain sentences, no Markdown.",
  ntfy: "reply in one or two plain sentences, no Markdown: it arrives as a notification.",
};

/** A platform id that is safe to name in a prompt; anything else is described, never echoed. */
const PLATFORM_ID = /^[a-z][a-z0-9_-]{0,31}$/i;

/** [C15] The platform hint for a gateway conversation: where the person is, and how a reply should read there. */
export function soloPlatformHint(platform: string): string {
  const given = platform.trim();
  const id = given.toLowerCase();
  const name = PLATFORM_NAMES[id] ?? (PLATFORM_ID.test(given) ? given : "a messaging platform");
  return `You are talking over ${name}; ${PLATFORM_ADVICE[id] ?? CHAT_ADVICE}`;
}

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

/** [C15] The fleet's word for the human, as solo says it. A quoted value (an argument) is never touched. */
const FOUNDER = /(?<![\w"'])([Ff])ounder(?![\w"])/g;

/** [C15] An adapter's own solo text when it offers one (`memory`: replace and remove), else its instructions. */
function soloTextOf(adapter: TrentToolAdapter): string {
  const perMode = (adapter as { instructionsFor?: (mode: "solo") => string }).instructionsFor;
  return typeof perMode === "function" ? perMode.call(adapter, "solo") : adapter.instructions;
}

/** [S1.1] C1: an adapter's instructions in the one call format: no `action =` line, no `toolCall.*`, examples as bodies. */
export function soloInstructions(adapter: TrentToolAdapter): string {
  const text = soloTextOf(adapter) // [C15] the adapter's solo text, and "person" for "founder"
    .replace(FOUNDER, (_match, initial: string) => (initial === "F" ? "Person" : "person"))
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
  /** [C15] A gateway thread's platform id (`InboundMessage.platform`); absent on the REPL and a one-off run. */
  readonly platform?: string;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const tools = renderToolDisclosure(input.adapters);
  // [C15] The rules after the persona; the platform hint last, so the prefix before it is the same on every platform.
  const platform = input.platform === undefined || input.platform.trim() === "" ? "" : `## Where you are talking\n${soloPlatformHint(input.platform)}`;
  return [input.persona.trim(), SOLO_RULES, input.stable.trim(), SOLO_TOOL_PROTOCOL, tools, platform].filter((part) => part !== "").join(SEPARATOR);
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
