import { afterEach, beforeEach } from "vitest";

beforeEach(async () => {
  // Skip DB reset for unit tests that don't need a real database.
  // Set VITEST_SKIP_DB_RESET=1 to skip (e.g. in network-disabled CI envs).
  if (
    process.env.VITEST_SKIP_DB_RESET === "1" ||
    process.env.VITEST_DB_AVAILABLE !== "1"
  ) {
    return;
  }

  // Lazy import so PrismaClient is never instantiated for unit-only runs.
  const { db } = await import("./lib/db");
  if (
    typeof db.$queryRawUnsafe !== "function" ||
    typeof db.$executeRawUnsafe !== "function"
  ) {
    return;
  }

  // Discover every table in the public schema (skip Prisma's migration table),
  // then TRUNCATE them all in one statement. CASCADE resolves FK order and
  // RESTART IDENTITY resets sequences, so each test starts from a clean slate.
  const rows = await db.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations';`
  );

  if (rows.length === 0) return;

  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
});

afterEach(async () => {
  // Clear cross-test caches best-effort. A test file may `vi.mock` one of these
  // modules without re-exporting its cache-clear function; under vitest 3.2+
  // accessing that missing export throws ("No X export is defined on the mock").
  // Each clear is therefore isolated in try/catch — a mocked module has no real
  // cache to clear, so skipping it is correct, and one partial mock must not fail
  // every test's teardown.
  const clears: Array<[() => Promise<Record<string, unknown>>, string]> = [
    [() => import("./lib/orchestrator-cache"), "clearOrchestrationRunCache"],
    [() => import("./lib/agent-runtime"), "clearAgentRuntimeCache"],
    [() => import("./lib/model-gateway"), "clearModelGatewayCache"],
    [() => import("./lib/semantic-router"), "resetSemanticRouterForTests"],
    [() => import("./lib/runtime-eval-overrides"), "clearRuntimeEvalOverrides"],
  ];

  for (const [load, exportName] of clears) {
    try {
      const mod = await load();
      const fn = mod[exportName];
      if (typeof fn === "function") (fn as () => void)();
    } catch {
      // Module is mocked in this test without the cache-clear export — nothing to clear.
    }
  }
});
