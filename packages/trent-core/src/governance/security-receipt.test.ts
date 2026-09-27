/**
 * [D16] The per-run security receipt: a pure view over what the run's collector saw, and the collector
 * that sees it. The view is asserted whole (the JSON shape is a contract a script reads); the collector
 * is fed the records the real gates return, spelled the way `governance/autonomy.ts` and
 * `governance/provenance.ts` spell them, and the ledger/adapter observers are driven through real calls.
 */
import { describe, expect, it } from "vitest";
import { buildSecurityReceipt, renderSecurityReceipt, type RunSecurityRecord } from "./security-receipt.js";
import { classifyToolRecord, createRunSecurityCollector } from "./security-receipt-collector.js";
import { createProvenanceLedger } from "./provenance.js";
import type { ToolCallRecord, TrentToolAdapter } from "../tools/types.js";

const EMPTY: RunSecurityRecord = {
  offline: false,
  backend: "docker",
  egress: { state: "on", hosts: [], otherHosts: { allowed: 0, refused: 0, count: 0 } },
  credentials: [],
  untrusted: [],
  networkDerivedWorkspace: false,
  tools: [],
  holds: [],
  refusals: [],
};

function adapter(name: string, scopes: string[], respond: (action: string) => ToolCallRecord): TrentToolAdapter {
  return {
    name,
    scopes,
    instructions: "",
    routingText: "",
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    execute: async (action: string) => respond(action),
    cleanup: async () => undefined,
  };
}

const rec = (adapterName: string, status: ToolCallRecord["status"], summary: string): ToolCallRecord => ({ adapter: adapterName, action: "", status, summary });

describe("buildSecurityReceipt — the view is a total function of the record", () => {
  it("an empty docker run is an empty, isolated receipt with every section present", () => {
    expect(buildSecurityReceipt(EMPTY)).toEqual({
      version: 1,
      offline: false,
      terminal: { backend: "docker", isolated: true },
      egress: { proxy: "on", allowed: 0, refused: 0, hosts: [], otherHosts: 0 },
      credentials: [],
      provenance: { untrustedCalls: 0, untrustedSources: [], networkDerivedWorkspace: false },
      tools: [],
      holds: { total: 0, entries: [] },
      refusals: { total: 0, entries: [] },
    });
  });

  it("totals, sorts and keeps every rule id; the local backend is not isolated", () => {
    const record: RunSecurityRecord = {
      ...EMPTY,
      offline: true,
      backend: "local",
      egress: {
        state: "on",
        hosts: [
          { host: "evil.example", allowed: 0, refused: 2, rules: ["host_not_allowlisted"] },
          { host: "api.openai.com", allowed: 3, refused: 1, rules: ["no_resolvable_token"] },
        ],
        otherHosts: { allowed: 1, refused: 4, count: 2 },
      },
      credentials: [{ provider: "openai", injected: 3, withheld: 1 }],
      untrusted: [{ tool: "web_search", calls: 2 }, { tool: "fetch_url", calls: 1 }],
      networkDerivedWorkspace: true,
      tools: [{ tool: "web_search", calls: 2 }, { tool: "read_file", calls: 5 }],
      holds: [{ kind: "provenance", tool: "memory", count: 1 }],
      refusals: [
        { kind: "hardline", rule: "rm-root", tool: "terminal", count: 2 },
        { kind: "approval_floor", rule: "mkfs", tool: "terminal", count: 1 },
      ],
    };
    expect(buildSecurityReceipt(record)).toEqual({
      version: 1,
      offline: true,
      terminal: { backend: "local", isolated: false },
      egress: {
        proxy: "on",
        allowed: 4,
        refused: 7,
        hosts: [
          { host: "api.openai.com", allowed: 3, refused: 1, rules: ["no_resolvable_token"] },
          { host: "evil.example", allowed: 0, refused: 2, rules: ["host_not_allowlisted"] },
        ],
        otherHosts: 2,
      },
      credentials: [{ provider: "openai", injected: 3, withheld: 1 }],
      provenance: {
        untrustedCalls: 3,
        untrustedSources: [{ tool: "web_search", calls: 2 }, { tool: "fetch_url", calls: 1 }],
        networkDerivedWorkspace: true,
      },
      tools: [{ tool: "read_file", calls: 5 }, { tool: "web_search", calls: 2 }],
      holds: { total: 1, entries: [{ kind: "provenance", tool: "memory", count: 1 }] },
      refusals: {
        total: 3,
        entries: [
          { kind: "hardline", rule: "rm-root", tool: "terminal", count: 2 },
          { kind: "approval_floor", rule: "mkfs", tool: "terminal", count: 1 },
        ],
      },
    });
  });

  it("the record is not mutated by building the view", () => {
    const record = structuredClone({ ...EMPTY, tools: [{ tool: "b", calls: 1 }, { tool: "a", calls: 1 }] });
    const before = JSON.stringify(record);
    buildSecurityReceipt(record);
    expect(JSON.stringify(record)).toBe(before);
  });
});

describe("renderSecurityReceipt — the human ledger", () => {
  it("names hosts, rules, providers, holds and refusals, and flags a local terminal as not isolated", () => {
    const lines = renderSecurityReceipt(
      buildSecurityReceipt({
        ...EMPTY,
        backend: "local",
        egress: { state: "on", hosts: [{ host: "api.openai.com", allowed: 3, refused: 0, rules: [] }, { host: "evil.example", allowed: 0, refused: 1, rules: ["host_not_allowlisted"] }], otherHosts: { allowed: 0, refused: 0, count: 0 } },
        credentials: [{ provider: "openai", injected: 3, withheld: 0 }],
        untrusted: [{ tool: "web_search", calls: 2 }],
        networkDerivedWorkspace: true,
        holds: [{ kind: "provenance", tool: "memory", count: 1 }],
        refusals: [{ kind: "hardline", rule: "rm-root", tool: "terminal", count: 1 }],
      }),
    );
    const text = lines.join("\n");
    expect(lines[0]).toBe("Security receipt");
    expect(text).toContain("3 allowed · 1 refused");
    expect(text).toContain("api.openai.com ×3");
    expect(text).toContain("evil.example ×1 (host_not_allowlisted)");
    expect(text).toContain("openai");
    expect(text).toContain("web_search ×2");
    expect(text).toContain("workspace network-derived");
    expect(text).toContain("provenance hold: memory");
    expect(text).toContain("hardline rm-root: terminal");
    expect(text).toContain("terminal local (not isolated)");
    expect(text).toContain("offline off");
  });

  it("says plainly when egress was off or failed, and when nothing was held or refused", () => {
    const off = renderSecurityReceipt(buildSecurityReceipt({ ...EMPTY, egress: { ...EMPTY.egress, state: "off" } })).join("\n");
    expect(off).toContain("proxy off");
    expect(off).toContain("terminal docker");
    expect(off).not.toContain("not isolated");
    expect(off).toMatch(/holds\s+none/);
    expect(off).toMatch(/refusals\s+none/);
    const failed = renderSecurityReceipt(buildSecurityReceipt({ ...EMPTY, egress: { ...EMPTY.egress, state: "failed" } })).join("\n");
    expect(failed).toContain("proxy FAILED");
  });
});

describe("classifyToolRecord — the dispatch path's own refusal and hold results", () => {
  it("reads the rule off each gate's summary, never the arguments", () => {
    expect(classifyToolRecord(rec("terminal", "blocked", "Hardline rule rm-root-home: a recursive delete has no recovery path. No autonomy level lifts this."))).toEqual({ outcome: "refusal", kind: "hardline", rule: "rm-root-home" });
    expect(classifyToolRecord(rec("file_ops", "blocked", "Refused by approvals.deny glob **/secrets/**, which matched: /w/secrets/k.txt"))).toEqual({ outcome: "refusal", kind: "deny_glob", rule: "**/secrets/**" });
    expect(classifyToolRecord(rec("terminal", "blocked", "Approval floor: format a filesystem (mkfs). This is never auto-approvable, at any autonomy level."))).toEqual({ outcome: "refusal", kind: "approval_floor", rule: "format a filesystem (mkfs)" });
    expect(classifyToolRecord(rec("skills", "blocked", "skills refused: this step read output from web_search, and a skill authored from untrusted context is not written."))).toEqual({ outcome: "refusal", kind: "provenance", rule: "untrusted_context" });
    expect(classifyToolRecord(rec("web", "blocked", "blocked: that URL resolves to a private address"))).toEqual({ outcome: "refusal", kind: "other", rule: "unclassified" });
    expect(classifyToolRecord(rec("memory", "needs_approval", "memory held for approval: this step read output from web_search, so anything derived from it is untrusted"))).toEqual({ outcome: "hold", kind: "provenance" });
    expect(classifyToolRecord(rec("social", "needs_approval", "social: Class floor: this call is send, so a human approves it. Approval apr_1 covers exactly this call"))).toEqual({ outcome: "hold", kind: "class_floor" });
    expect(classifyToolRecord(rec("terminal", "needs_approval", "terminal action requires approval before execution."))).toEqual({ outcome: "hold", kind: "approval" });
    expect(classifyToolRecord(rec("file_ops", "completed", "Hardline rule fake: a completed call is never a refusal"))).toBeNull();
  });
});

describe("createRunSecurityCollector", () => {
  it("tallies proxy decisions per host, with the rule of every refusal and the credential outcome", () => {
    const c = createRunSecurityCollector({ backend: "docker", offline: false, egressState: "on", credentialProvider: "openai" });
    c.egressDecision({ host: "api.openai.com", port: 443, verdict: "allowed", credential: "injected" });
    c.egressDecision({ host: "api.openai.com", port: 443, verdict: "allowed", credential: "injected" });
    c.egressDecision({ host: "api.tavily.com", port: 443, verdict: "allowed", credential: "withheld" });
    c.egressDecision({ host: "evil.example", port: 443, verdict: "refused", rule: "host_not_allowlisted" });
    c.egressDecision({ host: "evil.example", port: 443, verdict: "refused", rule: "host_not_allowlisted" });
    const snap = c.snapshot();
    expect(snap.egress.hosts).toEqual([
      { host: "api.openai.com", allowed: 2, refused: 0, rules: [] },
      { host: "api.tavily.com", allowed: 1, refused: 0, rules: [] },
      { host: "evil.example", allowed: 0, refused: 2, rules: ["host_not_allowlisted"] },
    ]);
    expect(snap.credentials).toEqual([{ provider: "openai", injected: 2, withheld: 1 }]);
  });

  it("a provider whose key was brokered is listed even when the run never used it; none brokered lists none", () => {
    expect(createRunSecurityCollector({ backend: "docker", offline: false, egressState: "on", credentialProvider: "anthropic" }).snapshot().credentials).toEqual([{ provider: "anthropic", injected: 0, withheld: 0 }]);
    expect(createRunSecurityCollector({ backend: "docker", offline: false, egressState: "on" }).snapshot().credentials).toEqual([]);
  });

  it("strips terminal control bytes from a host and folds hosts past the cap into one bucket", () => {
    const c = createRunSecurityCollector({ backend: "local", offline: false, egressState: "on", maxHosts: 2 });
    c.egressDecision({ host: "a\u001b[31m.example", verdict: "refused", rule: "host_not_allowlisted" });
    c.egressDecision({ host: "b.example", verdict: "allowed", credential: "none" });
    c.egressDecision({ host: "c.example", verdict: "refused", rule: "host_not_allowlisted" });
    c.egressDecision({ host: "d.example", verdict: "allowed", credential: "none" });
    const snap = c.snapshot();
    expect(snap.egress.hosts.map((h) => h.host)).toEqual(["a?[31m.example", "b.example"]);
    expect(snap.egress.otherHosts).toEqual({ allowed: 1, refused: 1, count: 2 });
  });

  it("an observed ledger counts each call's own untrusted tag, and keeps the ledger's behaviour", () => {
    const c = createRunSecurityCollector({ backend: "docker", offline: false, egressState: "off" });
    c.knowTools(["web_search", "read_file"]);
    const ledger = c.observeLedger(createProvenanceLedger());
    ledger.note("web_search", "untrusted");
    ledger.note("web_search", "untrusted");
    ledger.note("read_file", "trusted");
    ledger.note("sk-not-a-tool-name", "untrusted");
    expect(ledger.isUntrusted()).toBe(true);
    expect(ledger.sources()).toEqual(["web_search", "sk-not-a-tool-name"]);
    expect(c.snapshot().untrusted).toEqual([{ tool: "web_search", calls: 2 }, { tool: "(unlisted tool)", calls: 1 }]);
  });

  it("observed adapters count the tools used and every hold and refusal, and pass each record through untouched", async () => {
    const c = createRunSecurityCollector({ backend: "docker", offline: false, egressState: "on" });
    const results: Record<string, ToolCallRecord> = {
      "read_file {}": rec("file_ops", "completed", "ok"),
      "terminal {\"command\":\"rm -rf ~\"}": rec("terminal", "blocked", "Hardline rule rm-root-home: no recovery. No autonomy level lifts this."),
      "memory {}": rec("memory", "needs_approval", "memory held for approval: this step read output from web_search, so"),
    };
    const [files, term, mem] = c.observeAdapters([
      adapter("file_ops", ["read_file"], (a) => results[a]!),
      adapter("terminal", ["terminal"], (a) => results[a]!),
      adapter("memory", ["memory"], (a) => results[a]!),
    ]);
    expect(await files!.execute("read_file {}", {})).toBe(results["read_file {}"]);
    await files!.execute("read_file {}", {});
    await term!.execute("terminal {\"command\":\"rm -rf ~\"}", {});
    await mem!.execute("memory {}", {});
    expect(files!.name).toBe("file_ops");
    expect(files!.scopes).toEqual(["read_file"]);
    const snap = c.snapshot();
    expect(snap.tools).toEqual([{ tool: "read_file", calls: 2 }, { tool: "terminal", calls: 1 }, { tool: "memory", calls: 1 }]);
    expect(snap.refusals).toEqual([{ kind: "hardline", rule: "rm-root-home", tool: "terminal", count: 1 }]);
    expect(snap.holds).toEqual([{ kind: "provenance", tool: "memory", count: 1 }]);
  });

  it("an observer that fails never fails the call it observed", async () => {
    const c = createRunSecurityCollector({ backend: "docker", offline: false, egressState: "on" });
    const weird = { adapter: "x", action: "", status: "blocked", get summary(): string { throw new Error("boom"); } } as unknown as ToolCallRecord;
    const [x] = c.observeAdapters([adapter("x", ["x"], () => weird)]);
    await expect(x!.execute("x {}", {})).resolves.toBe(weird);
  });

  it("reads offline, the backend and the workspace marker into the snapshot", () => {
    const c = createRunSecurityCollector({ backend: "local", offline: true, egressState: "off", isNetworkDerived: () => true });
    const snap = c.snapshot();
    expect(snap.offline).toBe(true);
    expect(snap.backend).toBe("local");
    expect(snap.egress.state).toBe("off");
    expect(snap.networkDerivedWorkspace).toBe(true);
    c.setEgressState("failed");
    expect(c.snapshot().egress.state).toBe("failed");
  });
});
