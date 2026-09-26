/**
 * [CF] C11 open item 1: the solo envelope has ONE source. `soloResponseFormat` (prompt.ts) stated it as one
 * object with a top-level `oneOf` of `required`-only branches, which llama.cpp's json-schema-to-grammar (Ollama)
 * does not enforce (docs/sessions/2026-09-26-c11-solo-live.md, live run 1), and `soloEnvelopeFormat`
 * (turn-settings.ts) restated it as the `anyOf` of two complete objects that is enforced. Both names and
 * signatures stay; they now emit the same schema. Pure: no server, no model.
 */
import { describe, expect, it } from "vitest";
import { fakeAdapter } from "./fakes.test-helpers.js";
import { soloResponseFormat } from "./prompt.js";
import { soloEnvelopeFormat } from "./turn-settings.js";

const files = fakeAdapter({ name: "file_ops", tools: ["read_file", "write_file"] });

describe("[CF] the solo envelope, stated once", () => {
  it("soloResponseFormat has no top-level oneOf: it is the anyOf of a complete call object and a complete answer object", () => {
    const format = soloResponseFormat([files]);
    const schema = format.type === "json_schema" ? (format.json_schema.schema as Record<string, unknown>) : {};
    expect(schema.oneOf).toBeUndefined();
    expect(schema.properties).toBeUndefined();
    expect(schema.anyOf).toEqual([
      { type: "object", properties: { tool_calls: expect.objectContaining({ type: "array", minItems: 1 }) }, required: ["tool_calls"], additionalProperties: false },
      { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false },
    ]);
    expect(format).toMatchObject({ type: "json_schema", json_schema: { name: "solo_turn" } });
  });

  it("soloEnvelopeFormat and soloResponseFormat emit the identical schema", () => {
    expect(soloEnvelopeFormat([files])).toEqual(soloResponseFormat([files]));
  });
});
