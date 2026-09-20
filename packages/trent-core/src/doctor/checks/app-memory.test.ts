/**
 * [C1] The doctor line for the app's company memory: used and durable, or not used — with the one
 * reason every reader and writer skips it (`fleet-memory/app-store.ts`).
 */
import { describe, expect, it } from "vitest";

import { describeAppStore } from "../../fleet-memory/app-store.js";
import { checkAppMemory, describeAppMemory } from "./app-memory.js";

describe("describeAppMemory", () => {
  it("says the tiers are used and durable when a real database answered", () => {
    const result = describeAppMemory({ appStore: describeAppStore({ DATABASE_URL: "postgresql://localhost/trent" }), probe: { ok: true } });
    expect(result.status).toBe("ok");
    expect(result.message).toContain("durable");
    expect(result.details).toMatchObject({ used: true, reachable: true, store: "server", durable: true });
  });

  it("says the tiers are not used when there is no database at all, and why", () => {
    const result = describeAppMemory({ appStore: describeAppStore({}), probe: undefined });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("not used");
    expect(result.message).toContain("in-process");
    expect(result.fixHint).toContain("postgres");
    expect(result.details).toMatchObject({ used: false, reachable: false, store: "memory", durable: false });
  });

  it("names the mismatch for the standalone durable profile's file: URL, and never the path", () => {
    const result = describeAppMemory({ appStore: describeAppStore({ DATABASE_URL: "file:/Users/x/.trent/default/trent.db" }), probe: undefined });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("SQLite");
    expect(result.message).toContain("postgresql");
    expect(result.message).not.toContain("/Users/x");
    expect(result.details).toMatchObject({ used: false, reachable: false, store: "sqlite" });
  });

  it("reports a configured database that did not answer with the store's own error", () => {
    const result = describeAppMemory({
      appStore: describeAppStore({ DATABASE_URL: "postgresql://db.internal/trent" }),
      probe: { ok: false, error: "Can't reach database server at `db.internal:5432`" },
    });
    expect(result.status).toBe("warn");
    expect(result.message).toContain("db.internal:5432");
    expect(result.details).toMatchObject({ used: true, reachable: false, store: "server", durable: false });
  });

  it("is a check of its own category, with a stable id", () => {
    expect(checkAppMemory.category).toBe("Company Memory");
    expect(checkAppMemory.id).toBe("check_app_memory");
  });
});
