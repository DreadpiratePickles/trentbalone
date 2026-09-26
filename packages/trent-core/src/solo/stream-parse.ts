/**
 * [C13] The answer inside a reply, released while the reply streams.
 *
 * `parse.ts` decides what a finished reply is. This module only says, token by token, which part of the
 * reply will be SHOWN once it is finished, so a surface can show it early. What it releases is always a
 * prefix of what `parseReply` finally shows (the answer, or the words beside a call, which the turn emits as
 * a note), and all of it once `end()` is called. It never releases:
 *   - the constrained-output envelope: of `{"answer": "..."}` only the answer string, decoded;
 *   - any other field of the envelope, in any order (a thought, reasoning, a nested "answer");
 *   - anything of a reply whose `tool_calls` is a non-empty list (parse.ts runs the calls instead);
 *   - a `<think>` block, or a `<tool_call>` block and its body (tags matched as parse.ts matches them);
 *   - leading or trailing whitespace: the answer is trimmed, so whitespace waits until text follows it.
 *
 * Limits, by design: text released before the reply turns out to be something else stays released (an
 * `answer` followed by `tool_calls` in unconstrained JSON, thinking whose `<think>` was in the chat template,
 * JSON that never closes). The parser then stops releasing, and a surface that compares what it streamed with
 * the answer frame prints the answer whole when the two disagree (`apps/cli/src/repl/stream-render.ts`).
 */

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const CALL_OPEN = "<tool_call>";
const CALL_CLOSE = "</tool_call>";
const OUTSIDE_TAGS = [THINK_OPEN, CALL_OPEN, THINK_CLOSE, CALL_CLOSE] as const;

const JSON_ESCAPES: Readonly<Record<string, string>> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };

export interface AnswerStreamOptions {
  /** The request carried a `responseFormat`: the reply may be the `{"answer"}` / `{"tool_calls"}` envelope. */
  readonly envelope: boolean;
}

export interface AnswerStream {
  /** One token's text in; the answer text it newly makes visible out ("" when none). */
  push(chunk: string): string;
  /** The reply is complete: what was held only because more might have followed. */
  end(): string;
}

/** Released text: nothing before the first visible character, whitespace only once text follows, a surrogate pair whole. */
class Release {
  #out = "";
  #space = "";
  #started = false;
  #high = "";

  char(ch: string): void {
    if (/\s/.test(ch)) {
      if (this.#started) this.#space += ch;
      return;
    }
    this.#out += this.#space + ch;
    this.#space = "";
    this.#started = true;
  }

  take(final = false): string {
    let out = this.#high + this.#out;
    this.#high = "";
    this.#out = "";
    const last = out.charCodeAt(out.length - 1);
    if (!final && last >= 0xd800 && last <= 0xdbff) [out, this.#high] = [out.slice(0, -1), out.slice(-1)];
    return out;
  }
}

type Mode = "sniff" | "text" | "think" | "call" | "json" | "halted";
/** Where the top-level envelope object stands. */
type Place = "open" | "key" | "colon" | "value" | "answer" | "skip" | "after" | "done";

class Parser implements AnswerStream {
  readonly #release = new Release();
  #mode: Mode;
  /** The mode a `<think>` block returns to. */
  #beforeThink: Mode = "text";
  /** Characters that may still be a tag. */
  #tag = "";

  #place: Place = "open";
  #key = "";
  #answered = false;
  /** Inside a string (a key, the answer, or a skipped one): a pending `\` or `\uXXXX`. */
  #escape: string | undefined;
  /** A skipped value: bracket depth and whether the scan is inside a string. */
  #depth = 0;
  #inString = false;
  /** The value being skipped is `tool_calls` and its first item has not been looked for yet. */
  #callsOpen = false;

  constructor(options: AnswerStreamOptions) {
    this.#mode = options.envelope ? "sniff" : "text";
  }

  push(chunk: string): string {
    for (const ch of chunk) this.#char(ch);
    return this.#release.take();
  }

  end(): string {
    if ((this.#mode === "text" || this.#mode === "sniff") && this.#tag !== "") {
      const held = this.#tag;
      this.#tag = "";
      for (const ch of held) this.#plain(ch);
    }
    return this.#release.take(true);
  }

  #char(ch: string): void {
    switch (this.#mode) {
      case "json":
        return this.#json(ch);
      case "halted":
        return;
      default:
        return this.#tagged(ch);
    }
  }

  /** Text outside the envelope: a tag is recognised case-insensitively, as parse.ts does, however it is cut. */
  #tagged(ch: string): void {
    if (this.#tag === "" && ch !== "<") return this.#plain(ch);
    this.#tag += ch;
    const tags: readonly string[] = this.#mode === "think" ? [THINK_CLOSE] : this.#mode === "call" ? [CALL_CLOSE] : OUTSIDE_TAGS;
    const lower = this.#tag.toLowerCase();
    if (tags.includes(lower)) {
      this.#tag = "";
      return this.#onTag(lower);
    }
    if (tags.some((tag) => tag.startsWith(lower))) return;
    // Not a tag: its `<` is text, and what followed it is scanned again.
    const rest = this.#tag.slice(1);
    this.#tag = "";
    this.#plain("<");
    for (const next of rest) this.#char(next);
  }

  #onTag(tag: string): void {
    if (tag === THINK_OPEN) [this.#beforeThink, this.#mode] = [this.#mode, "think"];
    else if (tag === CALL_OPEN) this.#mode = "call";
    else if (tag === THINK_CLOSE && this.#mode === "think") this.#mode = this.#beforeThink;
    else if (tag === CALL_CLOSE && this.#mode === "call") this.#mode = "text";
    // A `</think>` whose opening was in the chat template, or a stray `</tool_call>`: what came before was not the answer.
    else this.#mode = "halted";
  }

  #plain(ch: string): void {
    if (this.#mode === "think" || this.#mode === "call" || this.#mode === "halted") return;
    if (this.#mode === "sniff") {
      if (/\s/.test(ch)) return;
      if (ch === "{") {
        this.#mode = "json";
        return;
      }
      this.#mode = "text";
    }
    this.#release.char(ch);
  }

  /** The envelope: one top-level object; only the `answer` string is released. */
  #json(ch: string): void {
    switch (this.#place) {
      case "open":
        if (ch === '"') [this.#place, this.#key] = ["key", ""];
        else if (ch === "}") this.#place = "done";
        else if (!/\s/.test(ch)) this.#halt();
        return;
      case "key": {
        const decoded = this.#stringChar(ch);
        if (decoded === null) this.#place = "colon";
        else if (decoded !== undefined) this.#key += decoded;
        return;
      }
      case "colon":
        if (ch === ":") this.#place = "value";
        else if (!/\s/.test(ch)) this.#halt();
        return;
      case "value":
        if (/\s/.test(ch)) return;
        if (ch === '"' && this.#key === "answer" && !this.#answered) {
          this.#place = "answer";
          return;
        }
        this.#place = "skip";
        [this.#depth, this.#inString, this.#callsOpen] = [0, false, false];
        if (ch === '"') this.#inString = true;
        else if (ch === "{" || ch === "[") [this.#depth, this.#callsOpen] = [1, this.#key === "tool_calls" && ch === "["];
        return;
      case "answer": {
        const decoded = this.#stringChar(ch);
        if (decoded === null) [this.#place, this.#answered] = ["after", true];
        else if (decoded !== undefined) for (const out of decoded) this.#release.char(out);
        return;
      }
      case "skip":
        return this.#skip(ch);
      case "after":
        if (ch === ",") this.#place = "open";
        else if (ch === "}") this.#place = "done";
        else if (!/\s/.test(ch)) this.#halt();
        return;
      case "done":
        if (!/\s/.test(ch)) this.#halt();
        return;
    }
  }

  /** A skipped value, strings and nesting included; a non-empty `tool_calls` list means nothing here is the answer. */
  #skip(ch: string): void {
    if (this.#inString) {
      if (this.#stringChar(ch) === null) {
        this.#inString = false;
        if (this.#depth === 0) this.#place = "after";
      }
      return;
    }
    if (this.#callsOpen && !/\s/.test(ch)) {
      this.#callsOpen = false;
      if (ch !== "]") return this.#halt();
    }
    if (ch === '"') this.#inString = true;
    else if (ch === "{" || ch === "[") this.#depth += 1;
    else if (ch === "}" || ch === "]") {
      if (this.#depth === 0) {
        // A bare value (a number, true, null) ended by the object's own close.
        if (ch === "]") return void this.#halt();
        this.#place = "after";
        return this.#json(ch);
      }
      this.#depth -= 1;
      if (this.#depth === 0) this.#place = "after";
    } else if (this.#depth === 0 && (ch === "," || /\s/.test(ch))) {
      this.#place = "after";
      if (ch === ",") this.#place = "open";
    }
  }

  /** One character inside a JSON string: its decoded text, undefined while an escape is incomplete, null at the closing quote. */
  #stringChar(ch: string): string | null | undefined {
    if (this.#escape === undefined) {
      if (ch === "\\") {
        this.#escape = "";
        return undefined;
      }
      return ch === '"' ? null : ch;
    }
    const escape = this.#escape + ch;
    if (escape.startsWith("u")) {
      if (escape.length < 5) {
        this.#escape = escape;
        return undefined;
      }
      this.#escape = undefined;
      const code = Number.parseInt(escape.slice(1), 16);
      if (!/^u[0-9a-fA-F]{4}$/.test(escape) || Number.isNaN(code)) return this.#halt();
      return String.fromCharCode(code);
    }
    this.#escape = undefined;
    const decoded = JSON_ESCAPES[ch];
    return decoded === undefined ? this.#halt() : decoded;
  }

  /** JSON parse.ts would refuse: it reads the reply another way, so nothing more is released. */
  #halt(): undefined {
    this.#mode = "halted";
    return undefined;
  }
}

/** A parser for one model call's reply. `envelope`: the request asked for constrained output. */
export function createAnswerStream(options: AnswerStreamOptions): AnswerStream {
  return new Parser(options);
}
