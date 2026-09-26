/**
 * [C13] A streamed answer in the REPL transcript (`step_delta`, `@trent/core/solo/events.ts`).
 *
 * The REPL writes whole lines: `index.ts` binds the engine's `write` to `writeLine`, which appends the
 * newline, and `engine.ts` has no partial write. So a streamed answer is printed a line at a time, each line
 * as soon as the delta that ends it arrives. The frame that confirms the streamed text (the answer's
 * `step_output`, or the `step_note` of the words beside a call) prints only what is left, so the transcript is
 * byte for byte the one a non-streamed turn leaves: the first printed line carries the indent the answer line
 * has, the later ones none, exactly as the answer's own embedded newlines print. Streamed text is never
 * dropped: a frame that does not confirm it prints its unfinished line first, and an answer the stream did
 * not lead to is printed whole after it.
 */
import type { Theme } from "../ui/index.js";

/** The indent `render.ts` gives a step's output and notes. */
export const OUTPUT_INDENT = "    ";

export class StreamedText {
  readonly #theme: Theme;
  #text = "";
  /** Where the unprinted text starts: always just after a newline, or 0. */
  #printed = 0;
  #lines = 0;

  constructor(theme: Theme) {
    this.#theme = theme;
  }

  #line(text: string, fresh = false): string {
    const first = fresh || this.#lines === 0;
    this.#lines += 1;
    return first ? `${OUTPUT_INDENT}${this.#theme.body(text)}` : this.#theme.body(text);
  }

  /** The lines a delta finishes (often none). */
  push(delta: string): string[] {
    this.#text += delta;
    const lines: string[] = [];
    for (let end = this.#text.indexOf("\n", this.#printed); end !== -1; end = this.#text.indexOf("\n", this.#printed)) {
      lines.push(this.#line(this.#text.slice(this.#printed, end)));
      this.#printed = end + 1;
    }
    return lines;
  }

  /** The confirming frame's text: only what the stream has not printed when it continues it, else all of it. */
  settle(whole: string): string[] {
    if (!whole.startsWith(this.#text)) return [...this.flush(), this.#line(whole, true)];
    const rest = whole.slice(this.#printed);
    this.#printed = whole.length;
    return rest === "" ? [] : [this.#line(rest)];
  }

  /** The unfinished line, as it stands. */
  flush(): string[] {
    if (this.#printed >= this.#text.length) return [];
    const line = this.#line(this.#text.slice(this.#printed));
    this.#printed = this.#text.length;
    return [line];
  }
}
