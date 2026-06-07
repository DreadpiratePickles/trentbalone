import { describe, expect, it } from "vitest";
import { resolveVitestDatabaseEnv } from "@/lib/test-database-env";

describe("resolveVitestDatabaseEnv", () => {
  it("prefers TEST_DATABASE_URL even when DB reset is skipped", () => {
    const result = resolveVitestDatabaseEnv({
      DATABASE_URL: "postgres://prod.example/trent",
      DIRECT_URL: "postgres://prod.example/direct",
      TEST_DATABASE_URL: "postgres://test.example/trent_test",
      TEST_DIRECT_URL: "postgres://test.example/direct_test",
      VITEST_SKIP_DB_RESET: "1",
      VITEST_DB_AVAILABLE: "1",
    });

    expect(result.databaseUrl).toBe("postgres://test.example/trent_test");
    expect(result.directUrl).toBe("postgres://test.example/direct_test");
    expect(result.shouldSkipDbReset).toBe(true);
  });

  it("does not fall back to production DATABASE_URL when no test DB is configured", () => {
    const result = resolveVitestDatabaseEnv({
      DATABASE_URL: "postgres://prod.example/trent",
      DIRECT_URL: "postgres://prod.example/direct",
    });

    expect(result.databaseUrl).toBe("");
    expect(result.directUrl).toBe("");
    expect(result.shouldSkipDbReset).toBe(true);
  });
});
