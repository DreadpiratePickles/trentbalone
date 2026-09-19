/**
 * [C1] The doctor line for the app's company memory: reachable and durable, reachable but
 * in-process, or unreachable because the profile is the standalone durable one.
 */
import { describe, expect, it } from "vitest";

import { checkAppMemory, describeAppMemory } from "./app-memory.js";

describe("describeAppMemory", () => {
  it("says the tiers are durable when a real database answered", () => {
    const result = describeAppMemory({ databaseUrl: "postgresql://localhost/trent", probe: { ok: true } });
    expect(result.status).toBe("ok");
    expect(result.message).toContain("durable");
  });

  it("says the tiers are ephemeral when there is no database at all", () => {
    const result = describeAppMemory({ databaseUrl: undefined, probe: { ok: true } });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("ephemeral");
  });

  it("reports the standalone durable profile as unreachable, and names the mismatch", () => {
    const result = describeAppMemory({
      databaseUrl: "file:/Users/x/.trent/default/trent.db",
      probe: { ok: false, error: "Error validating datasource `db`: the URL must start with the protocol `postgresql://`" },
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("SQLite");
    expect(result.details?.reachable).toBe(false);
  });

  it("is a check of its own category, with a stable id", () => {
    expect(checkAppMemory.category).toBe("Company Memory");
    expect(checkAppMemory.id).toBe("check_app_memory");
  });
});
