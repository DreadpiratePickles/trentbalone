import net from "node:net";

export type VitestDatabaseEnv = {
  databaseUrl: string;
  directUrl: string;
  testDatabaseUrl: string;
  testDirectUrl: string;
  productionDatabaseUrl: string;
  shouldSkipDbReset: boolean;
  dbAvailable: boolean;
};

export function isClearlyTestDatabase(databaseUrl: string) {
  try {
    const url = new URL(databaseUrl);
    return url.pathname.toLowerCase().includes("test");
  } catch {
    return databaseUrl.toLowerCase().includes("test");
  }
}

export function resolveVitestDatabaseEnv(env: Partial<NodeJS.ProcessEnv>): VitestDatabaseEnv {
  const testDatabaseUrl = env.TEST_DATABASE_URL?.trim() ?? "";
  const productionDatabaseUrl = env.DATABASE_URL?.trim() ?? "";
  const testDirectUrl = env.TEST_DIRECT_URL?.trim() || testDatabaseUrl;
  const shouldSkipDbReset =
    env.VITEST_SKIP_DB_RESET === "1" || env.VITEST_DB_AVAILABLE !== "1";

  // Never point vitest at production DATABASE_URL — only an explicit test URL.
  const databaseUrl = testDatabaseUrl;
  const directUrl = testDatabaseUrl ? testDirectUrl : "";

  return {
    databaseUrl,
    directUrl,
    testDatabaseUrl,
    testDirectUrl,
    productionDatabaseUrl,
    shouldSkipDbReset,
    dbAvailable: env.VITEST_DB_AVAILABLE === "1",
  };
}

export function assertVitestDatabaseSafety(env: VitestDatabaseEnv) {
  if (
    env.testDatabaseUrl
    && env.testDatabaseUrl === env.productionDatabaseUrl
    && !isClearlyTestDatabase(env.testDatabaseUrl)
  ) {
    throw new Error("Refusing to run tests: TEST_DATABASE_URL matches DATABASE_URL.");
  }
}

function probeTcpHost(host: string, port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

/** Returns true when Postgres accepts connections and responds to SELECT 1. */
export async function probePostgresDatabase(databaseUrl: string): Promise<boolean> {
  if (!databaseUrl) return false;

  try {
    const url = new URL(databaseUrl);
    const reachable = await probeTcpHost(url.hostname, Number(url.port || 5432));
    if (!reachable) return false;

    const { PrismaClient } = await import("@prisma/client");
    const client = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });

    try {
      await client.$queryRaw`SELECT 1`;
      return true;
    } finally {
      await client.$disconnect();
    }
  } catch {
    return false;
  }
}

export async function resolveVitestDatabaseEnvWithProbe(
  env: Partial<NodeJS.ProcessEnv>,
): Promise<VitestDatabaseEnv> {
  const base = resolveVitestDatabaseEnv(env);
  if (!base.testDatabaseUrl) {
    return { ...base, dbAvailable: false, shouldSkipDbReset: true };
  }

  const dbAvailable = await probePostgresDatabase(base.testDatabaseUrl);
  return {
    ...base,
    dbAvailable,
    shouldSkipDbReset: !dbAvailable || base.shouldSkipDbReset,
  };
}
