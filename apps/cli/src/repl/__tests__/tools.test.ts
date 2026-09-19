/**
 * The toolsets and the egress proxy, wired into the REPL (repl/tools.ts).
 *
 * Unit level: `wireTools` builds the adapters for `config.toolsets - config.disabled_toolsets`,
 * starts the proxy when egress is enabled and hands its URL/token/CA to the tools, degrades to
 * "no network" — never to an open network — when the proxy fails, and `/tools` lists the REAL
 * adapters (state mutation changes the output). No Docker is needed here: the backend is local.
 */

import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTheme } from "../../ui/index.js";
import { DEFAULT_CONFIG } from "@trent/core/config/index.js";
import type { TrentConfig } from "@trent/core/config/index.js";
import { ALWAYS_ON_ADAPTERS, buildTrentToolAdapters, TOOL_BRIDGE_ADAPTER_NAME, type ToolBuildDeps } from "@trent/core/tools/index.js";
import { runCommand } from "../commands.js";
import { BudgetLedger } from "../budget.js";
import { ApprovalGate } from "../approvals.js";
import { TranscriptRenderer } from "../render.js";
import type { ReplContext } from "../types.js";
import { wireTools, toolsStatusLine, type ToolWiring, type ToolWiringDeps } from "../tools.js";
import { MemoryStore } from "./harness.js";

let profileDir = "";
let workspace = "";
beforeAll(() => {
  profileDir = mkdtempSync(path.join(os.tmpdir(), "trent-tools-profile-"));
  workspace = mkdtempSync(path.join(os.tmpdir(), "trent-tools-ws-"));
});
afterAll(() => {
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

function localConfig(patch: Partial<TrentConfig> = {}): TrentConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.terminal.backend = "local";
  return { ...config, ...patch };
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function contextFor(wiring: ToolWiring, config: TrentConfig): ReplContext {
  const store = new MemoryStore();
  return {
    theme: createTheme("none"),
    config,
    store,
    companyId: "cmp_tools",
    traces: { query: async () => [], byRun: async () => [] },
    budget: new BudgetLedger({ capCents: 1000, thresholds: [50] }),
    approvals: new ApprovalGate(store, "cmp_tools"),
    degraded: false,
    tools: wiring.adapters,
    sandbox: wiring.sandbox,
    egress: wiring.egress,
  };
}

describe("wireTools builds the adapters the config asks for", () => {
  it("toolsets minus disabled_toolsets, through the injected factory, with the launch directory as the workspace", async () => {
    const seen: Array<{ toolsets: string[]; deps: ToolBuildDeps }> = [];
    const build: typeof buildTrentToolAdapters = (config, deps) => {
      seen.push({ toolsets: [...(config.toolsets ?? [])], deps });
      return buildTrentToolAdapters(config, deps);
    };
    const config = localConfig({ toolsets: ["file_ops", "terminal"], disabled_toolsets: ["terminal"], egress: { ...DEFAULT_CONFIG.egress, enabled: false } });
    const wiring = await wireTools({ config, workspace, profileDir, buildAdapters: build });
    try {
      // A3: todo, clarify and session_search are registered on every build whatever `toolsets`
      // says; the bridges are not, because one core toolset is far under `tools.disclosure_threshold`.
      expect(wiring.adapters.map((a) => a.name)).toEqual(["file_ops", ...ALWAYS_ON_ADAPTERS]);
      expect(wiring.adapters.map((a) => a.name)).not.toContain(TOOL_BRIDGE_ADAPTER_NAME);
      expect(wiring.adapters.flatMap((a) => a.scopes)).toEqual(expect.arrayContaining(["read_file", "todo", "clarify", "session_search"]));
      expect(wiring.toolsets).toEqual(["file_ops"]);
      expect(seen[0]?.deps.workspace).toBe(workspace);
      expect(seen[0]?.deps.profileDir).toBe(profileDir);
      expect(seen[0]?.deps.workspace).not.toBe(os.homedir());
    } finally {
      await wiring.cleanup();
    }
  });
});

describe("the egress proxy", () => {
  it("is listening on a free loopback port before the first turn and is handed to the tools; cleanup stops it", async () => {
    const seen: ToolBuildDeps[] = [];
    const build: typeof buildTrentToolAdapters = (config, deps) => {
      seen.push(deps);
      return buildTrentToolAdapters(config, deps);
    };
    const config = localConfig();
    expect(config.egress.enabled).toBe(true); // ON by default: the deliberate advantage over Hermes
    const wiring = await wireTools({ config, workspace, profileDir, buildAdapters: build });

    expect(wiring.egress.state).toBe("on");
    const port = wiring.egress.port!;
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(config.egress.proxy_port); // a free port, not the daemon's configured one
    expect(await portOpen(port)).toBe(true);

    const egress = seen[0]?.egress;
    expect(egress?.proxyUrl).toBe(`http://127.0.0.1:${port}`);
    expect(egress?.token).toMatch(/^trnt_egress_/);
    expect(egress?.caCertPath).toMatch(/\.crt$|\.pem$/);

    await wiring.cleanup();
    expect(await portOpen(port)).toBe(false);
  });

  it("disabled: no proxy starts and the terminal adapter is built with no egress (network none)", async () => {
    const startEgress = vi.fn();
    const seen: ToolBuildDeps[] = [];
    const build: typeof buildTrentToolAdapters = (config, deps) => {
      seen.push(deps);
      return buildTrentToolAdapters(config, deps);
    };
    const config = localConfig({ egress: { ...DEFAULT_CONFIG.egress, enabled: false } });
    const wiring = await wireTools({ config, workspace, profileDir, buildAdapters: build, startEgress });
    try {
      expect(startEgress).not.toHaveBeenCalled();
      expect(wiring.egress.state).toBe("off");
      expect(wiring.adapters.map((a) => a.name)).toContain("terminal");
      expect(seen[0]?.egress).toBeUndefined();
    } finally {
      await wiring.cleanup();
    }
  });

  it("failed to start: the tools run with network none and the status says so; never an open network", async () => {
    const seen: ToolBuildDeps[] = [];
    const build: typeof buildTrentToolAdapters = (config, deps) => {
      seen.push(deps);
      return buildTrentToolAdapters(config, deps);
    };
    const config = localConfig();
    const wiring = await wireTools({
      config,
      workspace,
      profileDir,
      buildAdapters: build,
      startEgress: async () => {
        throw new Error("EADDRINUSE: simulated");
      },
    });
    try {
      expect(wiring.egress.state).toBe("failed");
      expect(wiring.egress.error).toContain("EADDRINUSE");
      expect(seen[0]?.egress).toBeUndefined();
      const line = toolsStatusLine(wiring, createTheme("none"));
      expect(line).toMatch(/egress/i);
      expect(line).toMatch(/no network/i);
    } finally {
      await wiring.cleanup();
    }
  });
});

describe("wireTools registers web, skills and cron", () => {
  it("skips web with a reason when egress is off, registers skills and cron, and the status line says so", async () => {
    const config = localConfig({ toolsets: ["file_ops", "web", "skills", "cron"], egress: { ...DEFAULT_CONFIG.egress, enabled: false } });
    const wiring = await wireTools({ config, workspace, profileDir });
    try {
      // A3: plus the three always-on tools; still under the disclosure threshold, so no bridges.
      expect(wiring.adapters.map((a) => a.name)).toEqual(["file_ops", "skills", "cron", ...ALWAYS_ON_ADAPTERS]);
      expect(wiring.skipped).toEqual([{ toolset: "web", reason: expect.stringMatching(/egress/i) }]);
      const line = toolsStatusLine(wiring, createTheme("none"));
      expect(line).toMatch(/tools file_ops, skills, cron/);
      expect(line).toMatch(/skipped web \(.*egress.*\)/);
    } finally {
      await wiring.cleanup();
    }
  });

  it("hands web the host-side proxy URL, never the docker bridge alias", async () => {
    const seen: ToolBuildDeps[] = [];
    const build: typeof buildTrentToolAdapters = (config, deps) => {
      seen.push(deps);
      return buildTrentToolAdapters(config, deps);
    };
    const config = localConfig({ toolsets: ["file_ops", "web"] });
    const wiring = await wireTools({
      config,
      workspace,
      profileDir,
      buildAdapters: build,
      probeDocker: async () => ({ daemon: true, imagePresent: true }),
      startEgress: async () => ({
        port: 4321,
        url: "http://127.0.0.1:4321",
        token: "tok",
        caCertPath: path.join(profileDir, "missing-ca.pem"),
        isListening: () => true,
        stop: async () => undefined,
      }),
    });
    try {
      expect(seen[0]?.egress?.proxyUrl).toBe("http://127.0.0.1:4321");
      expect(seen[0]?.egressHostUrl).toBe("http://127.0.0.1:4321");
    } finally {
      await wiring.cleanup();
    }
    // The same wiring under docker: the sandbox sees the bridge alias, web still dials loopback.
    const dockerConfig = structuredClone(DEFAULT_CONFIG);
    dockerConfig.toolsets = ["file_ops", "web"];
    seen.length = 0;
    const docker = await wireTools({
      config: dockerConfig,
      workspace,
      profileDir,
      buildAdapters: build,
      probeDocker: async () => ({ daemon: true, imagePresent: true }),
      startEgress: async () => ({
        port: 4321,
        url: "http://127.0.0.1:4321",
        token: "tok",
        caCertPath: path.join(profileDir, "missing-ca.pem"),
        isListening: () => true,
        stop: async () => undefined,
      }),
    });
    try {
      expect(seen[0]?.egress?.proxyUrl).toBe("http://host.docker.internal:4321");
      expect(seen[0]?.egressHostUrl).toBe("http://127.0.0.1:4321");
    } finally {
      await docker.cleanup();
    }
  });
});

describe("where the proxy listens", () => {
  const handle = (port: number) => ({
    port, url: `http://127.0.0.1:${port}`, token: "tok", caCertPath: path.join(profileDir, "missing-ca.pem"),
    isListening: () => true, stop: async () => undefined,
  });
  const build: typeof buildTrentToolAdapters = (config, deps) => buildTrentToolAdapters(config, deps);

  it("on linux with the docker backend it also binds the bridge gateway; on darwin loopback only", async () => {
    const dockerConfig = structuredClone(DEFAULT_CONFIG);
    dockerConfig.toolsets = ["file_ops"];
    const probeDocker = async () => ({ daemon: true, imagePresent: true });
    const seen: Array<readonly string[] | undefined> = [];
    const startEgress: ToolWiringDeps["startEgress"] = async (input) => { seen.push(input.bindHosts); return handle(4321); };

    const linux = await wireTools({ config: dockerConfig, workspace, profileDir, buildAdapters: build, probeDocker, startEgress,
      platform: "linux", discoverBridgeGateway: async () => "172.18.0.1" });
    await linux.cleanup();
    expect(seen[0]).toEqual(["127.0.0.1", "172.18.0.1"]);

    const mac = await wireTools({ config: dockerConfig, workspace, profileDir, buildAdapters: build, probeDocker, startEgress,
      platform: "darwin", discoverBridgeGateway: async () => "172.17.0.1" });
    await mac.cleanup();
    expect(seen[1]).toEqual(["127.0.0.1"]);

    const local = await wireTools({ config: localConfig({ toolsets: ["file_ops"] }), workspace, profileDir, buildAdapters: build, startEgress,
      platform: "linux", discoverBridgeGateway: async () => "172.17.0.1" });
    await local.cleanup();
    expect(seen[2]).toEqual(["127.0.0.1"]);
  });

  it("the real proxy honours the bind list and is never bound to every interface", async () => {
    const { startEgressProxy } = await import("../tools.js");
    const started = await startEgressProxy({ bindHosts: ["127.0.0.1"] });
    try {
      expect(started.isListening()).toBe(true);
      expect(await portOpen(started.port)).toBe(true);
    } finally {
      await started.stop();
    }
    await expect(startEgressProxy({ bindHosts: ["0.0.0.0"] })).rejects.toThrow(/bind/i);
  });
});

describe("the sandbox line", () => {
  it("names the toolsets, the backend and the image, and says when the floor image is in use", async () => {
    const config = structuredClone(DEFAULT_CONFIG); // backend docker, image trent-sandbox:latest
    const wiring = await wireTools({
      config,
      workspace,
      profileDir,
      startEgress: async () => {
        throw new Error("not under test here");
      },
      probeDocker: async () => ({ daemon: true, imagePresent: false }),
    });
    try {
      expect(wiring.sandbox).toMatchObject({ backend: "docker", image: "alpine:3" });
      const line = toolsStatusLine(wiring, createTheme("none"));
      expect(line).toContain("file_ops");
      expect(line).toContain("terminal");
      expect(line).toContain("alpine:3");
      expect(line).toMatch(/floor/i);
    } finally {
      await wiring.cleanup();
    }
  });

  it("falls back to the confined local backend when Docker is unavailable, and says so", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const wiring = await wireTools({
      config,
      workspace,
      profileDir,
      startEgress: async () => {
        throw new Error("not under test here");
      },
      probeDocker: async () => ({ daemon: false, imagePresent: false }),
    });
    try {
      expect(wiring.sandbox.backend).toBe("local");
      expect(toolsStatusLine(wiring, createTheme("none"))).toMatch(/local.*docker|docker.*local/i);
    } finally {
      await wiring.cleanup();
    }
  });
});

describe("/tools lists the real adapters", () => {
  it("changes when a toolset is added to config, and shows the adapters' tool names", async () => {
    const off = { ...DEFAULT_CONFIG.egress, enabled: false };
    const one = localConfig({ toolsets: ["file_ops"], egress: off });
    const two = localConfig({ toolsets: ["file_ops", "terminal"], egress: off });
    const w1 = await wireTools({ config: one, workspace, profileDir });
    const w2 = await wireTools({ config: two, workspace, profileDir });
    try {
      const before = await runCommand("tools", [], contextFor(w1, one));
      const after = await runCommand("tools", [], contextFor(w2, two));
      expect(before).not.toBe(after);
      expect(before).toContain("file_ops");
      expect(before).toContain("read_file");
      expect(before).not.toContain("process_manage");
      expect(after).toContain("terminal");
      expect(after).toContain("process_manage");
    } finally {
      await w1.cleanup();
      await w2.cleanup();
    }
  });

  it("lists only the always-on tools when no toolset is enabled", async () => {
    const config = localConfig({ toolsets: [], egress: { ...DEFAULT_CONFIG.egress, enabled: false } });
    const wiring = await wireTools({ config, workspace, profileDir });
    try {
      // A3: the run's task list, the founder card and a read of this profile's own transcripts are
      // the wrapper's own mechanics, not capabilities a founder grants, so an empty `toolsets` no
      // longer means an empty catalog. Nothing that touches the machine is registered here.
      const listed = await runCommand("tools", [], contextFor(wiring, config));
      for (const name of ALWAYS_ON_ADAPTERS) expect(listed).toContain(name);
      expect(listed).not.toContain("file_ops");
      expect(listed).not.toContain("terminal");
      expect(listed).not.toContain(TOOL_BRIDGE_ADAPTER_NAME === "tools" ? "tool_call" : TOOL_BRIDGE_ADAPTER_NAME);
    } finally {
      await wiring.cleanup();
    }
  });
});

describe("the transcript shows tool activity", () => {
  it("renders one line per tool call carried on a step, once", () => {
    const renderer = new TranscriptRenderer({ theme: createTheme("none") });
    const step = {
      id: "s1",
      title: "Read package.json",
      agentRole: "engineer",
      toolCalls: [{ adapter: "file_ops", action: 'read_file {"path":"package.json"}', status: "completed", summary: "package.json (lines 1-3)" }],
    };
    const first = renderer.handle({ kind: "step_output", runId: "r", at: "t", step, detail: "" } as never);
    const again = renderer.handle({ kind: "step_output", runId: "r", at: "t", step, detail: "" } as never);
    expect(first.join("\n")).toMatch(/file_ops/);
    expect(first.join("\n")).toMatch(/read_file/);
    expect(again.filter((line) => line.includes("file_ops"))).toHaveLength(0);
  });
});
