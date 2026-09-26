/**
 * The five-case tool-call smoke test and the time-to-first-token prompt (local-models D2, D3).
 *
 * The fleet's tool calls are JSON in the reply, not native function calling: a seat answers
 * `{ "toolCall": { "name": <toolset>, "action": "<tool> <json>" }, "summary": null }` or finishes with
 * `{ "toolCall": null, "summary": ... }` (`apps/web/lib/model-gateway.ts:341-343`), the seat port adds
 * `SEAT_JSON_INSTRUCTION` and cuts the first JSON object out of the reply (`extractJsonObject`), and
 * the action is parsed by `tools/action.ts` `parseAction`. Each case is scored on exactly that
 * path, through the wrapper's model gateway, one tool per prompt:
 *   call          the tool is needed: call it with the right argument;
 *   abstain       no tool is needed: answer without one;
 *   escaping      an argument with double quotes and a newline must survive JSON inside JSON;
 *   required      the tool's required argument must be present;
 *   unknown-tool  the task tempts a tool that was not offered: never call one.
 */
import { randomUUID } from "node:crypto";
import { extractJsonObject } from "../../model-gateway/completion-port.js";
import type { ReasoningEffort } from "../../model-gateway/call-policy.js";
import type { GatewayMessage, GatewayResponseFormat, ModelProvider } from "../../model-gateway/types.js"; // [C11] GatewayResponseFormat
import { SEAT_JSON_INSTRUCTION } from "../../orchestrator/seat-gateway-port.js";
import { parseAction, type ToolSpec } from "../../tools/action.js";
import { renderToolInstructions, type ToolSchema } from "../../tools/web/schemas.js";
import { timedOut, withDeadline } from "../probe.js";
import { localStreamProvider, type LocalChatRoute } from "./local-stream.js";

export type SmokeCaseId = "call" | "abstain" | "escaping" | "required" | "unknown-tool";

/** The toolset name a seat puts in `toolCall.name`. */
const ADAPTER = "file_ops";

const READ_FILE: ToolSchema = {
  name: "read_file",
  description: "Read a text file in the workspace.",
  parameters: { type: "object", properties: { path: { type: "string", description: "Workspace-relative path" } }, required: ["path"] },
};
const WRITE_FILE: ToolSchema = {
  name: "write_file",
  description: "Create or overwrite a text file in the workspace.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Workspace-relative path" }, content: { type: "string", description: "The full file content" } },
    required: ["path", "content"],
  },
};
const SEARCH_FILES: ToolSchema = {
  name: "search_files",
  description: "Search the workspace's files for text.",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string", description: "Text or regular expression to find" }, path: { type: "string", description: "Directory to search; the workspace root when absent" } },
    required: ["pattern"],
  },
};

const SPECS: Readonly<Record<string, ToolSpec>> = {
  read_file: { name: "read_file", primary: "path", signature: ["path"] },
  write_file: { name: "write_file", primary: "path", signature: ["path", "content"] },
  search_files: { name: "search_files", primary: "pattern", signature: ["pattern"] },
};

export const ESCAPING_CONTENT = 'She said "yes".\nThen she left.';

export type Turn = // [C11] exported: the solo variant reads its replies into the same turn
  | { kind: "finish"; summary: string }
  | { kind: "call"; tool: string; args: Record<string, unknown>; error?: string; offered: boolean }
  | { kind: "invalid"; reason: string };

export interface SmokeCase {
  readonly id: SmokeCaseId;
  readonly tools: readonly ToolSchema[];
  readonly user: string;
  /** A failure reason, or undefined when the turn passes. */
  judge(turn: Exclude<Turn, { kind: "invalid" }>): string | undefined;
}

function needsCall(turn: Exclude<Turn, { kind: "invalid" }>, tool: string): Extract<Turn, { kind: "call" }> | string {
  if (turn.kind === "finish") return `answered without calling ${tool}`;
  if (!turn.offered) return `called ${turn.tool || "a tool"}, which was not offered`;
  if (turn.error !== undefined) return turn.error;
  if (turn.tool !== tool) return `called ${turn.tool} instead of ${tool}`;
  return turn;
}

export const SMOKE_CASES: readonly SmokeCase[] = [
  {
    id: "call",
    tools: [READ_FILE],
    user: "Read the file notes/todo.md in the workspace.",
    judge(turn) {
      const call = needsCall(turn, "read_file");
      if (typeof call === "string") return call;
      return call.args.path === "notes/todo.md" ? undefined : `path was ${JSON.stringify(call.args.path)}`;
    },
  },
  {
    id: "abstain",
    tools: [READ_FILE],
    user: "What is 17 + 25? Answer directly; no file is involved.",
    judge: (turn) => (turn.kind === "call" ? `called ${turn.tool || "a tool"} when no tool was needed` : undefined),
  },
  {
    id: "escaping",
    tools: [WRITE_FILE],
    user: `Create the file quote.txt containing exactly these two lines, keeping the double quotes:\n${ESCAPING_CONTENT}`,
    judge(turn) {
      const call = needsCall(turn, "write_file");
      if (typeof call === "string") return call;
      if (String(call.args.path ?? "").replace(/^\.\//, "") !== "quote.txt") return `path was ${JSON.stringify(call.args.path)}`;
      const content = typeof call.args.content === "string" ? call.args.content.replace(/\s+$/, "") : undefined;
      return content === ESCAPING_CONTENT ? undefined : `content arrived as ${JSON.stringify(call.args.content ?? null).slice(0, 60)}`;
    },
  },
  {
    id: "required",
    tools: [SEARCH_FILES],
    user: "Find every file in the workspace that mentions the word invoice.",
    judge(turn) {
      const call = needsCall(turn, "search_files");
      if (typeof call === "string") return call;
      const pattern = call.args.pattern;
      if (typeof pattern !== "string" || pattern.trim() === "") return "the required pattern argument was missing";
      return /invoice/i.test(pattern) ? undefined : `pattern was ${JSON.stringify(pattern)}`;
    },
  },
  {
    id: "unknown-tool",
    tools: [READ_FILE],
    user: "Email alex@example.com that the quarterly report is ready.",
    judge: (turn) => (turn.kind === "call" && !turn.offered ? `called ${turn.tool || "a tool"}, which was not offered` : undefined),
  },
];

/** The seat prompt's shape (`apps/web/lib/model-gateway.ts:320-345`), cut to one tool. */
export function smokeMessages(smoke: SmokeCase): GatewayMessage[] {
  const system = [
    "You are one seat of an AI fleet, working in the user's workspace.",
    `Available tools: ${ADAPTER}`,
    "Tool-specific instructions:",
    renderToolInstructions(smoke.tools),
    "Respond as JSON. Either call a tool OR finish:",
    '{ "toolCall": { "name": string, "action": string }, "summary": null } — to invoke a tool,',
    'OR { "toolCall": null, "summary": string } — when done.',
  ].join("\n");
  return [
    { role: "system", content: `${system}\n\n${SEAT_JSON_INSTRUCTION}` },
    { role: "user", content: smoke.user },
  ];
}

/** Read one reply the way the seat port and the tool bridge would. */
export function readTurn(text: string, smoke: SmokeCase): Turn {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch {
    return { kind: "invalid", reason: text.trim() === "" ? "the reply was empty" : "the reply was not JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "invalid", reason: "the reply was not a JSON object" };
  const turn = parsed as { toolCall?: unknown; summary?: unknown };
  if (turn.toolCall === null || turn.toolCall === undefined) {
    return typeof turn.summary === "string" && turn.summary.trim() !== ""
      ? { kind: "finish", summary: turn.summary }
      : { kind: "invalid", reason: "the reply had neither a toolCall nor a summary" };
  }
  if (typeof turn.toolCall !== "object") return { kind: "invalid", reason: "toolCall was not an object" };
  const { name, action } = turn.toolCall as { name?: unknown; action?: unknown };
  if (typeof action !== "string" || action.trim() === "") return { kind: "invalid", reason: 'toolCall.action was not a "<tool> <json>" string' };
  const specs = smoke.tools.map((tool) => SPECS[tool.name]!).filter(Boolean);
  const offeredNames = new Set([ADAPTER, ...specs.map((spec) => spec.name)]);
  const call = parseAction(action, specs);
  const named = typeof name === "string" ? name.trim() : "";
  const offered = (named === "" || offeredNames.has(named)) && !/^Unknown tool/.test(call.error ?? "");
  return {
    kind: "call",
    tool: call.tool || named,
    args: call.args,
    offered,
    ...(call.error === undefined ? {} : { error: /^Malformed JSON/.test(call.error) ? "the action's JSON did not parse" : call.error }),
  };
}

export interface SmokeCaseOutcome {
  readonly id: SmokeCaseId;
  readonly pass: boolean;
  readonly reason?: string;
  readonly ms: number;
}

export interface SmokeReport {
  readonly score: number;
  readonly total: number;
  readonly cases: readonly SmokeCaseOutcome[];
}

export interface SmokeInput {
  readonly route: LocalChatRoute;
  readonly provider: ModelProvider;
  readonly model: string;
  readonly caseTimeoutMs: number;
  readonly maxTokens: number;
  readonly reasoningEffort?: ReasoningEffort;
}

function seconds(ms: number): string {
  return Number((ms / 1000).toFixed(2)).toString();
}

// [C11] How one format sends a case and reads the reply; the judge is the case's own, whatever the format.
export interface SmokeFormat {
  messages(smoke: SmokeCase): GatewayMessage[];
  read(text: string, smoke: SmokeCase): Turn;
  /** Constrained output for the case (the solo envelope); absent, the call is unconstrained. */
  responseFormat?(smoke: SmokeCase): GatewayResponseFormat;
}

/** [C11] The fleet's seat format: the seat prompt, read the way the seat port and the tool bridge read it. */
export const SEAT_SMOKE_FORMAT: SmokeFormat = { messages: smokeMessages, read: readTurn };

/** Run the five cases in order, each through the gateway under its own deadline. */
export async function runSmoke(input: SmokeInput, format: SmokeFormat = SEAT_SMOKE_FORMAT): Promise<SmokeReport> { // [C11] format
  // Loaded here, not at module scope: a hosted profile's doctor run never evaluates the gateway.
  const { createModelGateway } = await import("../../model-gateway/index.js");
  const gateway = await createModelGateway({
    streamProvider: localStreamProvider(input.route),
    retry: { attempts: 1 },
    retryLog: () => undefined,
    redactionLog: () => undefined,
    fallbackOnPin: false,
    ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
  });
  const cases: SmokeCaseOutcome[] = [];
  for (const smoke of SMOKE_CASES) {
    const started = performance.now();
    const reply = await withDeadline(async (signal) => {
      try {
        const responseFormat = format.responseFormat?.(smoke); // [C11]
        const completion = await gateway.complete({ role: "executor", provider: input.provider, model: input.model, messages: format.messages(smoke), maxTokens: input.maxTokens, signal, ...(responseFormat === undefined ? {} : { responseFormat }) });
        return { text: completion.text };
      } catch (error) {
        return { error: (error instanceof Error ? error.message : String(error)).slice(0, 160) };
      }
    }, input.caseTimeoutMs);
    const ms = Math.round(performance.now() - started);
    let reason: string | undefined;
    if (timedOut(reply)) reason = `no reply within ${seconds(input.caseTimeoutMs)} s`;
    else if ("error" in reply) reason = reply.error;
    else {
      const turn = format.read(reply.text, smoke); // [C11]
      reason = turn.kind === "invalid" ? turn.reason : smoke.judge(turn);
    }
    cases.push({ id: smoke.id, pass: reason === undefined, ...(reason === undefined ? {} : { reason }), ms });
  }
  return { score: cases.filter((c) => c.pass).length, total: cases.length, cases };
}

const OWNERS = ["Ada", "Bo", "Chen", "Dara", "Emeka", "Farah", "Goran", "Hana"];
/**
 * Characters per token of this filler, measured: 16437 characters were 3718 prompt tokens on
 * qwen3.5:9b through Ollama 0.32.9 (2026-09-26, docs/sessions/2026-09-26-l0-4-doctor.md).
 */
const FILLER_CHARS_PER_TOKEN = 4.4;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/**
 * About `targetTokens` tokens of plain prose (at the measured rate above), led by a fresh id so no
 * runtime can answer it from a prompt cache: the measurement is a cold prefill.
 * Words, not figures: tokenizers that split digits one by one would turn a numeric filler into far
 * more tokens than its length suggests. The runtime's own `prompt_tokens` is reported when it sends it.
 */
export function firstTokenPrompt(targetTokens: number, nonce: string = randomUUID()): string {
  const lines = [`Doctor probe ${nonce}. The ledger notes below are filler of a realistic size; read them, then answer the question at the end.`];
  let chars = lines[0]!.length;
  for (let n = 1; chars < targetTokens * FILLER_CHARS_PER_TOKEN; n += 1) {
    const line = `Note ${n}: on ${DAYS[n % DAYS.length]} the account kept by ${OWNERS[n % OWNERS.length]} was reconciled, and its balance was checked against the open invoices; nothing was outstanding.`;
    lines.push(line);
    chars += line.length + 1;
  }
  lines.push("Question: reply with the single word OK.");
  return lines.join("\n");
}
