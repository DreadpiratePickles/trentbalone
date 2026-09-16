/**
 * The telemetry check. Unset is a skip that says so in the line, never a pass; set is a real probe
 * of the configured OTLP endpoint under the doctor's deadline.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigManager } from "../../config/ConfigManager.js";
import { DEFAULT_CHECKS } from "../DoctorRunner.js";
import type { DoctorContext } from "../types.js";
import { checkTelemetry } from "./telemetry.js";

let tempDir: string;
let configManager: ConfigManager;

const context = (over: Partial<DoctorContext> = {}): DoctorContext => ({
  baseDir: tempDir,
  profile: "default",
  configManager,
  probeTimeoutMs: 200,
  ...over,
});

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trent-telemetry-"));
  configManager = new ConfigManager({ baseDir: tempDir });
  configManager.ensureDirs();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function configureEndpoint(endpoint: string): void {
  const config = configManager.loadConfig();
  configManager.saveConfig({ ...config, telemetry: { ...config.telemetry, otlp_endpoint: endpoint } });
}

describe("telemetry check", () => {
  it("is registered in the default check list", () => {
    expect(DEFAULT_CHECKS.map((check) => check.id)).toContain("check_telemetry");
  });

  it("reports skip, and says not configured in the line, when no endpoint is set", async () => {
    const result = await checkTelemetry.run(context({ fetchImpl: async () => { throw new Error("must not be called"); } }));
    expect(result.status).toBe("skip");
    expect(result.message).toContain("not configured");
    expect(result.message).toContain("telemetry.otlp_endpoint");
    expect(result.details).toEqual({ configured: false });
  });

  it("reports reachable when the endpoint answers the probe", async () => {
    configureEndpoint("http://127.0.0.1:4318/v1/traces");
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const result = await checkTelemetry.run(
      context({
        fetchImpl: async (url, init) => {
          calls.push({ url, method: init?.method });
          return new Response("{}", { status: 200 });
        },
      }),
    );
    expect(result.status).toBe("ok");
    expect(result.message).toContain("reachable");
    expect(result.message).toContain("http://127.0.0.1:4318/v1/traces");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(result.details).toMatchObject({ configured: true, endpoint: "http://127.0.0.1:4318/v1/traces", httpStatus: 200 });
  });

  it("a 4xx that is not a rejection of the empty batch still counts as reachable", async () => {
    configureEndpoint("http://127.0.0.1:4318/v1/traces");
    const result = await checkTelemetry.run(context({ fetchImpl: async () => new Response("", { status: 400 }) }));
    expect(result.status).toBe("ok");
    expect(result.message).toContain("reachable");
  });

  it("reports unreachable with a fix hint when the connection fails", async () => {
    configureEndpoint("http://127.0.0.1:1/v1/traces");
    const result = await checkTelemetry.run(
      context({
        fetchImpl: async () => {
          throw new TypeError("fetch failed: ECONNREFUSED");
        },
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.message).toContain("unreachable");
    expect(result.message).toContain("http://127.0.0.1:1/v1/traces");
    expect(result.fixHint).toBeTruthy();
  });

  it("reports unreachable when the probe times out", async () => {
    configureEndpoint("http://127.0.0.1:4318/v1/traces");
    const result = await checkTelemetry.run(
      context({
        probeTimeoutMs: 20,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      }),
    );
    expect(result.status).toBe("fail");
    expect(result.message).toContain("unreachable");
    expect(result.message).toContain("timed out");
  });
});
