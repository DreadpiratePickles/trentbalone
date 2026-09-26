/**
 * [L1] A seat turn under constrained decoding: what the seat may call, the schema the runtime decodes
 * under, and the re-rendering into the shape the app's seat loop already parses.
 *
 * WHY. On L0-4's live smoke qwen3.5:9b scored 1/5 on the fleet's tool-call format, JSON escaped inside
 * a JSON string (`{"toolCall": {"name", "action": "<tool> <json>"}}`), writing
 * `"action": "read_file", {...}` instead (docs/sessions/2026-09-26-harness-landscape.md). BFCL V4 finds
 * non-standard formats cost small models the most (research F8). So on a local provider the port asks
 * for a flat `{thought?, tool?, args?, final?}` with `tool` an enum, and the runtime's grammar makes
 * anything else undecodable (`model-gateway/response-format.ts`).
 *
 * WHAT THE APP READS (`apps/web/lib/seat-agent-loop.ts`, read-only): `{toolCall: {name, action}, summary:
 * null}` to call, `{toolCall: null, summary, findings, recommendations, riskNotes, whatIDidNotDo,
 * workRequests}` to finish; `name` is an adapter or one of its scopes, and every Trent adapter lists its
 * tools as scopes. `action` is the `<tool> <json>` string `tools/action.ts` parses for a tool whose
 * usage form the prompt renders, and bare JSON (attributed by its keys) for any other name.
 *
 * THE ENUM comes from the app's own prompt: every `action = "<tool> {...}"` usage form between the last
 * `Available tools:` line and the prior tool results, then the advertised names. Tool results cannot add
 * a name (they come after), and the enum is a decoding aid only: the app still enforces the seat's
 * allowlist before anything runs.
 */

import type { GatewayMessage, GatewayResponseFormat } from "../model-gateway/types.js";
import type { SeatTurn, TurnFailure } from "../model-gateway/tool-call-repair.js";

export const SEAT_TURN_SCHEMA_NAME = "seat_turn";

export const CONSTRAINED_SEAT_INSTRUCTION =
  "Reply format for this turn, which replaces the toolCall/action format described in the request: one JSON object. " +
  'To call a tool: {"tool": "<tool name>", "args": {<the tool\'s arguments as JSON keys>}}. ' +
  'When you are done: {"final": "<your complete answer, with its findings and recommendations>"}. ' +
  'You may begin with "thought": one short sentence.';

export interface SeatTurnContext {
  /** The app sent a tool loop turn (`Available tools:` present): the model may call or finish. */
  readonly toolLoop: boolean;
  /** The names `tool` may take: rendered usage forms first, then the advertised names. */
  readonly tools: readonly string[];
  /** The names whose usage form (`action = "<tool> {...}"`) the prompt renders. */
  readonly rendered: readonly string[];
}

const TOOLS_LINE = /^Available tools: (.*)$/;
const REGION_END = /^(Prior tool results|Respond as JSON)/;
const USAGE_FORM = /action = "([A-Za-z0-9_.:-]+) \{/g;

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

export function readSeatTurnContext(messages: ReadonlyArray<{ readonly role?: string; readonly content: string }>): SeatTurnContext {
  const lines = messages.map((message) => message.content).join("\n").split("\n");
  let at = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (TOOLS_LINE.test(lines[index]!)) {
      at = index;
      break;
    }
  }
  if (at < 0) return { toolLoop: false, tools: [], rendered: [] };
  const advertised = (TOOLS_LINE.exec(lines[at]!)?.[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "" && name.toLowerCase() !== "none");
  const region: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (REGION_END.test(line)) break;
    region.push(line);
  }
  const rendered = unique([...region.join("\n").matchAll(USAGE_FORM)].map((match) => match[1]!));
  return { toolLoop: true, tools: unique([...rendered, ...advertised]), rendered };
}

/** The schema of one turn. `requireTool` is the one re-ask after a turn that neither acted nor finished. */
export function seatTurnFormat(context: SeatTurnContext, options: { readonly requireTool?: boolean } = {}): GatewayResponseFormat {
  const canCall = context.tools.length > 0;
  const properties: Record<string, unknown> = {
    thought: { type: "string" },
    ...(canCall ? { tool: { type: "string", enum: [...context.tools] }, args: { type: "object" } } : {}),
    final: { type: "string" },
  };
  const required = canCall ? (options.requireTool === true ? ["tool", "args"] : undefined) : ["final"];
  return {
    type: "json_schema",
    json_schema: { name: SEAT_TURN_SCHEMA_NAME, schema: { type: "object", properties, ...(required === undefined ? {} : { required }), additionalProperties: false } },
  };
}

/** The port's messages with the reply format appended to the system message; the app's prompt is untouched. */
export function withConstrainedInstruction(messages: readonly GatewayMessage[], context: SeatTurnContext): GatewayMessage[] {
  const tools = context.tools.length > 0 ? ` Tool names: ${context.tools.join(", ")}.` : ' This turn has no tools: reply with {"final": ...}.';
  const instruction = `${CONSTRAINED_SEAT_INSTRUCTION}${tools}`;
  const out = [...messages];
  const first = out[0];
  if (first !== undefined && first.role === "system") out[0] = { role: "system", content: `${first.content}\n\n${instruction}` };
  else out.unshift({ role: "system", content: instruction });
  return out;
}

const EMPTY_FINISH = { findings: [], recommendations: [], riskNotes: [], whatIDidNotDo: [], workRequests: [] } as const;

/** The turn in the shape `apps/web/lib/seat-agent-loop.ts` parses today. */
export function renderSeatTurn(turn: SeatTurn, context: SeatTurnContext): Record<string, unknown> {
  if (turn.kind === "legacy") return turn.object;
  if (turn.kind === "final") return { ...(context.toolLoop ? { toolCall: null } : {}), summary: turn.final, ...EMPTY_FINISH };
  const usageForm = context.rendered.includes(turn.tool);
  const action = !turn.argsGiven ? turn.tool : usageForm ? `${turn.tool} ${JSON.stringify(turn.args)}` : JSON.stringify(turn.args);
  return { toolCall: { name: turn.tool, action }, summary: null };
}

/**
 * A seat turn that was still unusable after its one re-ask. Thrown, so the app records the seat's error
 * and runs no tool: an unusable call is a failure, never a call with empty arguments. The seat port puts
 * both model calls on it (`trent_usage`, `trent_usage_prior`) so the meter still records what they spent.
 */
export class SeatTurnError extends Error {
  readonly failure: TurnFailure;

  constructor(failure: TurnFailure) {
    super(`seat turn unusable after one re-ask: ${failure.kind}: ${failure.message}`);
    this.name = "SeatTurnError";
    this.failure = failure;
  }
}
