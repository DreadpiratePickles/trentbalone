/**
 * [C1] Bun entrypoint for the app-memory acceptance scenarios. Run as:
 *   bun packages/trent-core/src/fleet-memory/app-memory-runner.ts <scenario> <sqlite-file>
 * Prints one JSON object on stdout; exits 1 with the error on stderr.
 *
 * It lives here, not inside a vitest file, for the reason `store/scenario-runner.ts` does: the
 * scenarios must run under the runtime the shipped binary uses, and `applyStandaloneEnv` has to be
 * the first thing a PROCESS does — `apps/web/lib/store.ts` picks its store at module evaluation,
 * so one process can only ever be in one of the two modes these scenarios compare.
 */

import { mkdtempSync } from "node:fs";
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
  readonly writeReason: string | null;
}

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
  const writeModules = await loadAppWriteModules();
  let caller = { companyId: company.id, runId: "run_1", seat: "growth" };
  const memory = withAppEpisodicMirror(createMemoryAdapter({ profileDir }), {
    modules: writeModules,
    caller: () => caller,
  });
  const hook = createFleetMemoryHook({ source: createAppFleetSource(), memory, brain: false });

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
  const episodeWrite = await memory.execute(
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

  const read = createAppMemoryReader({ modules: loadAppMemoryModules });
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
 * The standalone DURABLE profile: `DATABASE_URL` is a SQLite file while `apps/web/lib/db.ts` is a
 * postgresql client, so the app's store singleton cannot serve one query. Recall must degrade to
 * the run-derived candidates and the writers must say why, rather than taking a run down.
 */
async function runSqliteProfile(file: string): Promise<SqliteProfileResult> {
  applyStandaloneEnv(`file:${file}`);
  const { createAppMemoryReader } = await import("./app-tiers.js");
  const { loadAppWriteModules, writeSeatEpisode } = await import("./app-writes.js");
  const entries = await createAppMemoryReader()("co_missing", "growth");
  const outcome = await writeSeatEpisode({
    companyId: "co_missing",
    runId: "run_1",
    seat: "growth",
    text: "a fact the app store cannot take",
    modules: await loadAppWriteModules(),
  });
  return { entries: entries.length, writeReason: outcome.reason };
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
