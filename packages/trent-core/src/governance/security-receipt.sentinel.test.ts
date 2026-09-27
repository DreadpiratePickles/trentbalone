/**
 * [D16] The receipt never carries a secret value.
 *
 * A real `EgressProxy` brokers a sentinel key to a fake HTTPS upstream on loopback, so the key is
 * really written onto a real outbound request; the proxy's decision hook feeds the collector. Tool
 * records whose summaries and actions carry the sentinel go through the observed adapters and the
 * observed ledger. The sentinel, and the opaque token, must then appear nowhere in the receipt's
 * JSON or its human render — while the receipt still shows the injection happened.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CertificateAuthority } from "../egress/CertificateAuthority.js";
import { EgressProxy, type EgressDecision } from "../egress/EgressProxy.js";
import { TokenManager } from "../egress/TokenManager.js";
import { proxyRequest, startRecordingUpstream, type RecordingUpstream } from "../egress/test-helpers.js";
import { createProvenanceLedger } from "./provenance.js";
import { buildSecurityReceipt, renderSecurityReceipt } from "./security-receipt.js";
import { createRunSecurityCollector } from "./security-receipt-collector.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";

const SENTINEL = "sk-SENTINEL-d16-receipt-must-never-show-this-0123456789";
const PROVIDER_HOST = "api.openai.com";
const BLOCKED_HOST = "exfil.example";

describe("the security receipt never contains a brokered secret", () => {
  const dirs: string[] = [];
  const decisions: EgressDecision[] = [];
  let upstream: RecordingUpstream;
  let proxyCa: CertificateAuthority;
  let proxy: EgressProxy;
  let tokens: TokenManager;
  const collector = createRunSecurityCollector({ backend: "local", offline: false, egressState: "on", credentialProvider: "openai" });

  function tmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  beforeAll(async () => {
    const upstreamCa = new CertificateAuthority({ dir: tmp("trent-d16-up-ca-") });
    const leaf = upstreamCa.issueLeaf(PROVIDER_HOST);
    upstream = await startRecordingUpstream(leaf.certPem, leaf.keyPem);
    proxyCa = new CertificateAuthority({ dir: tmp("trent-d16-ca-") });
    tokens = new TokenManager({ ephemeral: true });
    proxy = new EgressProxy({
      port: 0,
      ca: proxyCa,
      tokenManager: tokens,
      interceptDomains: [PROVIDER_HOST],
      upstreamCa: [upstreamCa.getCertPem()],
      upstreamOverrides: { [PROVIDER_HOST]: { host: "127.0.0.1", port: upstream.port } },
      log: () => undefined,
      onDecision: (decision) => {
        decisions.push(decision);
        collector.egressDecision(decision);
      },
    });
    await proxy.start();
  });

  afterAll(async () => {
    await proxy.stop();
    await upstream.close();
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the proxy really injected the sentinel, and the receipt shows the injection but never the value", async () => {
    const token = tokens.issueToken("trent-run", { apiKey: SENTINEL }, "run", { hosts: [PROVIDER_HOST] });
    const caPem = proxyCa.getCertPem();
    const ok = await proxyRequest({ proxyPort: proxy.getPort(), host: PROVIDER_HOST, path: "/v1/models", headers: { authorization: `Bearer ${token}` }, caPem });
    expect(ok.status).toBe(200);
    // The key reached the upstream: this is a real injection, not a test of nothing.
    expect(JSON.stringify(upstream.requests.at(-1)?.headers)).toContain(SENTINEL);
    const noToken = await proxyRequest({ proxyPort: proxy.getPort(), host: PROVIDER_HOST, path: "/v1/models", headers: {}, caPem });
    expect(noToken.status).toBe(407);
    const blocked = await proxyRequest({ proxyPort: proxy.getPort(), host: BLOCKED_HOST, path: `/?k=${SENTINEL}`, headers: { authorization: `Bearer ${token}` }, caPem });
    expect(blocked.connectStatus).toBe(403);

    expect(decisions).toEqual([
      { host: PROVIDER_HOST, port: 443, verdict: "allowed", credential: "injected" },
      { host: PROVIDER_HOST, port: 443, verdict: "refused", rule: "no_resolvable_token" },
      { host: BLOCKED_HOST, port: 443, verdict: "refused", rule: "host_not_allowlisted" },
    ]);

    // Tool calls whose action and summary carry the sentinel: a deny-glob refusal quotes its subject,
    // a completed call echoes it, and a model-named "tool" in the ledger is the sentinel itself.
    const echo = (status: ToolCallRecord["status"], summary: string): TrentToolAdapter => ({
      name: "file_ops",
      scopes: ["read_file"],
      instructions: "",
      routingText: "",
      healthCheck: async () => "connected",
      estimateCost: () => 0,
      requiresApproval: () => false,
      execute: async (action: string) => ({ adapter: "file_ops", action, status, summary }),
      cleanup: async () => undefined,
    });
    const [denied] = collector.observeAdapters([echo("blocked", `Refused by approvals.deny glob **/.env, which matched: ${SENTINEL}`)]);
    const [echoed] = collector.observeAdapters([echo("completed", `file contents: ${SENTINEL}`)]);
    await denied!.execute(`read_file {"path":"${SENTINEL}"}`, {});
    await echoed!.execute(`${SENTINEL} {"path":"x"}`, {});
    collector.knowTools(["read_file"]);
    collector.observeLedger(createProvenanceLedger()).note(SENTINEL, "untrusted");

    const receipt = buildSecurityReceipt(collector.snapshot());
    const json = JSON.stringify(receipt);
    const human = renderSecurityReceipt(receipt).join("\n");
    for (const secret of [SENTINEL, token]) {
      expect(json).not.toContain(secret);
      expect(human).not.toContain(secret);
    }
    // ...and it still says what happened.
    expect(receipt.credentials).toEqual([{ provider: "openai", injected: 1, withheld: 0 }]);
    expect(receipt.egress.hosts).toEqual([
      { host: PROVIDER_HOST, allowed: 1, refused: 1, rules: ["no_resolvable_token"] },
      { host: BLOCKED_HOST, allowed: 0, refused: 1, rules: ["host_not_allowlisted"] },
    ]);
    expect(receipt.refusals.entries).toEqual([{ kind: "deny_glob", rule: "**/.env", tool: "read_file", count: 1 }]);
    expect(receipt.provenance.untrustedSources).toEqual([{ tool: "(unlisted tool)", calls: 1 }]);
  });

  it("a decision hook that throws never breaks the proxy", async () => {
    const throwing = new EgressProxy({
      port: 0,
      ca: proxyCa,
      tokenManager: tokens,
      interceptDomains: [PROVIDER_HOST],
      log: () => undefined,
      onDecision: () => {
        throw new Error("observer failure");
      },
    });
    await throwing.start();
    try {
      const res = await proxyRequest({ proxyPort: throwing.getPort(), host: BLOCKED_HOST, path: "/", headers: {}, caPem: proxyCa.getCertPem() });
      expect(res.connectStatus).toBe(403);
      const again = await proxyRequest({ proxyPort: throwing.getPort(), host: BLOCKED_HOST, path: "/", headers: {}, caPem: proxyCa.getCertPem() });
      expect(again.connectStatus).toBe(403);
    } finally {
      await throwing.stop();
    }
  });
});
