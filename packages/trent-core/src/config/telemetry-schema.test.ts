/** The `telemetry` config block: an optional OTLP endpoint and the service name traces carry. */
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./defaults.js";
import { TrentConfigSchema } from "./schema.js";
import { TelemetryConfigSchema } from "./telemetry-schema.js";

describe("telemetry config", () => {
  it("defaults to no endpoint (tracing off) and service name trent", () => {
    expect(TelemetryConfigSchema.parse({})).toEqual({ service_name: "trent" });
    expect(TrentConfigSchema.parse({}).telemetry).toEqual({ service_name: "trent" });
    expect(DEFAULT_CONFIG.telemetry).toEqual({ service_name: "trent" });
  });

  it("accepts an http(s) OTLP endpoint and rejects a non-URL", () => {
    const parsed = TrentConfigSchema.parse({ telemetry: { otlp_endpoint: "http://127.0.0.1:4318/v1/traces" } });
    expect(parsed.telemetry.otlp_endpoint).toBe("http://127.0.0.1:4318/v1/traces");
    expect(parsed.telemetry.service_name).toBe("trent");
    expect(TrentConfigSchema.safeParse({ telemetry: { otlp_endpoint: "localhost:4318" } }).success).toBe(false);
  });
});
