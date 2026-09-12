/**
 * 3.5 — multi-line input, and the terminal state that must be handed back intact.
 *
 * Ctrl+J (0x0A) is the GUARANTEED newline. Enter (0x0D) submits. Alt+Enter arrives as
 * `\x1b\r` and needs an escape timeout so a bare ESC is not swallowed. Shift+Enter only
 * exists under the Kitty keyboard protocol, which must be popped on the way out —
 * including when the body throws — or the user's terminal is left broken.
 */

import { describe, it, expect, vi } from "vitest";
import {
  KeyDecoder,
  KITTY_PUSH,
  KITTY_POP,
  ESCAPE_TIMEOUT_MS,
  withKittyProtocol,
  NEWLINE_HINT,
  type KeyEvent,
} from "../keys.js";

function decode(chunks: string[], flushAfter = true): KeyEvent[] {
  const d = new KeyDecoder();
  const out: KeyEvent[] = [];
  for (const c of chunks) out.push(...d.push(c));
  if (flushAfter) out.push(...d.flush());
  return out;
}

describe("key decoding: newline versus submit", () => {
  const cases: Array<[string, string, KeyEvent["type"]]> = [
    ["Ctrl+J (the guaranteed newline)", "\x0a", "newline"],
    ["Enter", "\x0d", "submit"],
    ["Alt+Enter", "\x1b\r", "newline"],
    ["Kitty Shift+Enter", "\x1b[13;2u", "newline"],
    ["Kitty plain Enter", "\x1b[13u", "submit"],
    ["Ctrl+C", "\x03", "interrupt"],
  ];

  for (const [name, bytes, expected] of cases) {
    it(`${name} produces ${expected}`, () => {
      const events = decode([bytes]);
      expect(events.map((e) => e.type)).toEqual([expected]);
    });
  }

  it("documents Ctrl+J as the guaranteed newline", () => {
    expect(NEWLINE_HINT).toMatch(/Ctrl\+J/);
  });

  it("carries printable text through unchanged", () => {
    expect(decode(["hi"])).toEqual([{ type: "text", value: "hi" }]);
  });

  it("does not treat a bare ESC as Alt+Enter, and only resolves it on the timeout", () => {
    const d = new KeyDecoder();
    expect(d.push("\x1b")).toEqual([]); // still ambiguous
    expect(d.flush()).toEqual([{ type: "escape" }]);
    expect(ESCAPE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(ESCAPE_TIMEOUT_MS).toBeLessThanOrEqual(100);
  });

  it("resolves a split Alt+Enter that arrives across two chunks", () => {
    const d = new KeyDecoder();
    expect(d.push("\x1b")).toEqual([]);
    expect(d.push("\r")).toEqual([{ type: "newline" }]);
    expect(d.flush()).toEqual([]);
  });
});

describe("kitty keyboard protocol lifecycle", () => {
  it("pushes on entry and pops on normal exit", async () => {
    const written: string[] = [];
    await withKittyProtocol({ write: (s) => void written.push(s), isTTY: true }, async () => "ok");
    expect(written).toEqual([KITTY_PUSH, KITTY_POP]);
  });

  it("pops even when the body throws", async () => {
    const written: string[] = [];
    await expect(
      withKittyProtocol({ write: (s) => void written.push(s), isTTY: true }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(written).toEqual([KITTY_PUSH, KITTY_POP]);
    expect(written.at(-1)).toBe(KITTY_POP);
  });

  it("writes nothing at all when stdout is not a tty", async () => {
    const write = vi.fn();
    await withKittyProtocol({ write, isTTY: false }, async () => "ok");
    expect(write).not.toHaveBeenCalled();
  });
});
