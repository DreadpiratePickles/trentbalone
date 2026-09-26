/**
 * [S1.1] C1: the model's own tool-call format. Qwen and Hermes models are trained on
 * `<tool_call>{"name": ..., "arguments": {...}}</tool_call>`; the parser accepts that body and
 * normalises it to the `<tool> <json>` action every adapter, idempotency key and bound row already
 * reads, still accepts the legacy `<tool> <json>` line inside a block, strips `<think>` before it
 * looks for a call, repairs a raw newline inside a JSON string, and, when the runner asked for
 * constrained JSON, reads the `{"tool_calls": [...]}` / `{"answer": ...}` envelope.
 */
import { describe, expect, it } from "vitest";
import { fakeAdapter } from "./fakes.test-helpers.js";
import { parseReply, stripThinking } from "./parse.js";

const files = fakeAdapter({ name: "file_ops", tools: ["read_file", "write_file"] });
const ADAPTERS = [files];

const actionsOf = (reply: string, options?: { envelope?: boolean }) => {
  const parsed = parseReply(reply, ADAPTERS, options);
  if (parsed.kind !== "actions") throw new Error(`expected actions, got ${JSON.stringify(parsed)}`);
  return parsed.actions.map((a) => [a.adapter.name, a.tool, a.action]);
};

describe("[S1.1] C1: the Hermes/Qwen body", () => {
  it("is read and normalised to the <tool> <json> action the adapter receives", () => {
    expect(actionsOf('<tool_call>\n{"name": "read_file", "arguments": {"path": "a.md"}}\n</tool_call>')).toEqual([["file_ops", "read_file", 'read_file {"path":"a.md"}']]);
  });

  it("takes arguments given as a JSON string, and no arguments as {}", () => {
    expect(actionsOf('<tool_call>{"name": "read_file", "arguments": "{\\"path\\": \\"b.md\\"}"}</tool_call>')).toEqual([["file_ops", "read_file", 'read_file {"path":"b.md"}']]);
    expect(actionsOf('<tool_call>{"name": "read_file"}</tool_call>')).toEqual([["file_ops", "read_file", "read_file {}"]]);
  });

  it("still accepts the legacy <tool> <json> line inside a block, verbatim", () => {
    expect(actionsOf('<tool_call>\nread_file {"path": "c.md"}\n</tool_call>')).toEqual([["file_ops", "read_file", 'read_file {"path": "c.md"}']]);
  });

  it("repairs a raw newline or tab inside a JSON string instead of failing the call", () => {
    const reply = '<tool_call>{"name": "write_file", "arguments": {"path": "quote.txt", "content": "She said \\"yes\\".\nThen\tshe left."}}</tool_call>';
    const [[, , action]] = actionsOf(reply) as [[string, string, string]];
    expect(JSON.parse(action.slice(action.indexOf("{")))).toEqual({ path: "quote.txt", content: 'She said "yes".\nThen\tshe left.' });
  });

  it("refuses a body with no name, or an unknown tool, in words that teach the one format", () => {
    const noName = parseReply('<tool_call>{"arguments": {"path": "a.md"}}</tool_call>', ADAPTERS);
    expect(noName).toMatchObject({ kind: "malformed" });
    expect(noName.kind === "malformed" ? noName.error : "").toContain('{"name": "<tool>", "arguments": {');
    const unknown = parseReply('<tool_call>{"name": "email_send", "arguments": {}}</tool_call>', ADAPTERS);
    const error = unknown.kind === "malformed" ? unknown.error : "";
    expect(error).toContain('Unknown tool "email_send"');
    expect(error).toContain("read_file, write_file");
    expect(error).not.toContain("toolCall.action");
  });
});

describe("[S1.1] C1: <think> is never parsed, run or kept", () => {
  it("a call drafted inside <think> does not run; the text after it is the answer", () => {
    const reply = '<think>I could call <tool_call>{"name": "write_file", "arguments": {"path": "x"}}</tool_call> but no.</think>\nThe answer is 42.';
    expect(parseReply(reply, ADAPTERS)).toEqual({ kind: "answer", text: "The answer is 42." });
  });

  it("a reply that carries only the closing tag (the opening one was in the template) is cut after it", () => {
    expect(stripThinking("planning the call...</think>\n\nDone.")).toBe("Done.");
    expect(stripThinking("Answer first. <think>unfinished")).toBe("Answer first.");
  });

  it("a real call after the thinking runs, and the reply kept for history has no thinking in it", () => {
    const parsed = parseReply('<think>read it</think><tool_call>{"name": "read_file", "arguments": {"path": "a.md"}}</tool_call>', ADAPTERS);
    expect(parsed).toMatchObject({ kind: "actions", reply: '<tool_call>{"name": "read_file", "arguments": {"path": "a.md"}}</tool_call>' });
  });
});

describe("[S1.1] C1: the constrained-JSON envelope, only when the runner asked for it", () => {
  it("reads tool_calls and answer", () => {
    expect(actionsOf('{"tool_calls": [{"name": "read_file", "arguments": {"path": "a.md"}}]}', { envelope: true })).toEqual([["file_ops", "read_file", 'read_file {"path":"a.md"}']]);
    expect(parseReply('{"answer": "It ships in 5 days."}', ADAPTERS, { envelope: true })).toEqual({ kind: "answer", text: "It ships in 5 days." });
  });

  it("without the option a JSON reply is just the answer text", () => {
    expect(parseReply('{"answer": "x"}', ADAPTERS)).toEqual({ kind: "answer", text: '{"answer": "x"}' });
  });
});
