import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import {
  assertVitestDatabaseSafety,
  resolveVitestDatabaseEnvWithProbe,
} from "./lib/test-database-env";

const configDir = path.dirname(fileURLToPath(import.meta.url));
const isNestedWorktree = configDir.split(path.sep).includes(".worktrees");

try {
  process.loadEnvFile();
} catch {
  // Ignore if .env doesn't exist or isn't supported
}

export default defineConfig(async () => {
  const databaseEnv = await resolveVitestDatabaseEnvWithProbe(process.env);

  assertVitestDatabaseSafety(databaseEnv);

  if (databaseEnv.testDatabaseUrl && !databaseEnv.dbAvailable) {
    console.warn(
      `[vitest] Postgres unreachable at ${databaseEnv.testDatabaseUrl} — using in-memory store; DB-specific suites skipped.`,
    );
  }

  return {
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "."),
        "next/server": path.resolve(__dirname, "./lib/mocks/next-server.ts"),
      },
    },
    test: {
      environment: "node",
      setupFiles: ["./vitest.setup.ts"],
      testTimeout: 30_000,
      pool: "forks",
      poolOptions: {
        forks: {
          singleFork: true,
        },
      },
      exclude: [
        ...configDefaults.exclude,
        "vendor/**",
        "gbrain/**",
        ...(isNestedWorktree ? [] : [".worktrees/**"]),
      ],
      env: {
        // Override any DATABASE_URL from .env when the test DB is unavailable.
        DATABASE_URL: databaseEnv.dbAvailable ? databaseEnv.databaseUrl : "",
        DIRECT_URL: databaseEnv.dbAvailable ? databaseEnv.directUrl : "",
        TEST_DATABASE_URL: databaseEnv.testDatabaseUrl,
        TEST_DIRECT_URL: databaseEnv.testDirectUrl,
        VITEST_DB_AVAILABLE: databaseEnv.dbAvailable ? "1" : "0",
        VITEST_SKIP_DB_RESET: databaseEnv.shouldSkipDbReset ? "1" : "0",
      },
    },
  };
});
