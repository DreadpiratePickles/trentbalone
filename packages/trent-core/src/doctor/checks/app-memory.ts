/**
 * [C1] Can a seat reach the company's own tiered memory, and does what it writes there survive?
 *
 * Two outcomes now, and the line between them is the one predicate every reader and writer
 * consults (`fleet-memory/app-store.ts`): the app's tiers are USED only when `DATABASE_URL` is the
 * app's own postgres datasource. Everything else is NOT USED, with the reason the predicate gives:
 *
 *   unset / empty    the in-process store: a tier row would not outlive the process;
 *   `file:` SQLite   the wrapper's own store format — `apps/web/lib/db.ts` builds a postgresql
 *                    client — which is what an operator's shell may still export from the days
 *                    the standalone runtime handed its SQLite URL to the app;
 *   another scheme   not the app's datasource either.
 *
 * With a postgres URL the line is measured: the probe asks the app's own store for one company's
 * documents and reports what came back. In every other state the app's store is NOT loaded, and
 * that is the point, not laziness: every module exporting the app's store, `mem-store` included,
 * evaluates `db.ts:8` `new PrismaClient()`, whose engine constructor starts loading the postgres
 * query-engine library as a promise nothing awaits. On any machine except the one that built the
 * binary the engine is not found, the promise rejects unhandled, and Bun kills the process (the
 * doctor in binary.yml's Linux RUN job, f403127; `trent run` on any fresh Linux machine). The
 * answer is known from the URL alone, so nothing is probed to give it.
 * `app-store-isolation.test.ts` holds the line for the doctor; `apps/cli/src/runtime/headless.app-store.test.ts`
 * for a run.
 *
 * An unused app tier is a WARNING, not a failure — fleet recall still has the runs, the skills and
 * the playbook, and the brain still holds identity and decisions — but an operator who thinks the
 * company's facts are reaching their seats when they are not has been told something false, which
 * is the thing this check exists to prevent.
 */
import { describeAppStore, type AppStoreState } from "../../fleet-memory/app-store.js";
import type { CheckResult, DoctorCheck, DoctorContext } from "../types.js";

const CATEGORY = "Company Memory";
const NAME = "App Memory Tiers";

export type AppMemoryProbe = { ok: true } | { ok: false; error: string };

export interface AppMemoryFacts {
  /** The predicate's answer for this process's `DATABASE_URL`. Values never leave the predicate. */
  readonly appStore: AppStoreState;
  /** The one read through the app's own store; `undefined` when the store was, correctly, not loaded. */
  readonly probe: AppMemoryProbe | undefined;
}

const FIX_HINT = "Point DATABASE_URL at a postgres database to share the company's own memory with every seat, or accept run-derived recall only; the wrapper degrades rather than failing.";

/** The line, from the two facts. Pure, so every branch is provable without a database. */
export function describeAppMemory(facts: AppMemoryFacts): CheckResult {
  const base = { category: CATEGORY, name: NAME };
  const { appStore, probe } = facts;

  if (!appStore.usable) {
    return {
      ...base,
      status: "warn",
      message:
        `The app's company memory is not used: ${appStore.reason}. ` +
        "The tiers, the documents, the capability outcomes, the registries, the decision journal and the wiki reach no seat; " +
        "fleet recall still has the runs, the skills and the playbook.",
      fixHint: FIX_HINT,
      details: { used: false, reachable: false, store: appStore.store, durable: false },
    };
  }

  if (probe === undefined || !probe.ok) {
    return {
      ...base,
      status: "warn",
      message: `The app's company memory did not answer, so its tiers reach no seat: ${probe === undefined ? "the store was not probed" : probe.error}`,
      fixHint: "Re-run `trent doctor` once the database is reachable; recall falls back to the run-derived candidates meanwhile.",
      details: { used: true, reachable: false, store: appStore.store, durable: false },
    };
  }

  return {
    ...base,
    status: "ok",
    message:
      "The app's company memory is used and durable: the tiers, the company documents, capability outcomes, seat registries, the decision journal and the wiki are all recall candidates, and what a seat writes survives the session.",
    details: { used: true, reachable: true, store: appStore.store, durable: true },
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
    const appStore = describeAppStore(process.env);
    // Not usable: the answer is known from the URL alone, and loading the app's store to confirm it
    // would construct the Prisma client this profile must never build (see above).
    if (!appStore.usable) return describeAppMemory({ appStore, probe: undefined });
    const configured = (ctx.configManager.loadConfig() as { company?: { id?: string } }).company?.id;
    const probe = await probeAppStore(configured === undefined ? "co_doctor_probe" : String(configured));
    return describeAppMemory({ appStore, probe });
  },
};
