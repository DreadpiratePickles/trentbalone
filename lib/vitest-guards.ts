import { describe } from "vitest";

/** True when vitest connected to TEST_DATABASE_URL at startup (see vitest.config.ts). */
export function isVitestDbConfigured(): boolean {
  return process.env.VITEST_DB_AVAILABLE === "1";
}

/** Skip suites that require a real Postgres test database. */
export const describeIfDb = isVitestDbConfigured() ? describe : describe.skip;

/** Skip suites that require REDIS_URL (live BullMQ integration). */
export const describeIfRedis = process.env.REDIS_URL?.trim()
  ? describe
  : describe.skip;
