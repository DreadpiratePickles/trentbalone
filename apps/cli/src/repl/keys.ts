/**
 * 3.5 — multi-line input, and the keyboard protocol that makes Shift+Enter possible.
 *
 * The three newline bindings, in order of reliability:
 *   Ctrl+J  0x0A          — GUARANTEED. Works in every terminal, which is why it is the
 *                           one the REPL advertises. (Hermes added it because Windows
 *                           Terminal swallows Alt+Enter for fullscreen.)
 *   Alt+Enter  ESC CR     — needs a short escape timeout, or a bare ESC is mistaken for
 *                           the start of this sequence.
 *   Shift+Enter           — indistinguishable from Enter UNLESS the terminal speaks the
 *                           Kitty keyboard protocol, which reports it as CSI 13;2u.
 *
 * The Kitty flag stack is pushed on entry and MUST be popped on exit, including on a
 * throw, or the user is left in a terminal that reports keys nothing else understands.
 */

export type KeyEvent =
  | { type: "text"; value: string }
  | { type: "submit" }
  | { type: "newline" }
  | { type: "interrupt" }
  | { type: "backspace" }
  | { type: "escape" }
  | { type: "eof" }
  | { type: "key"; name: string };

/** Advertised in the REPL's own help. Ctrl+J is the binding we promise works. */
export const NEWLINE_HINT = "Ctrl+J for a newline, Enter to send";

/** Long enough to catch a two-byte Alt+Enter, short enough that ESC still feels instant. */
export const ESCAPE_TIMEOUT_MS = 50;

/** Ask the terminal to report modified keys (Kitty keyboard protocol, flag 1). */
export const KITTY_PUSH = "\x1b[>1u";
/** Pop the flag stack. Never skip this. */
export const KITTY_POP = "\x1b[<u";

const ESC = "\x1b";
const CTRL_C = "\x03";
const CTRL_D = "\x04";
const CTRL_J = "\x0a";
const ENTER = "\x0d";
const BACKSPACE = "\x7f";
const BACKSPACE_ALT = "\x08";

/** CSI u ("fixterms") report: `CSI <code> ; <modifiers> u`. */
const CSI_U = /^\x1b\[([0-9]+)(?:;([0-9]+))?u/;
/** Any other complete CSI sequence, so arrows and friends are consumed, not leaked as text. */
const CSI_OTHER = /^\x1b\[([0-9;?]*)([A-Za-z~])/;

const ENTER_KEYCODE = 13;
/** Modifier 1 is "none" in the CSI u encoding; anything else is Shift/Alt/Ctrl+Enter. */
const NO_MODIFIER = 1;

const CSI_NAMES: Record<string, string> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
};

export class KeyDecoder {
  #buffer = "";

  /** Feeds bytes in and returns every key that could be decoded unambiguously. */
  push(chunk: string): KeyEvent[] {
    this.#buffer += chunk;
    const events: KeyEvent[] = [];
    for (;;) {
      const before = this.#buffer.length;
      const event = this.#next();
      if (event === "incomplete") break;
      if (event !== null) events.push(event);
      if (this.#buffer.length === before) break; // defensive: never spin
    }
    return events;
  }

  /**
   * Resolves whatever is still held. Called when the escape timeout fires, which is the
   * only way to tell a bare ESC from the first byte of Alt+Enter.
   */
  flush(): KeyEvent[] {
    if (this.#buffer === "") return [];
    if (this.#buffer.startsWith(ESC)) {
      this.#buffer = this.#buffer.slice(1);
      const rest = this.push("");
      return [{ type: "escape" }, ...rest];
    }
    const held = this.#buffer;
    this.#buffer = "";
    return [{ type: "text", value: held }];
  }

  /** True while bytes are held pending disambiguation; the caller arms its timer on this. */
  get pending(): boolean {
    return this.#buffer !== "";
  }

  #next(): KeyEvent | null | "incomplete" {
    const buffer = this.#buffer;
    if (buffer === "") return "incomplete";

    if (buffer.startsWith(ESC)) return this.#escape(buffer);

    const head = buffer[0]!;
    switch (head) {
      case CTRL_C:
        this.#buffer = buffer.slice(1);
        return { type: "interrupt" };
      case CTRL_D:
        this.#buffer = buffer.slice(1);
        return { type: "eof" };
      case CTRL_J:
        this.#buffer = buffer.slice(1);
        return { type: "newline" };
      case ENTER:
        this.#buffer = buffer.slice(1);
        return { type: "submit" };
      case BACKSPACE:
      case BACKSPACE_ALT:
        this.#buffer = buffer.slice(1);
        return { type: "backspace" };
      default:
        break;
    }

    // A run of printable characters, stopping at the next control byte.
    let end = 0;
    while (end < buffer.length && buffer.charCodeAt(end) >= 0x20 && buffer[end] !== BACKSPACE) end += 1;
    if (end === 0) {
      this.#buffer = buffer.slice(1); // an unhandled control byte: drop it
      return null;
    }
    this.#buffer = buffer.slice(end);
    return { type: "text", value: buffer.slice(0, end) };
  }

  #escape(buffer: string): KeyEvent | null | "incomplete" {
    if (buffer.length === 1) return "incomplete"; // could still become Alt+Enter

    if (buffer.startsWith(`${ESC}\r`) || buffer.startsWith(`${ESC}\n`)) {
      this.#buffer = buffer.slice(2);
      return { type: "newline" };
    }

    if (buffer.startsWith(`${ESC}[`)) {
      const csiU = CSI_U.exec(buffer);
      if (csiU !== null) {
        this.#buffer = buffer.slice(csiU[0].length);
        const code = Number(csiU[1]);
        const modifiers = csiU[2] === undefined ? NO_MODIFIER : Number(csiU[2]);
        if (code === ENTER_KEYCODE) {
          return modifiers === NO_MODIFIER ? { type: "submit" } : { type: "newline" };
        }
        return { type: "key", name: `csi-${code}` };
      }
      const other = CSI_OTHER.exec(buffer);
      if (other !== null) {
        this.#buffer = buffer.slice(other[0].length);
        return { type: "key", name: CSI_NAMES[other[2] ?? ""] ?? `csi-${other[2] ?? ""}` };
      }
      return "incomplete"; // a CSI sequence still arriving
    }

    // ESC followed by something else: report the ESC and let the rest decode normally.
    this.#buffer = buffer.slice(1);
    return { type: "escape" };
  }
}

// ── Kitty keyboard protocol lifecycle ───────────────────────────────────────

export interface TerminalIo {
  write(text: string): void;
  isTTY: boolean;
}

/**
 * Runs `body` with the Kitty keyboard protocol pushed, and pops it on the way out
 * whatever happens. On a non-tty nothing is written at all: those escapes would end up
 * in a pipe or a log file.
 */
export async function withKittyProtocol<T>(io: TerminalIo, body: () => Promise<T>): Promise<T> {
  if (!io.isTTY) return body();
  io.write(KITTY_PUSH);
  try {
    return await body();
  } finally {
    io.write(KITTY_POP);
  }
}
