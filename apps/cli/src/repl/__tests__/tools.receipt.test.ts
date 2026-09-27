/**
 * [D16] `wireTools` attaches the run's security collector: the proxy's decision hook, the provenance
 * ledger the tool build writes to, and an observer on the returned adapters all feed it, and the
 * backend and egress state are the wiring's own. No Docker and no socket: the proxy is a recorder.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type TrentConfig } from "@trent/core/config/index.js";
import type { ToolBuildDeps, TrentToolAdapter } from "@trent/core/tools/index.js";
import { wireTools, type EgressHandle, type StartEgressInput } from "../tools.js";

let profileDir = "";
let workspace = "";
const saved = process.env.OPENAI_API_KEY;
beforeAll(() => {
  profileDir = mkdtempSync(path.join(os.tmpdir(), "trent-receipt-profile-"));
  workspace = mkdtempSync(path.join(os.tmpdir(), "trent-receipt-ws-"));
  process.env.OPENAI_API_KEY = "sk-wiring-test-value";
});
afterAll(() => {
  if (saved === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = saved;
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function config(patch: Partial<TrentConfig> = {}): TrentConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.terminal.backend = "local";
  return { ...c, provider: "openai", ...patch };
}

const handle: EgressHandle = { port: 1, url: "http://127.0.0.1:1", token: "trnt_egress_x", caCertPath: "/ca.pem", isListening: () => true, stop: async () => undefined };

function termAdapter(): TrentToolAdapter {
  return {
    name: "terminal",
    scopes: ["terminal"],
    instructions: "",
    routingText: "",
    healthCheck: async () => "connected",
    estimateCost: () => 0,
    requiresApproval: () => false,
    execute: async (action) => ({ adapter: "terminal", action, status: "blocked", summary: "Hardline rule rm-root-home: no recovery. No autonomy level lifts this." }),
    cleanup: async () => undefined,
  };
}

describe("wireTools — the security collector", () => {
  it("feeds the collector from the proxy hook, the build's ledger and the returned adapters", async () => {
    const seen: StartEgressInput[] = [];
    let buildDeps: ToolBuildDeps | undefined;
    const wiring = await wireTools({
      config: config({ toolsets: ["terminal"] }),
      workspace,
      profileDir,
      startEgress: async (input) => { seen.push(input); return handle; },
      buildAdapters: (_c, deps) => { buildDeps = deps; return [termAdapter()]; },
    });
    try {
      expect(wiring.security).toBeDefined();
      seen[0]!.onDecision!({ host: "api.openai.com", port: 443, verdict: "allowed", credential: "injected" });
      buildDeps!.provenance!.note("terminal", "untrusted");
      await wiring.adapters[0]!.execute('terminal {"command":"rm -rf ~"}', {});
      const snap = wiring.security!.snapshot();
      expect(snap.backend).toBe("local");
      expect(snap.egress.state).toBe("on");
      expect(snap.egress.hosts).toEqual([{ host: "api.openai.com", allowed: 1, refused: 0, rules: [] }]);
      expect(snap.credentials).toEqual([{ provider: "openai", injected: 1, withheld: 0 }]);
      expect(snap.untrusted).toEqual([{ tool: "terminal", calls: 1 }]);
      expect(snap.refusals).toEqual([{ kind: "hardline", rule: "rm-root-home", tool: "terminal", count: 1 }]);
      expect(snap.tools).toEqual([{ tool: "terminal", calls: 1 }]);
    } finally {
      await wiring.cleanup();
    }
  });

  it("with egress off, the receipt says off and no provider is listed as brokered", async () => {
    const wiring = await wireTools({ config: config({ toolsets: [], egress: { ...DEFAULT_CONFIG.egress, enabled: false } }), workspace, profileDir, buildAdapters: () => [] });
    try {
      const snap = wiring.security!.snapshot();
      expect(snap.egress.state).toBe("off");
      expect(snap.credentials).toEqual([]);
    } finally {
      await wiring.cleanup();
    }
  });

  it("a proxy that failed to start is recorded as failed", async () => {
    const wiring = await wireTools({
      config: config({ toolsets: [] }),
      workspace,
      profileDir,
      buildAdapters: () => [],
      startEgress: async () => { throw new Error("port in use"); },
    });
    try {
      expect(wiring.security!.snapshot().egress.state).toBe("failed");
      expect(wiring.security!.snapshot().credentials).toEqual([]);
    } finally {
      await wiring.cleanup();
    }
  });
});
