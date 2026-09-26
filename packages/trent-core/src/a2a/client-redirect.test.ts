/**
 * C4 RED — an A2A peer's bearer never follows a redirect.
 *
 * The client asks for `redirect: "error"` (client.ts `request`), and the production transport is the
 * egress fetch (`tools/a2a/build.ts`: `createEgressFetch` with the own-credential marker). The peer
 * sits behind a REAL EgressProxy on loopback and answers every message with a 302 to a second origin
 * that the proxy also allows. The bearer reaches the peer and never the redirect target, and the
 * send fails as a transport error that names the redirect.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CertificateAuthority } from "../egress/CertificateAuthority.js";
import { OWN_CREDENTIAL_HEADER } from "../egress/CredentialBroker.js";
import { EgressProxy } from "../egress/EgressProxy.js";
import { TokenManager } from "../egress/TokenManager.js";
import { createEgressFetch } from "../tools/web/proxied-fetch.js";
import { A2AClientError, sendA2AMessage } from "./client.js";

const PEER_HOST = "peer.a2a.test";
const THIRD_HOST = "collector.other.test";
const PEER_BEARER = "peer-bearer-fixture-for-the-peer-only";
const MODEL_KEY = "model-key-fixture-never-for-a-peer";
const PUBLIC_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];

interface Seen {
  readonly method: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

async function listen(answer: (res: http.ServerResponse) => void): Promise<{ port: number; seen: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      answer(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as { port: number }).port, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("the A2A client through the egress fetch, against a peer that redirects", () => {
  let peer: Awaited<ReturnType<typeof listen>>;
  let third: Awaited<ReturnType<typeof listen>>;
  let proxy: EgressProxy;
  let token: string;
  let dir: string;

  beforeAll(async () => {
    peer = await listen((res) => void res.writeHead(302, { location: `http://${THIRD_HOST}/collect` }).end());
    third = await listen((res) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: "x", result: { kind: "message", role: "agent", parts: [{ kind: "text", text: "stolen" }] } })));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-c4-a2a-"));
    const tokens = new TokenManager({ ephemeral: true });
    token = tokens.issueToken("trent-repl", { apiKey: MODEL_KEY }, "repl");
    proxy = new EgressProxy({
      port: 0,
      ca: new CertificateAuthority({ dir: path.join(dir, "ca") }),
      tokenManager: tokens,
      interceptDomains: [PEER_HOST, THIRD_HOST],
      upstreamOverrides: { [PEER_HOST]: { host: "127.0.0.1", port: peer.port }, [THIRD_HOST]: { host: "127.0.0.1", port: third.port } },
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await peer.close();
    await third.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends the bearer to the peer only: the 302 target receives nothing, and the send fails naming the redirect", async () => {
    const fetchImpl = createEgressFetch({ proxyUrl: `http://127.0.0.1:${proxy.getPort()}`, token, lookup: PUBLIC_LOOKUP });
    let failure: unknown;
    try {
      await sendA2AMessage({ endpoint: `http://${PEER_HOST}/`, dialect: "1.0", text: "hello peer" }, { fetchImpl, token: PEER_BEARER, headers: { [OWN_CREDENTIAL_HEADER]: "1" } });
    } catch (error) {
      failure = error;
    }

    expect(third.seen.map((s) => s.headers.authorization)).toEqual([]);
    expect(third.seen).toHaveLength(0);
    expect(peer.seen).toHaveLength(1);
    expect(peer.seen[0]!.headers.authorization).toBe(`Bearer ${PEER_BEARER}`);
    expect(JSON.stringify(peer.seen[0]!.headers)).not.toContain(MODEL_KEY);

    expect(failure).toBeInstanceOf(A2AClientError);
    expect((failure as A2AClientError).kind).toBe("transport");
    expect((failure as Error).message).toMatch(/redirect/);
    expect((failure as Error).message).not.toContain(PEER_BEARER);
  });
});
