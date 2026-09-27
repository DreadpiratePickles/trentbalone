/**
 * [SEC-2 S2a-2] The dial chokepoint. The property this suite pins: `trentFetch` consults offline mode
 * at CALL TIME and, while offline, refuses any non-loopback destination with {@link EgressBlocked}
 * before it opens a socket, while loopback (and, when offline is off, anything) passes straight
 * through to the platform `fetch`. `192.0.2.1` is RFC 5737 TEST-NET-1: a literal the address rule
 * treats as public, so no DNS is needed to prove a refusal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EgressBlocked } from "./offline.js";
import { trentFetch } from "./dial.js";

const OFFLINE = process.env.TRENT_OFFLINE;

afterEach(() => {
  if (OFFLINE === undefined) delete process.env.TRENT_OFFLINE;
  else process.env.TRENT_OFFLINE = OFFLINE;
  vi.unstubAllGlobals();
});

/** A `fetch` stub that records its calls and answers 200; installed as the platform global. */
function stubGlobalFetch(): { calls: Array<{ url: string }> } {
  const calls: Array<{ url: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    return new Response("ok", { status: 200 });
  });
  return { calls };
}

describe("trentFetch — offline dial guard", () => {
  it("refuses a non-loopback destination while offline, before opening a socket", async () => {
    process.env.TRENT_OFFLINE = "1";
    const { calls } = stubGlobalFetch();
    await expect(trentFetch("http://192.0.2.1/", { method: "GET" })).rejects.toBeInstanceOf(EgressBlocked);
    expect(calls).toHaveLength(0); // the socket is never opened
  });

  it("passes a loopback destination through to the platform fetch while offline", async () => {
    process.env.TRENT_OFFLINE = "1";
    const { calls } = stubGlobalFetch();
    const res = await trentFetch("http://127.0.0.1:11434/", { method: "GET" });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: "http://127.0.0.1:11434/" }]);
  });

  it("passes any destination through when offline is off", async () => {
    delete process.env.TRENT_OFFLINE;
    const { calls } = stubGlobalFetch();
    const res = await trentFetch("https://example.com/v1", { method: "GET" });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ url: "https://example.com/v1" }]);
  });

  it("reads offline mode at call time, not at import time", async () => {
    // off at first call
    delete process.env.TRENT_OFFLINE;
    const first = stubGlobalFetch();
    await expect(trentFetch("http://192.0.2.1/", { method: "GET" })).resolves.toHaveProperty("status", 200);
    expect(first.calls).toHaveLength(1);
    // flipped on for the next call — same imported binding now refuses
    vi.unstubAllGlobals();
    process.env.TRENT_OFFLINE = "1";
    stubGlobalFetch();
    await expect(trentFetch("http://192.0.2.1/", { method: "GET" })).rejects.toBeInstanceOf(EgressBlocked);
  });
});
