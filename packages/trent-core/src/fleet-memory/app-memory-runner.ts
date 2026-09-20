/**
 * [C1] Bun entrypoint for the app-memory acceptance scenarios. Run as:
 *   bun packages/trent-core/src/fleet-memory/app-memory-runner.ts <scenario> <sqlite-file>
 * Prints one JSON object on stdout; exits 1 with the error on stderr.
 *
 * It lives here, not inside a vitest file, for the reason `store/scenario-runner.ts` does: the
 * scenarios must run under the runtime the shipped binary uses, and `applyStandaloneEnv` has to be
 * the first thing a PROCESS does — `apps/web/lib/store.ts` picks its store at module evaluation,
 * so one process can only ever be in one of the two modes these scenarios compare.
 *
 * The propagation scenario answers the store predicate (`app-store.ts`) with a stand-in postgres
 * URL so the REAL app modules are exercised against the app's in-process store, the store the
 * app's own tests use; the process's actual `DATABASE_URL` stays unset, which is what makes that
 * store in-process. The sqlite scenario is the standalone durable profile as an operator's shell
 * may still export it, and proves the predicate keeps the app's store out of the module registry.
 */

import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { IN_MEMORY_DATABASE, applyStandaloneEnv } from "../runtime/env.js";

export interface PropagationResult {
  /** Seat growth's own prompt in run 1, before it wrote anything. */
  readonly run1Growth: string;
  /** Seat sales' prompt in run 2: what seat growth learned in run 1 has to be in here. */
  readonly run2Sales: string;
  readonly episodeWrite: { status: string; summary: string };
  readonly factWrites: ReadonlyArray<{ written: number; expired: number; reason: string | null }>;
  readonly appEntrySources: readonly string[];
}

export interface SqliteProfileResult {
  readonly entries: number;
  /** `null`: the write reported nothing to do and no failure — the skip is deliberate. */
  readonly writeReason: string | null;
  /** The loader's refusal, before any import. */
  readonly loaderRefusal: string;
  /** Whether `apps/web/lib/store.ts` reached Bun's module registry at all. */
  readonly appStoreLoaded: boolean;
}

/** Answers the predicate "usable" while the process itself has no `DATABASE_URL`. */
const STAND_IN = { DATABASE_URL: "postgresql://stand-in.invalid/exercise-the-real-modules" } as const;

async function runPropagation(): Promise<PropagationResult> {
  applyStandaloneEnv(IN_MEMORY_DATABASE);

  const { store } = (await import("@/lib/store")) as unknown as {
    store: { createCompany(input: { name: string; slug: string; budgetCents: number }): Promise<{ id: string }> };
  };
  const company = await store.createCompany({ name: "C1 Propagation", slug: `c1-prop-${Date.now()}`, budgetCents: 500 });

  const { createMemoryAdapter } = await import("../tools/memory/index.js");
  const { createAppFleetSource } = await import("./app-source.js");
  const { createAppMemoryReader, loadAppMemoryModules } = await import("./app-tiers.js");
  const { loadAppWriteModules, withAppEpisodicMirror, writeConsolidatedFacts } = await import("./app-writes.js");
  const { createFleetMemoryHook } = await import("./orchestrator-hook.js");

  const profileDir = mkdtempSync(path.join(tmpdir(), "trent-c1-"));
  const writeModules = await loadAppWriteModules(STAND_IN);
  let caller = { companyId: company.id, runId: "run_1", seat: "growth" };
  // [G2] The mirror holds a seat's append for the step that made it; this append is made between
  // steps, with no step in the caller, so it is written at once — the same path a surface takes
  // when nothing is running.
  const mirror = withAppEpisodicMirror(createMemoryAdapter({ profileDir }), {
    modules: writeModules,
    caller: () => caller,
  });
  const hook = createFleetMemoryHook({ source: createAppFleetSource({ env: STAND_IN }), memory: mirror.adapter, brain: false });

  const objective = "raise activation with an onboarding email";
  /** The fake model: it never calls a provider, it just keeps the prompt the wrapper handed it. */
  const prompts: Record<string, string> = {};
  const seatModel = hook.wrapSeatModel(async (input: { subtask: { seat: string }; dynamicPrompt?: string }) => {
    prompts[input.subtask.seat] = input.dynamicPrompt ?? "";
    return input.subtask.seat;
  });

  hook.runStarted({ runId: "run_1", companyId: company.id, objective });
  await seatModel({ companyId: company.id, subtask: { id: "step_1", seat: "growth", objective }, dynamicPrompt: "" });
  const run1Growth = prompts.growth ?? "";
  const episodeWrite = await mirror.adapter.execute(
    'memory {"action":"add","content":"the onboarding email doubled signup completion for new founders"}',
    {},
  );
  hook.runFinished("run_1");

  // Facts are the consolidation's to write, never the seat's: an append, then a replace that
  // supersedes it. The superseded fact must not reach run 2.
  const factWrites = [
    await writeConsolidatedFacts({
      companyId: company.id,
      block: "COMPANY.md",
      entries: [],
      ops: [{ op: "append", text: "activation stands at 40 percent" }],
      modules: writeModules,
    }),
    await writeConsolidatedFacts({
      companyId: company.id,
      block: "COMPANY.md",
      entries: ["activation stands at 40 percent"],
      ops: [{ op: "replace", entry_id: "e1", text: "activation stands at 55 percent" }],
      modules: writeModules,
    }),
  ];

  caller = { companyId: company.id, runId: "run_2", seat: "sales" };
  hook.runStarted({ runId: "run_2", companyId: company.id, objective });
  await seatModel({ companyId: company.id, subtask: { id: "step_2", seat: "sales", objective }, dynamicPrompt: "" });
  const run2Sales = prompts.sales ?? "";
  hook.runFinished("run_2");

  const read = createAppMemoryReader({ modules: () => loadAppMemoryModules(STAND_IN) });
  const appEntrySources = [...new Set((await read(company.id, "sales")).map((entry) => entry.source))].sort();

  return {
    run1Growth,
    run2Sales,
    episodeWrite: { status: episodeWrite.status, summary: episodeWrite.summary },
    factWrites,
    appEntrySources,
  };
}

/**
 * Watches Bun's module loader for the app's store and db modules. Registered before the scenario
 * imports anything, so a load from anywhere in the graph — static or dynamic — is seen; Bun does
 * not expose the loader's registry itself, and a plugin's `onLoad` is the one observation point.
 */
async function watchAppStoreLoads(): Promise<() => boolean> {
  // A variable specifier: this package type-checks without Bun's types, and only ever runs here under Bun.
  const specifier = "bun";
  const { plugin } = (await import(specifier)) as { plugin: (definition: BunPlugin) => void };
  const seen: string[] = [];
  plugin({
    name: "trent-watch-app-store",
    setup(build) {
      build.onLoad({ filter: /apps\/web\/lib\/(store|db)\.ts$/ }, async (args) => {
        seen.push(args.path);
        return { contents: await readFile(args.path, "utf8"), loader: "ts" };
      });
    },
  });
  return () => seen.length > 0;
}

/** The sliver of Bun's plugin API the watcher uses. */
interface BunPlugin {
  readonly name: string;
  setup(build: {
    onLoad(
      options: { filter: RegExp },
      callback: (args: { path: string }) => Promise<{ contents: string; loader: "ts" }>,
    ): void;
  }): void;
}

/**
 * `DATABASE_URL` is a SQLite file — what the standalone runtime used to export, and what an
 * operator's shell may still carry — while `apps/web/lib/db.ts` is a postgresql client. The
 * predicate answers from the URL alone: the reader recalls nothing, the writer reports nothing to
 * do and no failure, the loader refuses with the reason, and the app's store never enters the
 * module registry, so the client whose engine is not shipped is never constructed.
 */
async function runSqliteProfile(file: string): Promise<SqliteProfileResult> {
  const appStoreLoaded = await watchAppStoreLoads();
  applyStandaloneEnv(`file:${file}`);
  const { createAppMemoryReader } = await import("./app-tiers.js");
  const { loadAppWriteModules, writeSeatEpisode } = await import("./app-writes.js");
  const entries = await createAppMemoryReader()("co_missing", "growth");
  let loaderRefusal = "";
  let modules;
  try {
    modules = await loadAppWriteModules();
  } catch (error) {
    loaderRefusal = error instanceof Error ? error.message : String(error);
  }
  const outcome = await writeSeatEpisode({
    companyId: "co_missing",
    runId: "run_1",
    seat: "growth",
    text: "a fact the app store cannot take",
    modules: modules ?? {
      async writeEpisodicMemory() {
        // The CLI wiring loads the writers lazily on the first append; the refusal surfaces here.
        await loadAppWriteModules();
      },
      createSemanticMemory() {
        throw new Error("unreachable");
      },
      async listDocuments() {
        return [];
      },
      async expireDocument() {},
    },
  });
  return { entries: entries.length, writeReason: outcome.reason, loaderRefusal, appStoreLoaded: appStoreLoaded() };
}

const SCENARIOS: Record<string, (file: string) => Promise<unknown>> = {
  propagation: runPropagation,
  sqlite: runSqliteProfile,
};

async function main(): Promise<void> {
  const [name, file] = process.argv.slice(2);
  const scenario = name === undefined ? undefined : SCENARIOS[name];
  if (scenario === undefined || file === undefined) {
    throw new Error(`usage: app-memory-runner <${Object.keys(SCENARIOS).join("|")}> <sqlite-file>`);
  }
  process.stdout.write(JSON.stringify(await scenario(file)));
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exit(1);
});
