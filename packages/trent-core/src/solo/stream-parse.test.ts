/**
 * [C13] The incremental answer parser. `parse.ts` is the oracle: whatever a reply is finally shown as
 * (the answer of an answer, the narration beside a call), the text the parser releases while the reply
 * streams is always a prefix of it, and all of it once the stream ends. The envelope itself, a call, a
 * thought field and a `<think>` block are never released, however the reply is cut into tokens.
 */
import { describe, expect, it } from "vitest";
import { fakeAdapter } from "./fakes.test-helpers.js";
import { parseReply } from "./parse.js";
import { createAnswerStream } from "./stream-parse.js";

const files = fakeAdapter({ name: "file_ops", tools: ["read_file"] });

/** What the surfaces show for this reply when it is NOT streamed: the answer, or the narration beside its calls. */
function shownWhole(reply: string, envelope: boolean): string {
  const parsed = parseReply(reply, [files], { envelope });
  if (parsed.kind === "answer") return parsed.text;
  if (parsed.kind === "actions") return parsed.narration;
  return "";
}

/** The reply cut every way a model's tokens could cut it: one character at a time, at every single point, in threes. */
function cuts(reply: string): string[][] {
  const chars = [...reply];
  const out: string[][] = [chars];
  for (let i = 1; i < chars.length; i++) out.push([chars.slice(0, i).join(""), chars.slice(i).join("")]);
  const threes: string[] = [];
  for (let i = 0; i < chars.length; i += 3) threes.push(chars.slice(i, i + 3).join(""));
  out.push(threes, [reply]);
  return out;
}

function streamed(chunks: readonly string[], envelope: boolean): { readonly deltas: string[]; readonly text: string } {
  const parser = createAnswerStream({ envelope });
  const deltas = chunks.map((chunk) => parser.push(chunk));
  deltas.push(parser.end());
  return { deltas, text: deltas.join("") };
}

const ENVELOPE_REPLIES: readonly string[] = [
  '{"answer": "The launch is on Tuesday."}',
  '{"thought": "they asked about \\"launch\\" {nested} [x]", "answer": "Tuesday, after the review."}',
  '{"answer": "Tuesday.", "reasoning": {"steps": ["a", "b"], "answer": "nested, never shown"}}',
  '  {"answer" : "  line one\\nline two \\"quoted\\" caf\\u00e9 \\ud83d\\ude00 tab\\there \\/ slash  "}  ',
  '{"tool_calls": [{"name": "read_file", "arguments": {"path": "a.md", "answer": "an argument"}}]}',
  '{"tool_calls": [{"name": "read_file", "arguments": {"path": "a.md"}}], "answer": "not the answer: a call wins"}',
  '{"tool_calls": [], "answer": "Nothing to call."}',
  '{"answer": "Two\\n\\nparagraphs, and a trailing newline.\\n"}',
  '<think>{"answer": "a draft"}</think>{"answer": "the final one"}',
  '{"confidence": 0.9, "answer": "Yes.", "done": true}',
  '{"answer": "Yes, with a count.", "n": -1.5e3,"none":null}',
  '{"answer": {"text": "not a string, so parse.ts has no answer"}}',
  "The launch is on Tuesday.",
];

const TEXT_REPLIES: readonly string[] = [
  "The launch is on Tuesday.",
  "<think>they want a date</think>The launch is on Tuesday.",
  "  Leading and trailing space.  \n",
  'Let me look.\n<tool_call>\n{"name": "read_file", "arguments": {"path": "README.md"}}\n</tool_call>',
  'A <tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call> B <TOOL_CALL>{"name":"read_file","arguments":{"path":"b"}}</TOOL_CALL> C',
  "Use a < b, <b>bold</b>, <thinking> is not a tag, and <tool is text too.",
  "Keep the angle: x <",
  "Hello <think>aside</think> world",
];

describe("[C13] the answer parser releases only the answer, as it arrives", () => {
  it("envelope: releases exactly what parse.ts answers, for every cut, and never the envelope", () => {
    for (const reply of ENVELOPE_REPLIES) {
      const whole = shownWhole(reply, true);
      for (const chunks of cuts(reply)) {
        const { deltas, text } = streamed(chunks, true);
        expect(text, `${JSON.stringify(reply)} cut ${JSON.stringify(chunks)}`).toBe(whole);
        let seen = "";
        for (const delta of deltas) {
          seen += delta;
          expect(whole.startsWith(seen)).toBe(true);
        }
        expect(text).not.toContain('{"answer"');
        expect(text).not.toContain('"answer"');
      }
    }
  });

  it("text protocol: releases the answer, or the narration beside a call, and never a block or a thought", () => {
    for (const reply of TEXT_REPLIES) {
      const whole = shownWhole(reply, false);
      for (const chunks of cuts(reply)) {
        const { text } = streamed(chunks, false);
        expect(text, `${JSON.stringify(reply)} cut ${JSON.stringify(chunks)}`).toBe(whole);
        expect(text).not.toContain("<tool_call>");
        expect(text).not.toContain("read_file");
        expect(text).not.toContain("they want a date");
        expect(text).not.toContain("aside");
      }
    }
  });

  it("releases the answer while it is still arriving, not at the end", () => {
    const parser = createAnswerStream({ envelope: true });
    expect(parser.push('{"ans')).toBe("");
    expect(parser.push('wer": "The la')).toBe("The la");
    expect(parser.push("unch is")).toBe("unch is");
    expect(parser.push(" on Tuesday.")).toBe(" on Tuesday.");
    expect(parser.push('"}')).toBe("");
    expect(parser.end()).toBe("");
  });

  it("holds whitespace until more text follows it, because the answer is trimmed", () => {
    const parser = createAnswerStream({ envelope: true });
    expect(parser.push('{"answer": "  Hello')).toBe("Hello");
    expect(parser.push(" ")).toBe("");
    expect(parser.push("\n")).toBe("");
    expect(parser.push("world  ")).toBe(" \nworld");
    expect(parser.push('"}')).toBe("");
    expect(parser.end()).toBe("");
  });

  it("releases nothing of a reply whose calls come first, whatever field follows them", () => {
    const parser = createAnswerStream({ envelope: true });
    const text = ['{"tool_calls": [{"name": "read_file", "arguments": {"path": "a"}}],', ' "answer": "later"}'].map((chunk) => parser.push(chunk)).join("");
    expect(text + parser.end()).toBe("");
  });

  it("keeps a surrogate pair together when a token ends between its halves", () => {
    const parser = createAnswerStream({ envelope: true });
    const first = parser.push('{"answer": "ok \\ud83d');
    expect(first).toBe("ok ");
    expect(parser.push('\\ude00"}')).toBe("\u{1F600}");
  });
});
