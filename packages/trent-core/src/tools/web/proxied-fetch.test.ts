/**
 * C4 RED — where a request's credentials and body go when the answer is a redirect.
 *
 * Two fake origins on loopback behind a REAL EgressProxy (plain http, the proxy's forward path),
 * each recording the headers and body it received. The first answers 3xx to the second. A redirect
 * that leaves the origin the caller named must arrive with no `Authorization`, no cookie, no key, no
 * proxy token, no own-credential marker and no body; a same-origin hop keeps them; `redirect:
 * "error"` and `"manual"` are honoured; at most five hops are followed.
 *
 * A recording forward proxy then shows the exact wire the client hands the proxy on a stripped hop:
 * the transport's own token (the proxy's gate needs it) with the own-credential marker, so the
 * broker writes no brokered secret into a request to a host the caller never named.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CertificateAuthority } from "../../egress/CertificateAuthority.js";
import { EgressProxy } from "../../egress/EgressProxy.js";
import { TokenManager } from "../../egress/TokenManager.js";
import { createEgressFetch, keepsCredentials, nextRedirectHop, RedirectBlockedError, type RedirectHop } from "./proxied-fetch.js";

const A_HOST = "origin-a.test";
const B_HOST = "origin-b.test";
const CALLER_BEARER = "caller-bearer-fixture";
const CALLER_KEY = "caller-api-key-fixture";
const COOKIE = "session=cookie-fixture";
const RECORD_SECRET = "record-secret-fixture-must-never-reach-an-origin";
const BODY = JSON.stringify({ payload: "body-fixture-for-the-first-origin-only" });
const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

interface Recorder {
  readonly port: number;
  readonly seen: Seen[];
  close(): Promise<void>;
}

type Answer = (seen: Seen) => { status: number; headers?: Record<string, string>; body?: string };

async function recorder(answer: Answer): Promise<Recorder> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(entry);
      const out = answer(entry);
      res.writeHead(out.status, out.headers ?? {});
      res.end(out.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { port, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** The first origin: every path names the redirect it answers with. */
const answerA: Answer = ({ url }) => {
  if (url === "/hop-302" || url === "/hop-307-cross") return { status: url === "/hop-302" ? 302 : 307, headers: { location: `http://${B_HOST}/landing` } };
  if (url === "/hop-same") return { status: 307, headers: { location: "/after" } };
  const loop = /^\/loop\/(\d+)$/.exec(url);
  if (loop) return { status: 302, headers: { location: `/loop/${Number(loop[1]) + 1}` } };
  return { status: 200, body: "first origin" };
};

function credentialed(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${CALLER_BEARER}`, cookie: COOKIE, "x-api-key": CALLER_KEY, "content-type": "application/json", "x-trent-own-credential": "1", ...extra };
}

describe("proxied fetch redirects through the real egress proxy", () => {
  let a: Recorder;
  let b: Recorder;
  let proxy: EgressProxy;
  let token: string;
  let dir: string;

  beforeAll(async () => {
    a = await recorder(answerA);
    b = await recorder(() => ({ status: 200, body: "second origin" }));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-c4-redirect-"));
    const tokens = new TokenManager({ ephemeral: true });
    token = tokens.issueToken("seat", { apiKey: RECORD_SECRET });
    proxy = new EgressProxy({
      port: 0,
      ca: new CertificateAuthority({ dir: path.join(dir, "ca") }),
      tokenManager: tokens,
      interceptDomains: [A_HOST, B_HOST],
      upstreamOverrides: { [A_HOST]: { host: "127.0.0.1", port: a.port }, [B_HOST]: { host: "127.0.0.1", port: b.port } },
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await a.close();
    await b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const egressFetch = () => createEgressFetch({ proxyUrl: `http://127.0.0.1:${proxy.getPort()}`, token, lookup: PUBLIC_LOOKUP });

  it("a cross-origin 302 reaches the second origin as a GET with no credential, no token and no body", async () => {
    const aBefore = a.seen.length;
    const bBefore = b.seen.length;
    const response = await egressFetch()(`http://${A_HOST}/hop-302`, { method: "POST", headers: credentialed(), body: BODY });
    expect(await response.text()).toBe("second origin");

    const first = a.seen.slice(aBefore);
    expect(first.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /hop-302"]);
    expect(first[0]!.headers.authorization).toBe(`Bearer ${CALLER_BEARER}`);
    expect(first[0]!.headers.cookie).toBe(COOKIE);
    expect(first[0]!.body).toBe(BODY);

    const second = b.seen.slice(bBefore);
    expect(second.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /landing"]);
    const landed = second[0]!;
    for (const name of ["authorization", "cookie", "x-api-key", "content-type", "x-trent-proxy-token", "x-trent-own-credential", "proxy-authorization"]) {
      expect(landed.headers[name], name).toBeUndefined();
    }
    expect(landed.body).toBe("");
    const everything = JSON.stringify(landed.headers) + landed.body;
    for (const secret of [CALLER_BEARER, CALLER_KEY, COOKIE, RECORD_SECRET, token, "body-fixture"]) expect(everything).not.toContain(secret);
  });

  it("a same-origin 307 keeps the credential, the method and the body", async () => {
    const aBefore = a.seen.length;
    const bBefore = b.seen.length;
    const response = await egressFetch()(`http://${A_HOST}/hop-same`, { method: "POST", headers: credentialed(), body: BODY });
    expect(await response.text()).toBe("first origin");
    const hops = a.seen.slice(aBefore);
    expect(hops.map((s) => `${s.method} ${s.url}`)).toEqual(["POST /hop-same", "POST /after"]);
    for (const hop of hops) {
      expect(hop.headers.authorization).toBe(`Bearer ${CALLER_BEARER}`);
      expect(hop.body).toBe(BODY);
    }
    expect(b.seen.length).toBe(bBefore);
  });

  it('honours redirect: "error": the 3xx throws and nothing reaches the redirect target', async () => {
    const bBefore = b.seen.length;
    const call = egressFetch()(`http://${A_HOST}/hop-302`, { method: "POST", headers: credentialed(), body: BODY, redirect: "error" });
    await expect(call).rejects.toBeInstanceOf(RedirectBlockedError);
    await expect(egressFetch()(`http://${A_HOST}/hop-302`, { redirect: "error" })).rejects.toThrow(/redirect/);
    expect(b.seen.length).toBe(bBefore);
  });

  it('honours redirect: "manual": the 3xx comes back with its Location, unfollowed', async () => {
    const bBefore = b.seen.length;
    const response = await egressFetch()(`http://${A_HOST}/hop-302`, { method: "POST", headers: credentialed(), body: BODY, redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`http://${B_HOST}/landing`);
    expect(b.seen.length).toBe(bBefore);
  });

  it("refuses a cross-origin 307 that would re-send the body, and sends the second origin nothing", async () => {
    const bBefore = b.seen.length;
    await expect(egressFetch()(`http://${A_HOST}/hop-307-cross`, { method: "POST", headers: credentialed(), body: BODY })).rejects.toThrow(RedirectBlockedError);
    expect(b.seen.length).toBe(bBefore);
  });

  it("follows at most five redirects", async () => {
    const aBefore = a.seen.length;
    await expect(egressFetch()(`http://${A_HOST}/loop/0`)).rejects.toThrow(/too many redirects/);
    expect(a.seen.slice(aBefore).map((s) => s.url)).toEqual(["/loop/0", "/loop/1", "/loop/2", "/loop/3", "/loop/4", "/loop/5"]);
  });
});

describe("the wire a stripped hop hands the proxy", () => {
  let fakeProxy: Recorder;

  beforeAll(async () => {
    fakeProxy = await recorder(({ url }) => (url === `http://${A_HOST}/hop-302` ? { status: 302, headers: { location: `http://${B_HOST}/landing` } } : { status: 200, body: "ok" }));
  });

  afterAll(async () => {
    await fakeProxy.close();
  });

  it("carries the transport's token for the gate and the own-credential marker, and none of the caller's credentials", async () => {
    const egressFetch = createEgressFetch({ proxyUrl: `http://127.0.0.1:${fakeProxy.port}`, token: "trnt_egress_transport-token-fixture", lookup: PUBLIC_LOOKUP });
    // The caller sends no marker of its own (a brokered call, as web_search sends its key).
    const headers = { authorization: `Bearer ${CALLER_BEARER}`, cookie: COOKIE, "proxy-authorization": "Basic proxy-fixture", "x-goog-api-key": CALLER_KEY };
    await egressFetch(`http://${A_HOST}/hop-302`, { method: "POST", headers, body: BODY });
    const [first, second] = fakeProxy.seen;
    expect(first!.url).toBe(`http://${A_HOST}/hop-302`);
    expect(first!.headers["x-trent-own-credential"]).toBeUndefined();
    expect(second!.url).toBe(`http://${B_HOST}/landing`);
    expect(second!.method).toBe("GET");
    expect(second!.headers["x-trent-proxy-token"]).toBe("trnt_egress_transport-token-fixture");
    expect(second!.headers["x-trent-own-credential"]).toBe("1");
    for (const name of ["authorization", "cookie", "proxy-authorization", "x-goog-api-key"]) expect(second!.headers[name], name).toBeUndefined();
    expect(second!.body).toBe("");
  });
});

describe("the shared redirect rule", () => {
  const hop = (method: string, url = `http://${A_HOST}/x`): RedirectHop => ({ url: new URL(url), method, headers: { authorization: "Bearer t", "content-type": "text/plain" }, body: method === "GET" || method === "HEAD" ? undefined : "b", stripped: false });
  const same = new URL(`http://${A_HOST}/y`);

  it("rewrites the method as fetch does: 301/302 turn a POST into a GET, 303 anything but GET/HEAD; 307/308 keep it", () => {
    for (const status of [301, 302]) expect(nextRedirectHop(hop("POST"), status, same)).toMatchObject({ method: "GET", body: undefined, headers: { authorization: "Bearer t" } });
    expect(nextRedirectHop(hop("PUT"), 302, same)).toMatchObject({ method: "PUT", body: "b" });
    expect(nextRedirectHop(hop("PUT"), 303, same)).toMatchObject({ method: "GET", body: undefined });
    expect(nextRedirectHop(hop("HEAD"), 303, same).method).toBe("HEAD");
    for (const status of [307, 308]) expect(nextRedirectHop(hop("POST"), status, same)).toMatchObject({ method: "POST", body: "b", headers: { "content-type": "text/plain" } });
    expect(nextRedirectHop(hop("POST"), 302, same).headers["content-type"]).toBeUndefined();
  });

  it("keeps a credential on the same origin or the same host upgraded to https, and nowhere else", () => {
    const from = new URL(`http://${A_HOST}/x`);
    expect(keepsCredentials(from, new URL(`http://${A_HOST}/other`))).toBe(true);
    expect(keepsCredentials(from, new URL(`https://${A_HOST}/x`))).toBe(true);
    expect(keepsCredentials(new URL(`https://${A_HOST}/x`), new URL(`http://${A_HOST}/x`))).toBe(false);
    expect(keepsCredentials(from, new URL(`http://${A_HOST}:8080/x`))).toBe(false);
    expect(keepsCredentials(from, new URL(`http://${B_HOST}/x`))).toBe(false);
  });
});
