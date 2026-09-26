/**
 * [L1] Repair, then retry, never fake success (local-models research §8.3 R1-R4; failure modes F2-F6).
 *
 * The fixtures are the shapes small local models are documented to produce: a `<think>` block before
 * the answer, a fenced answer, literal tabs and newlines inside a JSON string (F3, llama.cpp and Ollama),
 * a closing brace dropped at the end, arguments cut off mid-string (F4: must never become `{}`), an
 * unknown tool name (F5), and a reply that neither acts nor finishes (F6). The last fixture is what
 * qwen3.5:9b actually wrote on the doctor's smoke (L0-4, 2026-09-26).
 */
import { describe, expect, it } from "vitest";

import { closestName, reaskMessage, repairSeatTurn } from "./tool-call-repair.js";

const TOOLS = ["read_file", "write_file", "search_files"] as const;

function ok(text: string, options: { truncated?: boolean } = {}) {
  const result = repairSeatTurn(text, { allowedTools: TOOLS, ...options });
  if (!result.ok) throw new Error(`expected a turn, got ${result.failure.kind}: ${result.failure.message}`);
  return result;
}

function failed(text: string, options: { truncated?: boolean } = {}) {
  const result = repairSeatTurn(text, { allowedTools: TOOLS, ...options });
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.turn)}`);
  return result.failure;
}

describe("[L1] repair: what a small model wraps around its answer is removed", () => {
  it("strips a <think> block, even one holding JSON of its own", () => {
    const result = ok('<think>maybe {"tool":"write_file"}</think>\n{"tool":"read_file","args":{"path":"notes/todo.md"}}');
    expect(result.turn).toEqual({ kind: "tool", tool: "read_file", args: { path: "notes/todo.md" }, argsGiven: true });
    expect(result.repairs).toContain("think_stripped");
  });

  it("strips a markdown fence and a <tool_call> tag", () => {
    expect(ok('```json\n{"final":"Done."}\n```').turn).toEqual({ kind: "final", final: "Done." });
    expect(ok('<tool_call>\n{"tool":"search_files","args":{"pattern":"invoice"}}\n</tool_call>').turn).toMatchObject({ kind: "tool", tool: "search_files" });
  });

  it("escapes literal tabs and newlines inside strings, and drops stray control characters outside them", () => {
    const result = ok('{"tool":"write_file","args":{"path":"q.txt","content":"a\tb\nShe said \\"yes\\"."}}\u0000');
    expect(result.turn).toMatchObject({ kind: "tool", args: { path: "q.txt", content: 'a\tb\nShe said "yes".' } });
    expect(result.repairs).toContain("control_characters_escaped");
  });

  it("balances a reply that lost its closing braces, once", () => {
    const result = ok('{"tool":"read_file","args":{"path":"notes/todo.md"}');
    expect(result.turn).toMatchObject({ kind: "tool", tool: "read_file", args: { path: "notes/todo.md" } });
    expect(result.repairs).toContain("json_balanced");
  });
});

describe("[L1] never fake success: what cannot be repaired is a failure, never `{}`", () => {
  it("arguments cut off inside a string are not closed into a shorter call", () => {
    const failure = failed('{"tool":"write_file","args":{"path":"a.txt","content":"the first half of the fi');
    expect(failure.kind).toBe("unparseable");
    expect(failure.message).toMatch(/cut off inside a string/);
  });

  it("a reply the server cut at max_tokens is never balanced, even when balancing would parse", () => {
    const failure = failed('{"tool":"read_file","args":{"path":"notes/todo.md"}', { truncated: true });
    expect(failure.kind).toBe("truncated");
  });

  it("qwen3.5:9b's own shape on the doctor's smoke is refused, not guessed at", () => {
    const failure = failed('{"toolCall": {"name": "file_ops", "action": "read_file", {"path": "notes/todo.md"}}, "summary": null}');
    expect(failure.kind).toBe("unparseable");
  });

  it("an arguments value that is not an object is refused; a JSON object encoded as a string is decoded", () => {
    expect(failed('{"tool":"read_file","args":["notes/todo.md"]}').kind).toBe("bad_args");
    const decoded = ok('{"tool":"read_file","args":"{\\"path\\":\\"notes/todo.md\\"}"}');
    expect(decoded.turn).toMatchObject({ args: { path: "notes/todo.md" } });
    expect(decoded.repairs).toContain("args_decoded");
  });

  it("a tool with no args key is a call with no arguments, and says so", () => {
    expect(ok('{"tool":"read_file"}').turn).toEqual({ kind: "tool", tool: "read_file", args: {}, argsGiven: false });
  });
});

describe("[L1] tool names", () => {
  it("rejects an unknown tool and suggests the closest allowed one", () => {
    const failure = failed('{"tool":"write_fiel","args":{"path":"a"}}');
    expect(failure).toMatchObject({ kind: "unknown_tool", suggestion: "write_file" });
    expect(failure.message).toContain('"write_fiel"');
    expect(failure.message).toContain("read_file, write_file, search_files");
  });

  it("accepts a different letter case as the allowed spelling", () => {
    const result = ok('{"tool":"Read_File","args":{"path":"x"}}');
    expect(result.turn).toMatchObject({ tool: "read_file" });
    expect(result.repairs).toContain("tool_name_case");
  });

  it("closestName prefers a name the model wrapped over a near spelling", () => {
    expect(closestName("file_ops.read_file", TOOLS)).toBe("read_file");
    expect(closestName("serch_files", TOOLS)).toBe("search_files");
    expect(closestName("anything", [])).toBeUndefined();
  });
});

describe("[L1] the shapes a model may answer in", () => {
  it("reads the native `{name, arguments}` tool-call convention as a call", () => {
    const result = ok('{"name":"read_file","arguments":{"path":"x"}}');
    expect(result.turn).toMatchObject({ kind: "tool", tool: "read_file", args: { path: "x" } });
    expect(result.repairs).toContain("native_tool_call");
  });

  it("passes the app's own `toolCall`/`summary` shape through untouched", () => {
    const legacy = { toolCall: { name: "file_ops", action: 'read_file {"path":"x"}' }, summary: null };
    expect(ok(JSON.stringify(legacy)).turn).toEqual({ kind: "legacy", object: legacy });
  });

  it("a tool beats a final answer in the same reply, as the app's loop reads it", () => {
    expect(ok('{"tool":"read_file","args":{"path":"x"},"final":"done"}').turn).toMatchObject({ kind: "tool" });
  });

  it("a reply that neither calls a tool nor finishes is `no_action`", () => {
    expect(failed('{"thought":"I should look at the file first."}').kind).toBe("no_action");
    expect(failed("{}").kind).toBe("no_action");
    expect(failed("I will read the file now.").kind).toBe("unparseable");
  });
});

describe("[L1] the one re-ask", () => {
  it("names the error, the suggestion and the allowed tools, and asks for one JSON object", () => {
    const text = reaskMessage({ kind: "unknown_tool", message: 'Unknown tool "write_fiel".', suggestion: "write_file" }, TOOLS);
    expect(text).toContain('Unknown tool "write_fiel".');
    expect(text).toContain('Did you mean "write_file"?');
    expect(text).toContain("read_file, write_file, search_files");
    expect(text).toMatch(/one JSON object/i);
  });

  it("for a turn that did not act, asks for the tool call itself", () => {
    const text = reaskMessage({ kind: "no_action", message: "The reply neither called a tool nor finished." }, TOOLS);
    expect(text).toMatch(/"tool"/);
    expect(text).not.toMatch(/"final"/);
  });
});
