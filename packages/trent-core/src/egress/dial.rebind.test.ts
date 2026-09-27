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
  it("pins a name to the loopback answer of its single resolution", async () => {
    const dns = rebinding(["127.0.0.1"], ["203.0.113.9"]);
    const pin = await assertLocalTarget("http://model.rebind.test:11434/api", { lookup: dns.lookup });
    expect(pin).toMatchObject({ host: "model.rebind.test", address: "127.0.0.1" });
    expect(dns.calls).toEqual(["model.rebind.test"]);
  });

  it("prefers the IPv4 loopback answer when the one resolution holds both families", async () => {
    const dns = rebinding(["::1", "127.0.0.1"], ["203.0.113.9"]);
    const pin = await assertLocalTarget("http://svc.localhost:8080/", { lookup: dns.lookup });
    expect(pin?.address).toBe("127.0.0.1");
  });

  it("still refuses a name whose one answer is off the machine", async () => {
    const dns = rebinding(["203.0.113.9"], ["127.0.0.1"]);
    await expect(assertLocalTarget("http://model.rebind.test:11434/", { lookup: dns.lookup })).rejects.toBeInstanceOf(EgressBlocked);
  });
});

describe("[D3] offline trentFetch connects to the validated address, not a second resolution", () => {
  it("rewrites the dial to the pinned loopback literal and keeps the Host header as the name", async () => {
    process.env.TRENT_OFFLINE = "1";
    const dns = rebinding(["127.0.0.1"], ["203.0.113.9"]);
    const seen = stubGlobalFetch();
    const res = await createTrentFetch({ lookup: dns.lookup })("http://model.rebind.test:11434/api/chat?x=1", { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: "http://127.0.0.1:11434/api/chat?x=1", method: "POST", host: "model.rebind.test:11434", body: "{}" });
    expect(dns.calls).toEqual(["model.rebind.test"]);
  });

  it("pins an IPv6 loopback answer as a bracketed literal", async () => {
    process.env.TRENT_OFFLINE = "1";
    const dns = rebinding(["::1"], ["203.0.113.9"]);
    const seen = stubGlobalFetch();
    await createTrentFetch({ lookup: dns.lookup })("http://svc.localhost:8080/v1", { method: "GET" });
    expect(seen[0]?.url).toBe("http://[::1]:8080/v1");
  });

  it("pins a Request input too, keeping its method and body", async () => {
    process.env.TRENT_OFFLINE = "1";
    const dns = rebinding(["127.0.0.1"], ["203.0.113.9"]);
    const seen = stubGlobalFetch();
    const req = new Request("http://model.rebind.test:11434/api", { method: "PUT", body: "payload" });
    await createTrentFetch({ lookup: dns.lookup })(req);
    expect(seen[0]).toMatchObject({ url: "http://127.0.0.1:11434/api", method: "PUT", host: "model.rebind.test:11434", body: "payload" });
  });

  it("refuses https to a DNS name offline: TLS cannot be pinned to the validated address", async () => {
    process.env.TRENT_OFFLINE = "1";
    const dns = rebinding(["127.0.0.1"], ["203.0.113.9"]);
    const seen = stubGlobalFetch();
    await expect(createTrentFetch({ lookup: dns.lookup })("https://model.rebind.test:8443/")).rejects.toBeInstanceOf(EgressBlocked);
    expect(seen).toHaveLength(0);
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
      // If the platform fetch re-resolved the name it would get 192.0.2.1 (TEST-NET-1) and fail.
      const dns = rebinding(["127.0.0.1"], ["192.0.2.1"]);
      const res = await createTrentFetch({ lookup: dns.lookup })(`http://model.rebind.test:${port}/real`, { method: "GET" });
      expect(await res.text()).toBe("served:/real");
      expect(dns.calls).toEqual(["model.rebind.test"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
