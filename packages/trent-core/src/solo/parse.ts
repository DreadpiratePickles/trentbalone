/**
 * [S1] What a model reply asks for: a final answer, or tool calls.
 *
 * A call is a `<tool_call>` block whose body is the `<tool> <json>` action every adapter already
 * documents in its `instructions` (`tools/action.ts`). The body is validated with `parseAction`
 * against the tool names the adapters answer to, and handed to the adapter VERBATIM: the adapter
 * parses its own arguments, and the idempotency key and the bound approval row are computed from
 * exactly what the model wrote (`governance/idempotent-dispatch.ts`, `bound-approvals.ts`).
 *
 * A reply with no block is the answer. Anything else that cannot be attributed to one tool (an
 * unknown tool, JSON that does not parse, a block that is not closed, a block with no tool name,
 * an empty reply) is `malformed`, with the parse error the loop hands back for one repair.
 */
import { parseAction, type ToolSpec } from "../tools/action.js";
import type { TrentToolAdapter } from "../tools/types.js";

export const TOOL_CALL_OPEN = "<tool_call>";
export const TOOL_CALL_CLOSE = "</tool_call>";

const BLOCK = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
const STRAY_TAG = /<\/?tool_call>/i;
/** A markdown fence line a model wraps a block body in. */
const FENCE_LINE = /^\s*```[\w-]*\s*$/gm;

export interface SoloAction {
  readonly adapter: TrentToolAdapter;
  /** The `<tool>` head, lowercased. */
  readonly tool: string;
  /** The block body as the adapter receives it: `<tool> <json>`. */
  readonly action: string;
}

export type ParsedReply =
  | { readonly kind: "answer"; readonly text: string }
  | { readonly kind: "actions"; readonly narration: string; readonly actions: readonly SoloAction[] }
  | { readonly kind: "malformed"; readonly error: string };

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
 * One spec per tool name. Only the name is used: a body always names its tool here (an empty head
 * is refused before `parseAction` runs), so the bare-JSON inference that reads `signature` is never
 * reached, and the adapter, not this module, reads the arguments.
 */
function specsOf(adapters: readonly TrentToolAdapter[]): ToolSpec[] {
  const names = [...new Set(adapters.flatMap(toolNamesOf))];
  return names.map((name) => ({ name, primary: "input", signature: [] }));
}

function headOf(body: string): string {
  const brace = body.indexOf("{");
  return ((brace === -1 ? body : body.slice(0, brace)).trim().split(/\s+/)[0] ?? "").toLowerCase();
}

const malformed = (error: string): ParsedReply => ({ kind: "malformed", error });

export function parseReply(reply: string, adapters: readonly TrentToolAdapter[]): ParsedReply {
  const text = reply.trim();
  if (text === "") return malformed("the reply was empty; answer in plain text, or call a tool");

  const bodies: string[] = [];
  let narration = "";
  let last = 0;
  for (const match of text.matchAll(BLOCK)) {
    narration += text.slice(last, match.index);
    bodies.push(match[1] ?? "");
    last = (match.index ?? 0) + match[0].length;
  }
  narration = `${narration}${text.slice(last)}`;
  if (STRAY_TAG.test(narration)) return malformed(`a ${TOOL_CALL_OPEN} block is not closed with ${TOOL_CALL_CLOSE}`);
  if (bodies.length === 0) return { kind: "answer", text };

  const specs = specsOf(adapters);
  const actions: SoloAction[] = [];
  for (const raw of bodies) {
    const action = raw.replace(FENCE_LINE, "").trim();
    if (action === "") return malformed(`a ${TOOL_CALL_OPEN} block is empty`);
    if (headOf(action) === "") return malformed(`a ${TOOL_CALL_OPEN} block must start with the tool's name, then its JSON arguments: <tool> {"key": "value"}`);
    const parsed = parseAction(action, specs);
    if (parsed.error !== undefined) return malformed(parsed.error);
    const adapter = resolveAdapter(adapters, parsed.tool);
    if (adapter === undefined) return malformed(`no registered adapter answers to "${parsed.tool}"`);
    actions.push({ adapter, tool: parsed.tool, action });
  }
  return { kind: "actions", narration: narration.trim(), actions };
}
