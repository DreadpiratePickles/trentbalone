/**
 * 3.4 — the interrupt users actually notice.
 *
 * In raw mode the OS stops generating SIGINT, so 0x03 arrives as a byte of data.
 * First press aborts the in-flight run and hands the prompt back with the process
 * still alive; a press with nothing running exits 130.
 *
 * The branch is on `signal.aborted`, NEVER on `error.name`: an abort carrying a
 * reason produces an error whose name is not "AbortError".
 */

import { describe, it, expect, vi } from "vitest";
import { ABORT_REASON, wasAborted, withRawMode, InterruptController } from "../interrupt.js";
import { EXIT } from "@trent/core/errors/index.js";
import { makeHarness } from "./harness.js";

describe("abort detection", () => {
  it("recognises an abort that carries a reason, whose error name is NOT AbortError", () => {
    const c = new AbortController();
    c.abort(new Error(ABORT_REASON));
    const reason = c.signal.reason as Error;
    expect(reason.name).not.toBe("AbortError");
    expect(wasAborted(c.signal, reason)).toBe(true);
  });

  it("does not misread a genuine failure as an abort", () => {
    const c = new AbortController();
    expect(wasAborted(c.signal, new Error("provider 503"))).toBe(false);
  });

  it("treats an aborted signal as an abort regardless of what was thrown", () => {
    const c = new AbortController();
    c.abort(new Error(ABORT_REASON));
    expect(wasAborted(c.signal, new TypeError("socket closed"))).toBe(true);
  });
});

describe("raw mode lifecycle", () => {
  it("restores setRawMode(false) even when the body throws", async () => {
    const calls: boolean[] = [];
    const stdin = { isTTY: true, setRawMode: (m: boolean) => void calls.push(m) };
    await expect(withRawMode(stdin, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(calls).toEqual([true, false]);
  });

  it("is a no-op on a piped stdin that has no setRawMode", async () => {
    const result = await withRawMode({ isTTY: false }, async () => "ok");
    expect(result).toBe("ok");
  });
});

describe("interrupt controller", () => {
  it("aborts while busy and exits 130 while idle", () => {
    const abort = vi.fn();
    const exit = vi.fn();
    let busy = true;
    const c = new InterruptController({ isBusy: () => busy, abort, exit });

    expect(c.press()).toBe("aborted");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    busy = false;
    expect(c.press()).toBe("exited");
    expect(exit).toHaveBeenCalledWith(EXIT.INTERRUPT);
  });
});

describe("0x03 injected into a live stream", () => {
  it("stops the stream, keeps the process alive and returns the prompt", async () => {
    const h = makeHarness();
    const turn = h.engine.submit("plan the launch");
    await h.emitted(2); // two events rendered, stream still open

    h.feed("\x03");
    await turn;

    expect(h.exit).not.toHaveBeenCalled();
    expect(h.engine.busy).toBe(false);
    expect(h.streamCompleted).toBe(false); // the producer was cut short
    expect(h.transcript().at(-1)).toContain("Interrupted");
    expect(h.promptsRendered).toBeGreaterThanOrEqual(1); // the prompt came back
  });

  it("exits 130 cleanly on a second press with nothing running", async () => {
    const h = makeHarness();
    const turn = h.engine.submit("plan the launch");
    await h.emitted(2);
    h.feed("\x03");
    await turn;

    h.feed("\x03");
    expect(h.exit).toHaveBeenCalledWith(EXIT.INTERRUPT);
    expect(h.exit).toHaveBeenCalledTimes(1);
  });
});
