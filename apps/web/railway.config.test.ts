import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("Railway deployment config", () => {
  it("does not set a root start command that overrides service-specific workers", () => {
    const config = JSON.parse(fs.readFileSync("railway.json", "utf8")) as {
      build?: { buildCommand?: string };
      deploy?: { startCommand?: string };
    };

    expect(config.build?.buildCommand).toBeUndefined();
    expect(config.deploy?.startCommand).toBeUndefined();
  });

  it("keeps the worker deployment config pointed at the BullMQ worker", () => {
    const config = JSON.parse(fs.readFileSync("railway-worker.json", "utf8")) as {
      build?: { buildCommand?: string };
      deploy?: { startCommand?: string };
    };

    expect(config.build?.buildCommand).toBe("npm run build");
    expect(config.deploy?.startCommand).toBe("npm run worker");
  });
});
