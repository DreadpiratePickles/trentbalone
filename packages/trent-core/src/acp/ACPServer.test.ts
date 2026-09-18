/**
 * ACP: the editor handshake, and the JSON-RPC-over-HTTP adapter over `agent/chat`.
 *
 * `agent/chat` used to answer every editor request with a template string built from the prompt.
 * Its behaviour is covered by `chat.test.ts`. The transport here is provisional — the real Agent
 * Client Protocol is stdio JSON-RPC and this server speaks HTTP — so these tests stay at adapter
 * depth: the request reaches `runAgentChat`, a result comes back in a JSON-RPC envelope, and a
 * refusal comes back as a JSON-RPC error. No live model is involved on any path here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager } from "../config/ConfigManager.js";
import type { AgentRunner, AgentRunInput } from "../agent-runner/index.js";
import { NO_RUNNER_REASON } from "../agent-runner/index.js";
import type { OrcEvent } from "../orchestrator/types.js";
import { ACPServer } from "./ACPServer.js";
import { ACP_RUNNER_UNAVAILABLE } from "./chat.js";

function ev(kind: OrcEvent["kind"], extra: Partial<OrcEvent> = {}): OrcEvent {
  return { kind, runId: "run_acp", at: "2026-09-18T00:00:00.000Z", ...extra } as OrcEvent;
}

/** Records the objectives it was asked to run and replays a fixed event sequence. */
function fakeRunner(events: readonly OrcEvent[]): AgentRunner & { objectives: string[] } {
  const objectives: string[] = [];
  return {
    objectives,
    run(input: AgentRunInput) {
      objectives.push(input.objective);
      return (async function* () {
        for (const event of events) yield event;
      })();
    },
  };
}

async function rpc(port: number, method: string, params?: Record<string, unknown>): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}/acp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, ...(params === undefined ? {} : { params }) }),
  });
  return (await res.json()) as any;
}

describe("ACPServer", () => {
  let tempDir: string;
  let configManager: ConfigManager;
  let server: ACPServer;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-acp-test-"));
    configManager = new ConfigManager({ baseDir: tempDir });
    // Use an ephemeral or high port for testing
    server = new ACPServer({ port: 7899, configManager });
  });

  afterEach(async () => {
    if (server.isRunning()) {
      await server.stop();
    }
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should start and stop the ACP server cleanly", async () => {
    expect(server.isRunning()).toBe(false);
    await server.start();
    expect(server.isRunning()).toBe(true);

    const res = await fetch("http://127.0.0.1:7899/");
    const json = (await res.json()) as any;
    expect(json.acp).toBe("trent-fleet");
    expect(json.status).toBe("online");

    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it("should handle JSON-RPC initialize and fleet/status calls", async () => {
    await server.start();

    // 1. Initialize RPC
    const initRes = await fetch("http://127.0.0.1:7899/acp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      }),
    });
    const initData = (await initRes.json()) as any;
    expect(initData.result.serverInfo.name).toBe("trent-acp-server");
    expect(initData.result.capabilities.agentDispatch).toBe(true);

    // 2. Fleet status RPC
    const fleetRes = await fetch("http://127.0.0.1:7899/acp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "fleet/status",
      }),
    });
    const fleetData = (await fleetRes.json()) as any;
    expect(fleetData.result.totalCatalog).toBe(164);

    await server.stop();
  });

  it("agent/chat runs the injected runtime and returns the run's own output", async () => {
    const runner = fakeRunner([
      ev("run_start"),
      ev("consolidate_end", { run: { summary: "The failing assertion is the stale cache key in resolveSeat." } }),
      ev("run_done", { run: { status: "completed", summary: "The failing assertion is the stale cache key in resolveSeat." } }),
    ]);
    server = new ACPServer({ port: 7871, configManager, runner });
    await server.start();

    const data = await rpc(7871, "agent/chat", { agent: "engineer", prompt: "why does the seat test fail?" });
    expect(data.error).toBeUndefined();
    expect(data.result.agent).toBe("engineer");
    expect(data.result.runId).toBe("run_acp");
    expect(data.result.status).toBe("completed");
    expect(data.result.response).toBe("The failing assertion is the stale cache key in resolveSeat.");
    expect(JSON.stringify(data)).not.toContain("ACP Editor Dispatch");
    expect(runner.objectives).toEqual(["why does the seat test fail?"]);
  });

  it("agent/chat with no runtime attached refuses honestly instead of answering", async () => {
    server = new ACPServer({ port: 7873, configManager });
    await server.start();

    const data = await rpc(7873, "agent/chat", { agent: "engineer", prompt: "inspect this file" });
    expect(data.result).toBeUndefined();
    expect(data.error.code).toBe(ACP_RUNNER_UNAVAILABLE);
    expect(data.error.message).toBe(NO_RUNNER_REASON);
  });

});
