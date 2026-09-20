/**
 * [C1] Can a seat reach the company's own tiered memory, and does what it writes there survive?
 *
 * Three outcomes, and the difference between them is not cosmetic. `apps/web/lib/store.ts:11`
 * selects the Prisma store whenever `DATABASE_URL` is set, and `apps/web/lib/db.ts` builds that
 * client for a POSTGRESQL datasource:
 *
 *   unset            the in-process store answers, so the tiers work and are lost at exit;
 *   postgres URL     the real database answers, so the tiers work and persist;
 *   `file:` SQLite   the postgres client refuses the URL, so every call throws — and that is
 *                    exactly what the standalone DURABLE profile sets (`headless.ts:282`).
 *
 * With a database configured the line is measured: the probe asks the app's own store for one
 * company's documents and reports what came back. With none configured the app's store is NOT
 * loaded, and the in-process case is read straight off `store.ts:11`. That is not laziness: every
 * module exporting the app's store, `mem-store` included, evaluates `db.ts:8` `new PrismaClient()`,
 * whose engine constructor starts loading the postgres query-engine library as a promise nothing
 * awaits. A query would await it and catch the failure, but with no `DATABASE_URL` no query ever
 * reaches that client, and on any machine except the one that built the binary the engine is not
 * found: the promise rejects unhandled and Bun kills `trent doctor` before the report is written
 * (binary.yml's Linux RUN job, f403127, once `checkMedia` ran after this check and its `docker
 * inspect` kept the process alive long enough). `app-store-isolation.test.ts` holds the line.
 *
 * An unreachable app tier is a WARNING, not a failure — fleet recall still has the runs, the
 * skills and the playbook, and the brain still holds identity and decisions — but an operator who
 * thinks the company's facts are reaching their seats when they are not has been told something
 * false, which is the thing this check exists to prevent.
 */
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";

const CATEGORY = "Company Memory";
const NAME = "App Memory Tiers";

export type AppMemoryProbe = { ok: true } | { ok: false; error: string };

export interface AppMemoryFacts {
  /** `process.env.DATABASE_URL` as the app's store singleton read it. Values never leave here. */
  readonly databaseUrl: string | undefined;
  readonly probe: AppMemoryProbe;
}

function isFileUrl(databaseUrl: string | undefined): boolean {
  return databaseUrl !== undefined && /^file:/i.test(databaseUrl.trim());
}

/** The line, from the two facts. Pure, so every branch is provable without a database. */
export function describeAppMemory(facts: AppMemoryFacts): CheckResult {
  const base = { category: CATEGORY, name: NAME };
  const kind = facts.databaseUrl === undefined ? "none" : isFileUrl(facts.databaseUrl) ? "sqlite" : "server";

  if (!facts.probe.ok) {
    const sqlite = kind === "sqlite";
    return {
      ...base,
      status: "warn",
      message: sqlite
        ? "The app's company memory is unreachable: this profile points DATABASE_URL at a SQLite file and the app's Prisma client is built for postgresql, " +
          "so the tiers, the documents, the capability outcomes, the registries, the decision journal and the wiki reach no seat. " +
          "Fleet recall still has the runs, the skills and the playbook."
        : `The app's company memory did not answer, so its tiers reach no seat: ${facts.probe.error}`,
      fixHint: sqlite
        ? "Point DATABASE_URL at a postgres database to share the company's own memory with every seat, or accept run-derived recall only; the wrapper degrades rather than failing."
        : "Re-run `trent doctor` once the database is reachable; recall falls back to the run-derived candidates meanwhile.",
      details: { reachable: false, store: kind, durable: false },
    };
  }

  if (kind === "none") {
    return {
      ...base,
      status: "warn",
      message:
        "The app's company memory is reachable but ephemeral: with no DATABASE_URL the app store is in-process, so every tier row a seat writes is gone when this process exits.",
      fixHint: "Set DATABASE_URL to a postgres database to keep the company's episodic notes and semantic facts across sessions.",
      details: { reachable: true, store: "memory", durable: false },
    };
  }

  return {
    ...base,
    status: "ok",
    message:
      "The app's company memory is reachable and durable: the tiers, the company documents, capability outcomes, seat registries, the decision journal and the wiki are all recall candidates, and what a seat writes survives the session.",
    details: { reachable: true, store: kind, durable: true },
  };
}

/** One document read against the app's own store singleton. Reads nothing else, writes nothing. */
async function probeAppStore(companyId: string): Promise<AppMemoryProbe> {
  try {
    const { store } = (await import("@/lib/store")) as unknown as {
      store: { listDocuments(companyId: string): Promise<unknown[]> };
    };
    await store.listDocuments(companyId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export const checkAppMemory: DoctorCheck = {
  id: "check_app_memory",
  name: NAME,
  category: CATEGORY,
  async run(ctx: DoctorContext): Promise<CheckResult> {
    // The same truthiness test as `store.ts:11`: unset and "" both mean the in-process store.
    const databaseUrl = process.env.DATABASE_URL || undefined;
    if (databaseUrl === undefined) {
      // The in-process store has no failure mode to measure, and loading it constructs the app's
      // Prisma client, which must not happen on a profile that will never query it (see above).
      return describeAppMemory({ databaseUrl, probe: { ok: true } });
    }
    const configured = (ctx.configManager.loadConfig() as { company?: { id?: string } }).company?.id;
    const probe = await probeAppStore(configured === undefined ? "co_doctor_probe" : String(configured));
    return describeAppMemory({ databaseUrl, probe });
  },
};
