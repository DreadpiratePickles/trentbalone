/**
 * [C11] The two per-conversation settings a surface hands the solo runner (council C11), one rule for
 * every caller (`apps/cli/src/runtime/runner-for-mode.ts`, a delegated child, `solo.live.test.ts`):
 *
 *   responseFormat  the solo envelope (`soloResponseFormat`: `{"tool_calls": [{name, arguments}]}` or
 *                   `{"answer"}`, the tools' names as an enum) when constrained output applies on this
 *                   process's route. That is the seats' own rule (`constrainedOutputApplies`, L1): a local
 *                   alias, unless `models.local.constrained_output` is false; `all` adds hosted providers.
 *                   By default a hosted provider keeps the `<tool_call>` text protocol. A 9B writes its
 *                   own shape unconstrained: the L1 seat smoke went from 2/5 to 4/5 with a schema.
 *   maxToolCalls    `agent.solo.max_tool_calls`, validated by the schema (`config/sections/agent.ts`);
 *                   absent, the runner's default (`DEFAULT_SOLO_MAX_TOOL_CALLS`).
 *
 * The envelope is sent in the form a local server's grammar ENFORCES (`soloEnvelopeFormat`). Live run 1
 * (docs/sessions/2026-09-26-c11-solo-live.md) sent `soloResponseFormat` as it stands: one object with both
 * properties and a top-level `oneOf` of branches that carry only `required`. llama.cpp's json-schema-to-grammar,
 * which Ollama uses, reads `oneOf`/`anyOf` before `properties`, and a branch with neither `type` nor
 * `properties` is no object rule, so qwen3.5:9b on Ollama 0.32.9 was decoded under no schema at all (a tool
 * outside the enum, a bare string, a bare number). The probe that followed: the same two alternatives as
 * complete objects in an `anyOf` were enforced for a call and for an answer; a flat object with neither
 * required let the model say `{}`. Live run 2, with the schema enforced, showed the other half: the model must
 * be TOLD the envelope (`SOLO_ENVELOPE_INSTRUCTION`), or it never answers.
 */
import { constrainedOutputApplies } from "../model-gateway/local-runtime.js";
import type { TrentToolAdapter } from "../tools/types.js";
import { soloResponseFormat } from "./prompt.js";
import type { SoloConfig, SoloResponseFormat } from "./types.js";

export type SoloTurnSettings = Pick<SoloConfig, "maxToolCalls" | "responseFormat">;

/** `agent.solo.max_tool_calls` of a parsed config; read loosely, because a surface's config type may not name the `agent` block. */
export function soloMaxToolCalls(config: unknown): number | undefined {
  const value = (config as { agent?: { solo?: { max_tool_calls?: unknown } } } | undefined)?.agent?.solo?.max_tool_calls;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * The solo envelope as an `anyOf` of two complete objects (a call list, or an answer), each with its one
 * property required and nothing else allowed. The call item and the tool enum are `soloResponseFormat`'s own;
 * only the envelope's form changes. Throws if that format no longer has the two properties, so a change there
 * fails a test instead of silently sending an unenforced schema.
 */
export function soloEnvelopeFormat(adapters: readonly TrentToolAdapter[]): SoloResponseFormat {
  const source = soloResponseFormat(adapters);
  if (source.type !== "json_schema") return source;
  const properties = (source.json_schema.schema as { properties?: Record<string, unknown> }).properties ?? {};
  const alternative = (key: "tool_calls" | "answer"): Record<string, unknown> => {
    if (properties[key] === undefined) throw new TypeError(`soloResponseFormat has no "${key}" property; the solo envelope cannot be built from it`);
    return { type: "object", properties: { [key]: properties[key] }, required: [key], additionalProperties: false };
  };
  return { type: "json_schema", json_schema: { name: source.json_schema.name, schema: { anyOf: [alternative("tool_calls"), alternative("answer")] } } };
}

/**
 * What the model is told when it is decoded under the envelope. The solo prompt teaches `<tool_call>` blocks
 * and a plain-text answer, neither of which the grammar allows; without this, live run 2 made the same
 * `read_file` call 26 times and never answered (L1's seats needed the same: `CONSTRAINED_SEAT_INSTRUCTION`).
 */
export const SOLO_ENVELOPE_INSTRUCTION =
  "## Reply format\n" +
  "Each reply you write is one JSON object, and it replaces the <tool_call> blocks and the plain-text answer described above. " +
  'To call tools: {"tool_calls": [{"name": "<tool name>", "arguments": {<the tool\'s arguments>}}]}; every result comes back in the next message. ' +
  'When you have what you need: {"answer": "<your complete answer to the person>"}. ' +
  "Never call a tool again for a result you already have: answer with it.";

/**
 * The messages as a constrained request sends them: the instruction at the end of the system message, once.
 * Applied per request by the turn loop (`turn.ts`), as L1's seat port does, so the stored conversation and the
 * session's frozen prefix never change; the suffix is constant, so a provider's prompt cache still hits.
 */
export function withEnvelopeInstruction<M extends { readonly role: string; readonly content: string }>(messages: readonly M[], format: SoloResponseFormat | undefined): M[] {
  if (format === undefined) return [...messages];
  const index = messages.findIndex((message) => message.role === "system");
  if (index === -1) return [{ role: "system", content: SOLO_ENVELOPE_INSTRUCTION } as M, ...messages];
  return messages.map((message, i) => (i === index ? { ...message, content: `${message.content}\n\n${SOLO_ENVELOPE_INSTRUCTION}` } : message));
}

/** What a runner over `adapters` is configured with: only the keys that apply, so the defaults stay the runner's. */
export function soloTurnSettings(config: unknown, adapters: readonly TrentToolAdapter[], env: NodeJS.ProcessEnv = process.env): SoloTurnSettings {
  const maxToolCalls = soloMaxToolCalls(config);
  return {
    ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
    ...(constrainedOutputApplies(env) ? { responseFormat: soloEnvelopeFormat(adapters) } : {}),
  };
}
