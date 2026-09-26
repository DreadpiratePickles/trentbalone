/**
 * [L1] Repair, then retry, never fake success: one seat turn from a small local model, read into a tool
 * call or a final answer, or refused with a reason the seat port puts in front of the model once.
 *
 * Requirements (01_discovery/output/local-models-2026-09-26.md §8.3, R1-R4; failure modes §5.1):
 *   - R1 repair first: `<think>` blocks (F9), `<tool_call>` tags and markdown fences are removed; literal
 *     tabs and newlines inside JSON strings are escaped and stray control characters dropped (F3,
 *     hermes-agent PR 15356); a reply that lost its closing braces is balanced ONCE.
 *   - R2 never fake success (F4, hermes-agent issue 89207, truncated arguments "silently replaced with
 *     `{}`"): an open string at the end is a cut-off argument, never closed into a shorter call; a reply
 *     the server stopped at `max_tokens` is never balanced at all. Either is a failure with its reason.
 *   - R3 an unknown tool is refused with the closest allowed name (F5).
 *   - R4 a reply that neither calls a tool nor finishes is `no_action` (F6), which the seat port re-asks
 *     once with a schema that makes the tool mandatory.
 *
 * The shape asked for is `{thought?, tool?, args?, final?}` (`orchestrator/seat-constrained.ts`). Two
 * more are read because models write them unasked: the native `{name, arguments}` tool-call convention
 * (Qwen, Hermes), and the app's own `{toolCall, summary}`, which is passed through for the app to read.
 * Pure: no I/O, no clock.
 */

export interface ToolTurn {
  readonly kind: "tool";
  readonly tool: string;
  readonly args: Record<string, unknown>;
  /** False when the reply had no `args` key: the call is rendered without an argument object. */
  readonly argsGiven: boolean;
}
export interface FinalTurn {
  readonly kind: "final";
  readonly final: string;
}
/** The app's own `{toolCall, summary}` shape, handed to the app unchanged. */
export interface LegacyTurn {
  readonly kind: "legacy";
  readonly object: Record<string, unknown>;
}
export type SeatTurn = ToolTurn | FinalTurn | LegacyTurn;

export type TurnFailureKind = "unparseable" | "truncated" | "unknown_tool" | "no_action" | "bad_args";

export interface TurnFailure {
  readonly kind: TurnFailureKind;
  readonly message: string;
  readonly suggestion?: string;
}

export type RepairResult =
  | { readonly ok: true; readonly turn: SeatTurn; readonly repairs: readonly string[] }
  | { readonly ok: false; readonly failure: TurnFailure; readonly repairs: readonly string[] };

export interface RepairOptions {
  /** The names a call may use. Empty: the turn may only finish. */
  readonly allowedTools: readonly string[];
  /** The server stopped the reply at `max_tokens` (`finish_reason: "length"`). */
  readonly truncated?: boolean;
}

// ── cleaning ───────────────────────────────────────────────────────────────────

function stripWrappers(text: string, repairs: string[]): string {
  let out = text;
  const closeAt = out.toLowerCase().lastIndexOf("</think>");
  if (closeAt >= 0) {
    out = out.slice(closeAt + "</think>".length);
    repairs.push("think_stripped");
  } else if (/<think>/i.test(out)) {
    out = out.slice(0, out.search(/<think>/i)); // an unclosed block: the answer never came
    repairs.push("think_stripped");
  }
  if (/<\/?tool_call>/i.test(out)) {
    out = out.replace(/<\/?tool_call>/gi, "");
    repairs.push("tool_call_tag_stripped");
  }
  const fence = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/.exec(out);
  if (fence) {
    out = fence[1] ?? "";
    repairs.push("fence_stripped");
  }
  return out.trim();
}

/** Escapes control characters inside strings (a literal tab or newline) and drops them outside. */
function escapeControlCharacters(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of json) {
    const code = char.charCodeAt(0);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      else if (code < 0x20) {
        out += char === "\n" ? "\\n" : char === "\t" ? "\\t" : char === "\r" ? "\\r" : `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += char;
      continue;
    }
    if (char === '"') inString = true;
    if (code < 0x20 && char !== "\n" && char !== "\r" && char !== "\t") continue;
    out += char;
  }
  return out;
}

type Balance = { readonly text: string } | { readonly openString: true } | { readonly nothingToClose: true } | { readonly missingValue: true };

/** Appends the closers a reply lost at its end. Never closes a string: an open one is cut-off content. */
function balance(json: string): Balance {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if ((char === "}" || char === "]") && stack.at(-1) === char) stack.pop();
  }
  if (inString) return { openString: true };
  if (stack.length === 0) return { nothingToClose: true };
  const trimmed = json.replace(/[\s,]+$/, "");
  if (/[:]$/.test(trimmed)) return { missingValue: true };
  return { text: trimmed + stack.reverse().join("") };
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

type Parsed = { readonly object: Record<string, unknown> } | { readonly failure: TurnFailure };

function parseReply(raw: string, truncated: boolean, repairs: string[]): Parsed {
  const start = raw.indexOf("{");
  if (start < 0) return { failure: { kind: truncated ? "truncated" : "unparseable", message: raw.trim() === "" ? "The reply was empty." : "The reply was not a JSON object." } };
  const body = raw.slice(start, raw.lastIndexOf("}") >= start ? raw.lastIndexOf("}") + 1 : raw.length);
  const direct = parseObject(body);
  if (direct) return { object: direct };
  const escaped = escapeControlCharacters(body);
  if (escaped !== body) {
    const object = parseObject(escaped);
    if (object) {
      repairs.push("control_characters_escaped");
      return { object };
    }
  }
  const tail = escapeControlCharacters(raw.slice(start)); // balance from the reply's real end, not the last brace
  if (truncated) return { failure: { kind: "truncated", message: "The reply was cut off at the output limit before its JSON ended." } };
  const balanced = balance(tail);
  if ("openString" in balanced) return { failure: { kind: "unparseable", message: "The reply was cut off inside a string: its arguments are incomplete." } };
  if ("text" in balanced) {
    const object = parseObject(balanced.text);
    if (object) {
      repairs.push("json_balanced");
      if (tail !== raw.slice(start)) repairs.push("control_characters_escaped");
      return { object };
    }
  }
  return { failure: { kind: "unparseable", message: "The reply's JSON did not parse." } };
}

// ── names ──────────────────────────────────────────────────────────────────────

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/** The allowed name nearest to `name`: one it contains first (`file_ops.read_file`), else the fewest edits. */
export function closestName(name: string, allowed: readonly string[]): string | undefined {
  const wanted = name.trim().toLowerCase();
  const contained = allowed.filter((candidate) => wanted.includes(candidate.toLowerCase())).sort((a, b) => b.length - a.length)[0];
  if (contained !== undefined) return contained;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of allowed) {
    const distance = editDistance(wanted, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

// ── the turn ───────────────────────────────────────────────────────────────────

function readArgs(value: unknown, repairs: string[]): { args: Record<string, unknown>; given: boolean } | TurnFailure {
  if (value === undefined) return { args: {}, given: false };
  if (typeof value === "string") {
    const decoded = parseObject(value);
    if (decoded === undefined) return { kind: "bad_args", message: "args was a string that is not a JSON object." };
    repairs.push("args_decoded");
    return { args: decoded, given: true };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { kind: "bad_args", message: "args must be a JSON object of the tool's arguments." };
  return { args: value as Record<string, unknown>, given: true };
}

function readTool(name: string, rawArgs: unknown, options: RepairOptions, repairs: string[]): { turn: ToolTurn } | TurnFailure {
  const wanted = name.trim();
  let tool = options.allowedTools.find((candidate) => candidate === wanted);
  if (tool === undefined) {
    tool = options.allowedTools.find((candidate) => candidate.toLowerCase() === wanted.toLowerCase());
    if (tool !== undefined) repairs.push("tool_name_case");
  }
  if (tool === undefined) {
    const suggestion = closestName(wanted, options.allowedTools);
    const names = options.allowedTools.length > 0 ? options.allowedTools.join(", ") : "none: this turn may only finish";
    return { kind: "unknown_tool", message: `Unknown tool "${wanted}". The allowed tools are: ${names}.`, ...(suggestion === undefined ? {} : { suggestion }) };
  }
  const args = readArgs(rawArgs, repairs);
  if ("kind" in args) return args;
  return { turn: { kind: "tool", tool, args: args.args, argsGiven: args.given } };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export function repairSeatTurn(text: string, options: RepairOptions): RepairResult {
  const repairs: string[] = [];
  const parsed = parseReply(stripWrappers(text, repairs), options.truncated === true, repairs);
  if ("failure" in parsed) return { ok: false, failure: parsed.failure, repairs };
  const object = parsed.object;
  const done = (outcome: { turn: SeatTurn } | TurnFailure): RepairResult =>
    "turn" in outcome ? { ok: true, turn: outcome.turn, repairs } : { ok: false, failure: outcome, repairs };
  if (nonEmptyString(object.tool)) return done(readTool(object.tool, object.args, options, repairs));
  if (object.tool === undefined && nonEmptyString(object.name) && ("arguments" in object || "parameters" in object)) {
    repairs.push("native_tool_call");
    return done(readTool(object.name, object.arguments ?? object.parameters, options, repairs));
  }
  if ("toolCall" in object || ("summary" in object && !("final" in object))) return done({ turn: { kind: "legacy", object } });
  if (nonEmptyString(object.final)) return done({ turn: { kind: "final", final: object.final } });
  return done({ kind: "no_action", message: "The reply neither called a tool nor finished." });
}

/** The user message of the one re-ask: what went wrong, the nearest name, and the one shape to answer in. */
export function reaskMessage(failure: TurnFailure, allowedTools: readonly string[]): string {
  const hint = failure.suggestion === undefined ? "" : ` Did you mean "${failure.suggestion}"?`;
  const tools = allowedTools.length > 0 ? allowedTools.join(", ") : "";
  const shape =
    tools === ""
      ? 'Reply again with one JSON object: {"final": "<your answer>"}.'
      : failure.kind === "no_action"
        ? `Reply again with one JSON object that calls a tool: {"tool": "<one of: ${tools}>", "args": {<its arguments>}}.`
        : `Reply again with one JSON object: {"tool": "<one of: ${tools}>", "args": {<its arguments>}} to call a tool, or {"final": "<your answer>"} when you are done.`;
  return `Your previous reply could not be used: ${failure.message}${hint} ${shape} No prose, no markdown fences.`;
}
