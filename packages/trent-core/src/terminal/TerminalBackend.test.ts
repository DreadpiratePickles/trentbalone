import { describe, it, expect } from "vitest";
import { createTerminalBackend } from "./index.js";

describe("Terminal Backends", () => {
  it("should create LocalBackend and execute command", async () => {
    const backend = createTerminalBackend("local");
    expect(backend.id).toBe("local");
    expect(await backend.isAvailable()).toBe(true);

    const res = await backend.execute("echo 'trent-terminal-test'");
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("trent-terminal-test");
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should create DockerBackend and check availability", async () => {
    const backend = createTerminalBackend("docker");
    expect(backend.id).toBe("docker");
    const available = await backend.isAvailable();
    expect(typeof available).toBe("boolean");
  });
});
