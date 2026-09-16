import { describe, it, expect } from "vitest";
import { migrateConfigObject, readSchemaVersion } from "./migrate.js";
import { CONFIG_SCHEMA_VERSION, TrentConfigSchema } from "./schema.js";

describe("migrateConfigObject", () => {
  it("v2 -> v3: terminal.backend ssh collapses to docker and says so", () => {
    const { value, result } = migrateConfigObject({
      version: 2,
      terminal: { backend: "ssh", ssh: { host: "build.example.internal" } },
    });

    expect(readSchemaVersion(value)).toBe(3);
    expect((value.terminal as { backend: string }).backend).toBe("docker");
    expect(result.migrated).toBe(true);
    expect(result.from).toBe(2);
    expect(result.notes.some((n) => n.includes("ssh") && n.includes("docker"))).toBe(true);
    expect(TrentConfigSchema.safeParse(value).success).toBe(true);
  });

  it("v2 -> v3: terminal.backend e2b collapses to docker", () => {
    const { value, result } = migrateConfigObject({ version: 2, terminal: { backend: "e2b" } });
    expect((value.terminal as { backend: string }).backend).toBe("docker");
    expect(result.notes.some((n) => n.includes("e2b") && n.includes("docker"))).toBe(true);
  });

  it("v2 -> v3: a local backend is left alone and no warning is written", () => {
    const { value, result } = migrateConfigObject({ version: 2, terminal: { backend: "local" } });
    expect((value.terminal as { backend: string }).backend).toBe("local");
    expect(readSchemaVersion(value)).toBe(CONFIG_SCHEMA_VERSION);
    expect(result.notes).toEqual([]);
  });

  it("v1 -> v3 runs both steps in order", () => {
    const { value, result } = migrateConfigObject({
      version: "1.0.0",
      budget: { daily_cap: 10.0, per_run_cap: 1.0 },
      terminal: { backend: "e2b" },
    });
    expect(result.from).toBe(1);
    expect(result.to).toBe(CONFIG_SCHEMA_VERSION);
    expect((value.budget as { daily_cap: number }).daily_cap).toBe(1000);
    expect((value.terminal as { backend: string }).backend).toBe("docker");
    expect(result.notes).toHaveLength(2);
  });
});
