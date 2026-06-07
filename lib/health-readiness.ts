export type HealthReadiness = {
  ok: boolean;
  llm: boolean;
  db: "memory" | "postgres";
  redis: boolean;
};

/** Config readiness flags — booleans only, never secret values. */
export function buildHealthReadiness(env: NodeJS.ProcessEnv = process.env): HealthReadiness {
  const llm = !!env.OPENAI_API_KEY?.trim();
  const db: HealthReadiness["db"] = env.DATABASE_URL?.trim() ? "postgres" : "memory";
  const redis = !!env.REDIS_URL?.trim();
  return { ok: llm, llm, db, redis };
}
