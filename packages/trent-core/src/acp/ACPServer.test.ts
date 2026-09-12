import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager } from "../config/ConfigManager.js";
import { ACPServer } from "./ACPServer.js";

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
});
