import { describe, it, expect } from "vitest";
import { detectColorMode, isTty, canUseRawMode } from "../capabilities.js";

describe("detectColorMode", () => {
  it("returns none when NO_COLOR is set, regardless of anything else", () => {
    expect(detectColorMode({ NO_COLOR: "1", COLORTERM: "truecolor", TERM: "xterm-256color" })).toBe("none");
    expect(detectColorMode({ NO_COLOR: "", COLORTERM: "truecolor" })).toBe("truecolor");
  });

  it("returns truecolor for COLORTERM=truecolor or 24bit", () => {
    expect(detectColorMode({ COLORTERM: "truecolor" })).toBe("truecolor");
    expect(detectColorMode({ COLORTERM: "24bit" })).toBe("truecolor");
    expect(detectColorMode({ COLORTERM: "TrueColor" })).toBe("truecolor");
  });

  it("returns ansi256 for a *-256color TERM", () => {
    expect(detectColorMode({ TERM: "xterm-256color" })).toBe("ansi256");
    expect(detectColorMode({ TERM: "screen-256color" })).toBe("ansi256");
    expect(detectColorMode({ TERM: "tmux-256color" })).toBe("ansi256");
  });

  it("prefers truecolor over 256 when both signals are present", () => {
    expect(detectColorMode({ COLORTERM: "truecolor", TERM: "xterm-256color" })).toBe("truecolor");
  });

  it("falls back to ansi16 for anything else", () => {
    expect(detectColorMode({})).toBe("ansi16");
    expect(detectColorMode({ TERM: "xterm" })).toBe("ansi16");
    expect(detectColorMode({ TERM: "dumb" })).toBe("none");
    expect(detectColorMode({ COLORTERM: "8bit" })).toBe("ansi16");
  });
});

describe("tty guards", () => {
  it("isTty reflects the stream's isTTY flag and never throws on a bare object", () => {
    expect(isTty({ isTTY: true })).toBe(true);
    expect(isTty({ isTTY: false })).toBe(false);
    expect(isTty({})).toBe(false);
  });

  it("canUseRawMode is false when stdin is piped, so setRawMode is never called", () => {
    let called = false;
    const piped = { isTTY: false, setRawMode: () => { called = true; } };
    expect(canUseRawMode(piped)).toBe(false);
    expect(called).toBe(false);
  });

  it("canUseRawMode is false when setRawMode is missing even on a tty", () => {
    expect(canUseRawMode({ isTTY: true })).toBe(false);
    expect(canUseRawMode({ isTTY: true, setRawMode: () => {} })).toBe(true);
  });
});
