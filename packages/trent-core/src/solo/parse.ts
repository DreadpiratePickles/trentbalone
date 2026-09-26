/**
 * [S1] What a model reply asks for: a final answer, or tool calls.
 *
 * [S1.1] C1: the one format the prompt teaches is the model's own. A call is a `<tool_call>` block
 * whose body is `{"name": "<tool>", "arguments": {...}}`: Hermes's wire format and the one Qwen and
 * Hermes models are trained on. The body is normalised to the `<tool> <json>` action every adapter
 * already documents (`tools/action.ts`) BEFORE it reaches the adapter, so the idempotency key and
 * the bound approval row are computed exactly as before (`governance/idempotent-dispatch.ts`,
 * `bound-approvals.ts` key on the parsed arguments, never on spacing). The legacy `<tool> <json>`
 * line inside a block is still accepted and handed over verbatim.
 *
 * Before anything is looked for, `<think>...</think>` is removed (local-models G7): a call drafted
 * while thinking must never run, and the thinking is never persisted or replayed. A raw newline or
 * tab inside a JSON string is escaped rather than failing the call (local-models R1, F3). When the
 * runner asked for constrained output, the reply may be the envelope itself:
 * `{"tool_calls": [{"name", "arguments"}]}` or `{"answer": "..."}`.
 *
 * A reply with no block is the answer. Anything else that cannot be attributed to one tool (an
 * unknown tool, JSON that does not parse, a block that is not closed, a body with no name, an empty
 * reply) is `malformed`, with the error the loop hands back for one repair.
 *
 * // [C14] A model with native tools (Claude through `model-gateway/anthropic-client.ts`) answers with
 * `tool_use` blocks, which arrive as `GatewayCompletion.toolCalls`. Each becomes the SAME `<tool> <json>` action
 * a `<tool_call>` body produces (`fromCallObject`), carrying its `callId`. A text block in the same reply still
 * runs; a call written both ways runs once. A local model keeps the text protocol and constrained output.
 */
import type { GatewayToolCall } from "../model-gateway/types.js"; // [C14]
import { parseAction, type ToolSpec } from "../tools/action.js";
import type { TrentToolAdapter } from "../tools/types.js";

export const TOOL_CALL_OPEN = "<tool_call>";
export const TOOL_CALL_CLOSE = "</tool_call>";
/** [S1.1] The one call body the prompt, the repair and every error teach. */
export const TOOL_CALL_BODY_SHAPE = '{"name": "<tool>", "arguments": {"key": "value"}}';

const BLOCK = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
const STRAY_TAG = /<\/?tool_call>/i;
/** A markdown fence line a model wraps a block body in. */
const FENCE_LINE = /^\s*```[\w-]*\s*$/gm;
const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
const THINK_CLOSE = /<\/think>/gi;
const THINK_OPEN = /<think>/i;
const MAX_NAMES_LISTED = 40;

export interface SoloAction {
  readonly adapter: TrentToolAdapter;
  /** The `<tool>` head, lowercased. */
  readonly tool: string;
  /** The call as the adapter receives it: `<tool> <json>`. */
  readonly action: string;
  readonly callId?: string; // [C14] a native call's provider id (Anthropic `tool_use.id`), which its result answers
}

export type ParsedReply =
  | { readonly kind: "answer"; readonly text: string }
  /** `reply` is the model's text with the thinking removed: what the history keeps. */
  | { readonly kind: "actions"; readonly narration: string; readonly actions: readonly SoloAction[]; readonly reply: string }
  | { readonly kind: "malformed"; readonly error: string; readonly reply: string };

export interface ParseOptions {
  /** The request carried a `responseFormat`: the reply may be the `{"tool_calls"}` / `{"answer"}` envelope. */
  readonly envelope?: boolean;
  readonly toolCalls?: readonly GatewayToolCall[]; // [C14] the completion's native calls; absent or empty reads the text protocol
}

/** The tool names an adapter answers to: its name, and its scopes that are not `area:verb` capability tags. */
export function toolNamesOf(adapter: TrentToolAdapter): string[] {
  return [...new Set([adapter.name, ...adapter.scopes].filter((name) => !name.includes(":")).map((name) => name.toLowerCase()))];
}

/** The adapter a tool name belongs to: the first whose name, then the first whose scopes, carry it. */
export function resolveAdapter(adapters: readonly TrentToolAdapter[], tool: string): TrentToolAdapter | undefined {
  const wanted = tool.toLowerCase();
  return adapters.find((adapter) => adapter.name.toLowerCase() === wanted) ?? adapters.find((adapter) => toolNamesOf(adapter).includes(wanted));
}

/**
 * [S1.1] The reply without its thinking: every `<think>...</think>`; everything up to a closing tag
 * whose opening one was in the chat template (Qwen3); everything after an opening tag never closed.
 */
export function stripThinking(reply: string): string {
  let text = reply.replace(THINK_BLOCK, "");
  const closes = [...text.matchAll(THINK_CLOSE)];
  const last = closes.at(-1);
  if (last !== undefined) text = text.slice((last.index ?? 0) + last[0].length);
  const open = text.search(THINK_OPEN);
  if (open !== -1) text = text.slice(0, open);
  return text.trim();
}

/** [S1.1] A raw newline, carriage return or tab inside a JSON string is escaped; nothing outside a string changes. */
export function escapeControlCharsInStrings(json: string): string {
  const escapes: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
    } else if (escaped) {
      escaped = false;
      out += ch;
    } else if (ch === "\\") {
      escaped = true;
      out += ch;
    } else if (ch === '"') {
      inString = false;
      out += ch;
    } else out += escapes[ch] ?? ch;
  }
  return out;
}

function parseJson(text: string): { readonly value?: unknown; readonly error?: string } {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (first) {
    try {
      return { value: JSON.parse(escapeControlCharsInStrings(text)) as unknown };
    } catch {
      return { error: first instanceof Error ? first.message : String(first) };
    }
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function unknownTool(tool: string, adapters: readonly TrentToolAdapter[]): string {
  const names = [...new Set(adapters.flatMap(toolNamesOf))];
  const listed = names.length > MAX_NAMES_LISTED ? `${names.slice(0, MAX_NAMES_LISTED).join(", ")}, ...` : names.join(", ");
  return `Unknown tool "${tool}"; the tools are: ${listed || "none"}. Call one as ${TOOL_CALL_BODY_SHAPE}`;
}

/** `{"name", "arguments"}` (or the envelope's entry) as the action the adapter receives. */
function fromCallObject(value: unknown, adapters: readonly TrentToolAdapter[]): SoloAction | string {
  if (!isObject(value) || typeof value.name !== "string" || value.name.trim() === "") return `a ${TOOL_CALL_OPEN} body must be ${TOOL_CALL_BODY_SHAPE}`;
  const tool = value.name.trim().toLowerCase();
  const adapter = resolveAdapter(adapters, tool);
  if (adapter === undefined) return unknownTool(tool, adapters);
  let args: unknown = value.arguments ?? value.parameters ?? {};
  if (typeof args === "string") {
    const parsed = args.trim() === "" ? { value: {} } : parseJson(args);
    if (parsed.error !== undefined) return `Malformed JSON in the arguments of ${tool} (${parsed.error}). Write the call as ${TOOL_CALL_BODY_SHAPE}`;
    args = parsed.value;
  }
  if (!isObject(args)) return `the arguments of ${tool} must be a JSON object: ${TOOL_CALL_BODY_SHAPE}`;
  return { adapter, tool, action: `${tool} ${JSON.stringify(args)}` };
}

/** One spec per tool name, for the legacy line: only the name is used, the adapter reads its own arguments. */
function specsOf(adapters: readonly TrentToolAdapter[]): ToolSpec[] {
  return [...new Set(adapters.flatMap(toolNamesOf))].map((name) => ({ name, primary: "input", signature: [] }));
}

function headOf(body: string): string {
  const brace = body.indexOf("{");
  return ((brace === -1 ? body : body.slice(0, brace)).trim().split(/\s+/)[0] ?? "").toLowerCase();
}

/** The legacy `<tool> <json>` line, handed over verbatim (or with its raw control characters escaped). */
function fromLegacyLine(body: string, adapters: readonly TrentToolAdapter[]): SoloAction | string {
  const head = headOf(body);
  if (resolveAdapter(adapters, head) === undefined) return unknownTool(head, adapters);
  const specs = specsOf(adapters);
  let action = body;
  let parsed = parseAction(action, specs);
  if (parsed.error !== undefined) {
    const repaired = escapeControlCharsInStrings(body);
    const again = parseAction(repaired, specs);
    if (again.error === undefined) [action, parsed] = [repaired, again];
  }
  if (parsed.error !== undefined) return `Malformed JSON in the arguments of ${head}. Write the call as ${TOOL_CALL_BODY_SHAPE}`;
  const adapter = resolveAdapter(adapters, parsed.tool);
  if (adapter === undefined) return unknownTool(parsed.tool, adapters);
  return { adapter, tool: parsed.tool, action };
}

function fromBody(raw: string, adapters: readonly TrentToolAdapter[]): SoloAction | string {
  const body = raw.replace(FENCE_LINE, "").trim();
  if (body === "") return `a ${TOOL_CALL_OPEN} block is empty; write ${TOOL_CALL_BODY_SHAPE} inside it`;
  if (body.startsWith("{")) {
    const parsed = parseJson(body);
    if (parsed.error !== undefined) return `Malformed JSON in a ${TOOL_CALL_OPEN} block (${parsed.error}). Write the call as ${TOOL_CALL_BODY_SHAPE}`;
    return fromCallObject(parsed.value, adapters);
  }
  return fromLegacyLine(body, adapters);
}

const malformed = (error: string, reply: string): ParsedReply => ({ kind: "malformed", error, reply });

function actionsOrError(calls: readonly (SoloAction | string)[], narration: string, reply: string): ParsedReply {
  const error = calls.find((call): call is string => typeof call === "string");
  if (error !== undefined) return malformed(error, reply);
  return { kind: "actions", narration, actions: calls as SoloAction[], reply };
}

/** [S1.1] The constrained-output envelope; undefined when the reply is not a JSON object at all. */
function fromEnvelope(text: string, adapters: readonly TrentToolAdapter[]): ParsedReply | undefined {
  if (!text.startsWith("{")) return undefined;
  const parsed = parseJson(text);
  if (parsed.error !== undefined || !isObject(parsed.value)) return undefined;
  const { tool_calls: calls, answer } = parsed.value;
  if (Array.isArray(calls) && calls.length > 0) return actionsOrError(calls.map((call) => fromCallObject(call, adapters)), "", text);
  if (typeof answer === "string" && answer.trim() !== "") return { kind: "answer", text: answer.trim() };
  return malformed('the reply must be {"tool_calls": [' + TOOL_CALL_BODY_SHAPE + ']} or {"answer": "..."}', text);
}

/** [C14] The `<tool_call>` bodies of a reply and the text around them (moved out of `parseReply` unchanged). */
function scanBlocks(text: string): { readonly bodies: string[]; readonly narration: string } { // [C14]
  const bodies: string[] = [];
  let narration = "";
  let last = 0;
  for (const match of text.matchAll(BLOCK)) {
    narration += text.slice(last, match.index);
    bodies.push(match[1] ?? "");
    last = (match.index ?? 0) + match[0].length;
  }
  return { bodies, narration: `${narration}${text.slice(last)}` };
}

const STRAY = `a ${TOOL_CALL_OPEN} block is not closed with ${TOOL_CALL_CLOSE}`; // [C14] shared by both paths

/**
 * [C14] Native calls first, each normalised exactly as a text body is, then any text blocks not already among them.
 * The history keeps the text plus each native call rendered in the one format the prompt teaches.
 */
function withNativeCalls(text: string, calls: readonly GatewayToolCall[], adapters: readonly TrentToolAdapter[]): ParsedReply { // [C14]
  const scan = scanBlocks(text);
  if (STRAY_TAG.test(scan.narration)) return malformed(STRAY, text);
  const native: (SoloAction | string)[] = calls.map((call) => {
    const action = fromCallObject({ name: call.name, arguments: call.arguments }, adapters);
    return typeof action === "string" ? action : { ...action, callId: call.id };
  });
  const keyOf = (call: SoloAction): string => `${call.adapter.name}\u0000${call.action}`;
  const seen = new Set(native.filter((call): call is SoloAction => typeof call !== "string").map(keyOf));
  const written = scan.bodies.map((body) => fromBody(body, adapters)).filter((call) => typeof call === "string" || !seen.has(keyOf(call)));
  const rendered = calls.map((call) => `${TOOL_CALL_OPEN}${JSON.stringify({ name: call.name, arguments: call.arguments })}${TOOL_CALL_CLOSE}`);
  return actionsOrError([...native, ...written], scan.narration.trim(), [text, ...rendered].filter((part) => part !== "").join("\n"));
}

export function parseReply(reply: string, adapters: readonly TrentToolAdapter[], options: ParseOptions = {}): ParsedReply {
  const text = stripThinking(reply);
  if (options.toolCalls !== undefined && options.toolCalls.length > 0) return withNativeCalls(text, options.toolCalls, adapters); // [C14]
  if (text === "") return malformed("the reply was empty; answer in plain text, or call a tool", text);
  if (options.envelope === true) {
    const envelope = fromEnvelope(text, adapters);
    if (envelope !== undefined) return envelope;
  }

  const { bodies, narration } = scanBlocks(text); // [C14] moved into scanBlocks, unchanged
  if (STRAY_TAG.test(narration)) return malformed(STRAY, text);
  if (bodies.length === 0) return { kind: "answer", text };
  return actionsOrError(bodies.map((body) => fromBody(body, adapters)), narration.trim(), text);
}
