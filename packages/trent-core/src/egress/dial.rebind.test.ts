/**
 * [D3] DNS rebinding / resolve-then-connect in offline mode.
 *
 * `assertLocalTarget` used to resolve the host, check every address was loopback, and return nothing;
 * `trentFetch` then handed the HOSTNAME to the platform `fetch`, which resolved it a second time. A
 * rebinding resolver answering loopback to the guard and a public address to `fetch` defeated the
 * offline guarantee. The property pinned here: one resolution decides AND addresses the dial — the
 * guard returns the validated address and `trentFetch` connects to exactly that literal.
 *
 * Every resolver here is injected and answers differently on its second query. No real DNS.
 *
 * [DNS-name leak] Offline, no name is resolved at all any more (the query itself leaves the machine):
 * `*.localhost` is pinned to 127.0.0.1 by definition and any other name is refused unresolved. The
 * tests below used `model.rebind.test` resolved through the injected lookup; they now use
 * `model.localhost`, and every resolver must stay at ZERO calls. The pinning mechanics they pin (the
 * dial goes to the literal, the Host header keeps the name) are unchanged.
 */
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EgressBlocked, assertLocalTarget } from "./offline.js";
import { createTrentFetch } from "./dial.js";
import type { LookupFn } from "../tools/web/url-safety.js";

const OFFLINE = process.env.TRENT_OFFLINE;

afterEach(() => {
  if (OFFLINE === undefined) delete process.env.TRENT_OFFLINE;
  else process.env.TRENT_OFFLINE = OFFLINE;
  vi.unstubAllGlobals();
});

/** A resolver that answers `first` on the first query and `later` on every query after it. */
function rebinding(first: string[], later: string[]): { lookup: LookupFn; calls: string[] } {
  const calls: string[] = [];
  const lookup: LookupFn = async (host) => {
    calls.push(host);
    const answer = calls.length === 1 ? first : later;
    return answer.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
  };
  return { lookup, calls };
}

interface Seen {
  url: string;
  method: string;
  host: string | null;
  body: string;
}

/** Install a platform `fetch` stub that records what it was asked to dial. */
function stubGlobalFetch(): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, method: req.method, host: new Headers(init?.headers).get("host"), body: await req.text() });
    return new Response("ok", { status: 200 });
  });
  return seen;
}

describe("[D3] assertLocalTarget returns the address it validated", () => {
  it("pins a *.localhost name to 127.0.0.1 without any resolution", async () => {
    const dns = rebinding(["203.0.113.9"], ["203.0.113.9"]);
    const pin = await assertLocalTarget("http://model.localhost:11434/api", { lookup: dns.lookup });
    expect(pin).toMatchObject({ host: "model.localhost", address: "127.0.0.1" });
    expect(dns.calls).toEqual([]);
  });

  it("pins a *.localhost name to IPv4 loopback even when a resolver would answer ::1 first", async () => {
    const dns = rebinding(["::1", "127.0.0.1"], ["203.0.113.9"]);
    const pin = await assertLocalTarget("http://svc.localhost:8080/", { lookup: dns.lookup });
    expect(pin?.address).toBe("127.0.0.1");
    expect(dns.calls).toEqual([]);
  });

  it("refuses a name that is not local by definition without resolving it, even if it would answer loopback", async () => {
    const dns = rebinding(["127.0.0.1"], ["127.0.0.1"]);
    await expect(assertLocalTarget("http://model.rebind.test:11434/", { lookup: dns.lookup })).rejects.toBeInstanceOf(EgressBlocked);
    expect(dns.calls).toEqual([]);
  });
});

describe("[D3] offline trentFetch connects to the validated address, not a second resolution", () => {
  it("rewrites the dial to the pinned loopback literal and keeps the Host header as the name", async () => {
    process.env.TRENT_OFFLINE = "1";
    const dns = rebinding(["127.0.0.1"], ["203.0.113.9"]);
    const seen = stubGlobalFetch();
    const res = await createTrentFetch({ lookup: dns.lookup })("http://model.localhost:11434/api/chat?x=1", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "http://127.0.0.1:11434/api/chat?x=1", method: "POST", host: "model.localhost:11434", body: "{}" });
    expect(dns.calls).toEqual([]);
  });

  // An IPv6 pin used to come from a `*.localhost` name answering ::1; offline no answer is asked for,
  // so IPv6 loopback is reached only as a literal, which is dialled as written.
  it("leaves an IPv6 loopback literal untouched, consulting no resolver", async () => {
    process.env.TRENT_OFFLINE = "1";
    const dns = rebinding(["203.0.113.9"], ["203.0.113.9"]);
    const seen = stubGlobalFetch();
    await createTrentFetch({ lookup: dns.lookup })("http://[::1]:8080/v1", { method: "GET" });
    expect(seen[0]?.url).toBe("http://[::1]:8080/v1");
    expect(dns.calls).toEqual([]);
  });

  it("pins a Request input too, keeping its method and body", async () => {
    process.env.TRENT_OFFLINE = "1";
    const dns = rebinding(["127.0.0.1"], ["203.0.113.9"]);
    const seen = stubGlobalFetch();
    const req = new Request("http://model.localhost:11434/api", { method: "PUT", body: "payload" });
    await createTrentFetch({ lookup: dns.lookup })(req);
    expect(seen[0]).toMatchObject({ url: "http://127.0.0.1:11434/api", method: "PUT", host: "model.localhost:11434", body: "payload" });
    expect(dns.calls).toEqual([]);
  });

  it("refuses https to a *.localhost name offline: TLS cannot be pinned to the validated address", async () => {
    process.env.TRENT_OFFLINE = "1";
    const dns = rebinding(["127.0.0.1"], ["203.0.113.9"]);
    const seen = stubGlobalFetch();
    await expect(createTrentFetch({ lookup: dns.lookup })("https://model.localhost:8443/")).rejects.toThrow(/cannot be pinned/);
    expect(seen).toHaveLength(0);
    expect(dns.calls).toEqual([]);
  });

  it("leaves a loopback literal and plain `localhost` untouched, consulting no resolver", async () => {
    process.env.TRENT_OFFLINE = "1";
    const dns = rebinding(["203.0.113.9"], ["203.0.113.9"]);
    const seen = stubGlobalFetch();
    const dial = createTrentFetch({ lookup: dns.lookup });
    await dial("http://127.0.0.1:11434/a", { method: "GET" });
    await dial("http://localhost:11434/b", { method: "GET" });
    expect(seen.map((s) => s.url)).toEqual(["http://127.0.0.1:11434/a", "http://localhost:11434/b"]);
    expect(dns.calls).toEqual([]);
  });

  it("does not resolve or rewrite anything when offline is off", async () => {
    delete process.env.TRENT_OFFLINE;
    const dns = rebinding(["127.0.0.1"], ["127.0.0.1"]);
    const seen = stubGlobalFetch();
    await createTrentFetch({ lookup: dns.lookup })("https://example.com/v1", { method: "GET" });
    expect(seen[0]?.url).toBe("https://example.com/v1");
    expect(dns.calls).toEqual([]);
  });

  it("reaches a real loopback server through the platform fetch with the second answer poisoned", async () => {
    process.env.TRENT_OFFLINE = "1";
    const server = http.createServer((req, res) => res.end(`served:${req.url}`));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      // Every answer is poisoned (192.0.2.1, TEST-NET-1): a dial that asked the resolver, or a platform
      // fetch that re-resolved the name, would fail. Offline the name is pinned by definition instead.
      const dns = rebinding(["192.0.2.1"], ["192.0.2.1"]);
      const res = await createTrentFetch({ lookup: dns.lookup })(`http://model.localhost:${port}/real`, { method: "GET" });
      expect(await res.text()).toBe("served:/real");
      expect(dns.calls).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
