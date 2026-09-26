/**
 * [C11] The five-case tool-call smoke on the SOLO format (council C11, section 7 item 4: this score decides
 * whether new profiles default to solo).
 *
 * L0-4's cases, prompts and judge (`local-smoke.ts`) are the fleet's seat format. Solo sends a turn
 * differently, and each difference is taken from the solo runner itself, not restated:
 *   - the system prompt is `buildSystemPrompt` (the default persona, the tool protocol, the tool
 *     disclosure in the one call format `soloInstructions` renders), over ONE adapter per case: the
 *     `file_ops` toolset with the case's one tool, whose instructions are the seat case's own
 *     (`renderToolInstructions`), exactly as a real adapter's are rewritten for solo;
 *   - the case is the turn's opening after its context tier (`assembleTurnContext`, `renderTurnOpening`),
 *     as `runner.ts` opens every turn;
 *   - the reply is decoded under the solo envelope (`soloEnvelopeFormat`, the tool names as an enum), with its
 *     instruction at the system message's end (`withEnvelopeInstruction`), exactly what a solo turn sends under a
 *     local alias, and read by the solo parser (`parseReply`, envelope on).
 * The judge is the case's own, so a solo score and a seat score measure the same five behaviours.
 */
import type { GatewayMessage } from "../../model-gateway/types.js";
import { parseReply } from "../../solo/parse.js";
import { DEFAULT_SOLO_PERSONA, assembleTurnContext, buildSystemPrompt, renderTurnOpening } from "../../solo/prompt.js";
import { soloEnvelopeFormat, withEnvelopeInstruction } from "../../solo/turn-settings.js";
import { record } from "../../tools/action.js";
import type { TrentToolAdapter } from "../../tools/types.js";
import { renderToolInstructions } from "../../tools/web/schemas.js";
import type { SmokeCase, SmokeFormat, Turn } from "./local-smoke.js";

/** The toolset a case's tool belongs to, as the seat case names it. */
const TOOLSET = "file_ops";
const MAX_REASON_CHARS = 160;

/** The case's one tool as a solo adapter. The smoke only reads what the model asks for: nothing is ever run. */
export function soloSmokeAdapter(smoke: SmokeCase): TrentToolAdapter {
  return {
    name: TOOLSET,
    scopes: [TOOLSET, ...smoke.tools.map((tool) => tool.name)],
    instructions: renderToolInstructions(smoke.tools),
    routingText: "",
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    execute: async (action) => record(TOOLSET, action, "failed", "the doctor's smoke test never runs a tool"),
    cleanup: async () => undefined,
  };
}

/** The case as a constrained solo turn: the solo system prompt with the envelope's instruction (as `turn.ts` sends it), then the turn's opening. */
export function soloSmokeMessages(smoke: SmokeCase, now: Date = new Date()): GatewayMessage[] {
  const context = assembleTurnContext({ now, blocks: [], stable: [] });
  const adapters = [soloSmokeAdapter(smoke)];
  return withEnvelopeInstruction<GatewayMessage>([
    { role: "system", content: buildSystemPrompt({ persona: DEFAULT_SOLO_PERSONA, stable: "", adapters }) },
    { role: "user", content: renderTurnOpening(context.text, smoke.user) },
  ], soloEnvelopeFormat(adapters));
}

function argsOf(action: string): Record<string, unknown> {
  const brace = action.indexOf("{");
  if (brace === -1) return {};
  try {
    const parsed: unknown = JSON.parse(action.slice(brace));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const UNKNOWN_TOOL = /^Unknown tool "([^"]*)"/;

/**
 * A solo reply as the judge reads a turn: an answer is a finish; the first call is the call (its tool as the
 * parser resolved it, so a toolset named instead of its tool stays the toolset); a tool that was not offered
 * is a call not offered; anything else the parser refuses is invalid, with its reason.
 */
export function readSoloTurn(text: string, smoke: SmokeCase): Turn {
  const reply = parseReply(text, [soloSmokeAdapter(smoke)], { envelope: true });
  if (reply.kind === "answer") return { kind: "finish", summary: reply.text };
  if (reply.kind === "malformed") {
    const unknown = UNKNOWN_TOOL.exec(reply.error);
    if (unknown !== null) return { kind: "call", tool: unknown[1] ?? "", args: {}, offered: false };
    return { kind: "invalid", reason: reply.error.slice(0, MAX_REASON_CHARS) };
  }
  const first = reply.actions[0];
  if (first === undefined) return { kind: "invalid", reason: "the reply asked for no call" };
  return { kind: "call", tool: first.tool, args: argsOf(first.action), offered: true };
}

/** The solo format for `runSmoke`: the solo turn, the solo envelope, the solo parser. */
export const SOLO_SMOKE_FORMAT: SmokeFormat = {
  messages: (smoke) => soloSmokeMessages(smoke),
  read: readSoloTurn,
  responseFormat: (smoke) => soloEnvelopeFormat([soloSmokeAdapter(smoke)]),
};
