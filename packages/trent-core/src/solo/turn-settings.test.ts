/**
 * [C11] `soloTurnSettings`: what a surface hands the solo runner. The envelope must be a schema a local
 * server's grammar ENFORCES: live run 1 (docs/sessions/2026-09-26-c11-solo-live.md) sent
 * `soloResponseFormat`'s top-level `oneOf` of `required`-only branches, and Ollama 0.32.9 decoded nothing
 * under it (a tool outside the enum, a bare string, a bare number). An `anyOf` of two complete objects was
 * enforced on both paths in the probe that followed. Pure: no server, no model.
 */
import { describe, expect, it } from "vitest";
import { fakeAdapter } from "./fakes.test-helpers.js";
import { SOLO_ENVELOPE_INSTRUCTION, soloEnvelopeFormat, soloTurnSettings, withEnvelopeInstruction } from "./turn-settings.js";

const LOCAL = { TRENT_MODEL_ALIAS: "ollama" };
const files = fakeAdapter({ name: "file_ops", tools: ["read_file", "write_file"] });
type Schema = { anyOf?: Array<Record<string, unknown>>; oneOf?: unknown; properties?: unknown };
const schemaOf = (env: NodeJS.ProcessEnv): Schema | undefined => {
  const format = soloTurnSettings({}, [files], env).responseFormat;
  return format?.type === "json_schema" ? (format.json_schema.schema as Schema) : undefined;
};

describe("[C11] the solo envelope as a local server enforces it", () => {
  it("is an anyOf of two complete objects, one per reply kind, each with its one property required and nothing else", () => {
    const schema = schemaOf(LOCAL);
    expect(schema?.oneOf).toBeUndefined();
    expect(schema?.properties).toBeUndefined();
    expect(schema?.anyOf).toEqual([
      { type: "object", properties: { tool_calls: expect.objectContaining({ type: "array", minItems: 1 }) }, required: ["tool_calls"], additionalProperties: false },
      { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
    ]);
  });

  it("names every tool of the adapters in the call's enum, and keeps the name solo_turn", () => {
    const format = soloTurnSettings({}, [files], LOCAL).responseFormat;
    expect(format).toMatchObject({ type: "json_schema", json_schema: { name: "solo_turn" } });
    const calls = (schemaOf(LOCAL)?.anyOf?.[0] as { properties: { tool_calls: { items: { properties: { name: { enum: string[] } }; required: string[] } } } }).properties.tool_calls.items;
    expect(calls.properties.name.enum).toEqual(["file_ops", "read_file", "write_file"]);
    expect(calls.required).toEqual(["name", "arguments"]);
  });

  it("is sent only where constrained output applies: a local alias, or `all`; never on a hosted route by default, never when switched off", () => {
    expect(schemaOf({})).toBeUndefined();
    expect(schemaOf({ ...LOCAL, TRENT_LOCAL_CONSTRAINED_OUTPUT: "false" })).toBeUndefined();
    expect(schemaOf({ TRENT_LOCAL_CONSTRAINED_OUTPUT: "all" })?.anyOf).toHaveLength(2);
  });

  it("carries agent.solo.max_tool_calls when set, and nothing when absent", () => {
    expect(soloTurnSettings({ agent: { solo: { max_tool_calls: 60 } } }, [files], {})).toEqual({ maxToolCalls: 60 });
    expect(soloTurnSettings({ agent: {} }, [files], {})).toEqual({});
  });
});

describe("[C11] the model is told the envelope whenever it is decoded under it", () => {
  // Live run 2: the schema enforced, the model called read_file 26 times and never answered, because the only
  // reply rule it had was the text protocol's ("reply in plain text"), which the grammar makes impossible.
  const messages = [
    { role: "system" as const, content: "SYSTEM PREFIX" },
    { role: "user" as const, content: "Read notes/brief.txt" },
  ];

  it("names both replies: the tool_calls list and the answer, and says a result already had is not asked for again", () => {
    expect(SOLO_ENVELOPE_INSTRUCTION).toContain('{"tool_calls": [{"name": ');
    expect(SOLO_ENVELOPE_INSTRUCTION).toContain('{"answer": ');
    expect(SOLO_ENVELOPE_INSTRUCTION).toMatch(/already/);
  });

  it("is appended to the system message of a constrained request, and to nothing else; the input is not changed", () => {
    const sent = withEnvelopeInstruction(messages, soloEnvelopeFormat([files]));
    expect(sent[0]?.content).toBe(`SYSTEM PREFIX\n\n${SOLO_ENVELOPE_INSTRUCTION}`);
    expect(sent[1]).toEqual(messages[1]);
    expect(messages[0]?.content).toBe("SYSTEM PREFIX");
  });

  it("leaves an unconstrained request exactly as it was", () => {
    expect(withEnvelopeInstruction(messages, undefined)).toEqual(messages);
  });
});
