/**
 * P2-9 RED — the a2a toolset through the REAL egress proxy, with a broker token that carries a
 * credential, which is what the REPL's token carries (the model provider key,
 * `apps/cli/src/repl/tools.ts` providerCredentials).
 *
 * The proxy swaps its credential into every request it forwards (`CredentialBroker.ts`
 * applyCredentials): it deletes the client's own Authorization and writes the broker's. For a
 * model host that is the point. For an A2A peer it would strip the peer's bearer and hand the
 * peer the model key. These prove the toolset's requests keep their own bearer, never carry the
 * broker's credential or the broker token, and that the proxy's allowlist is still the second
 * gate: a configured peer whose host is not in `egress.intercept_domains` is refused there.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CertificateAuthority } from "../../egress/CertificateAuthority.js";
import { EgressProxy } from "../../egress/EgressProxy.js";
import { TokenManager } from "../../egress/TokenManager.js";
import { FakePeer } from "./testing/fake-peer.js";
import { action, approvedCall, buildA2aHarness, type A2aHarness, type HarnessPeer } from "./testing/harness.js";

const MODEL_KEY = "model-key-fixture-must-never-reach-a-peer";
const PEER_TOKEN = "peer-bearer-fixture";

let caDir: string;
let proxy: EgressProxy;
let brokerToken: string;
let harness: A2aHarness | undefined;
const peers: FakePeer[] = [];

beforeEach(async () => {
  caDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-a2a-egress-ca-"));
  const tokens = new TokenManager({ ephemeral: true });
  proxy = new EgressProxy({ port: 0, ca: new CertificateAuthority({ dir: caDir }), tokenManager: tokens, interceptDomains: ["127.0.0.1"] });
  await proxy.start();
  brokerToken = tokens.issueToken("trent-repl", { apiKey: MODEL_KEY }, "repl");
});

afterEach(async () => {
  harness?.cleanup();
  harness = undefined;
  for (const fake of peers.splice(0)) await fake.stop();
  await proxy.stop();
  fs.rmSync(caDir, { recursive: true, force: true });
});

async function fakePeer(token?: string): Promise<FakePeer> {
  const fake = new FakePeer({ card: "v1", ...(token === undefined ? {} : { token }) });
  await fake.start();
  peers.push(fake);
  return fake;
}

function viaProxy(entries: readonly HarnessPeer[], secrets: Record<string, string> = {}): A2aHarness {
  harness = buildA2aHarness({
    peers: entries,
    secrets,
    deps: { egress: { proxyUrl: `http://127.0.0.1:${proxy.getPort()}`, token: brokerToken, caCertPath: proxy.getCaCertPath() }, a2a: {} },
  });
  return harness;
}

function headerValues(fake: FakePeer): string {
  return JSON.stringify(fake.requests.map((request) => request.headers));
}

describe("a2a through the egress proxy", () => {
  it("delivers the peer's own bearer and never the broker's credential or token", async () => {
    const hermes = await fakePeer(PEER_TOKEN);
    const { adapter } = viaProxy([{ name: "hermes", url: hermes.url, token_env: "HERMES_A2A_TOKEN" }], { HERMES_A2A_TOKEN: PEER_TOKEN });
    const discovered = await adapter.execute(action("a2a_discover", { peer: "hermes" }), {});
    expect(discovered.status).toBe("completed");
    const { done } = await approvedCall(adapter, "run_e1", "step_1", action("a2a_send", { peer: "hermes", message: "status of the migration?" }));
    expect(done.status).toBe("completed");
    expect(done.summary).toContain("echo: status of the migration?");
    expect(hermes.rpc()).toHaveLength(1);
    expect(hermes.rpc()[0]!.headers.authorization).toBe(`Bearer ${PEER_TOKEN}`);
    // The card is public: it is fetched with no credential at all.
    expect(hermes.requests.filter((request) => request.method === "GET").every((request) => request.headers.authorization === undefined)).toBe(true);
    expect(headerValues(hermes)).not.toContain(MODEL_KEY);
    expect(headerValues(hermes)).not.toContain(brokerToken);
  });

  it("sends a tokenless peer no Authorization header at all", async () => {
    const open = await fakePeer();
    const { adapter } = viaProxy([{ name: "open", url: open.url }]);
    const { done } = await approvedCall(adapter, "run_e2", "step_1", action("a2a_send", { peer: "open", message: "ping" }));
    expect(done.status).toBe("completed");
    expect(open.requests.length).toBeGreaterThan(0);
    for (const request of open.requests) expect(request.headers.authorization, request.path).toBeUndefined();
    expect(headerValues(open)).not.toContain(MODEL_KEY);
  });

  it("is refused by the proxy for a configured peer whose host is not in egress.intercept_domains", async () => {
    const elsewhere = await fakePeer();
    const port = new URL(elsewhere.url).port;
    const { adapter } = viaProxy([{ name: "elsewhere", url: `http://localhost:${port}` }]);
    const refused = await adapter.execute(action("a2a_discover", { peer: "elsewhere" }), {});
    expect(refused.status).toBe("failed");
    expect(refused.summary).toMatch(/egress proxy refused/);
    expect(refused.summary).toContain("egress.intercept_domains");
    expect(elsewhere.requests).toHaveLength(0);
  });
});
