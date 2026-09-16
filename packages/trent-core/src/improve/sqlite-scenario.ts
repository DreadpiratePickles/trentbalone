/**
 * Bun entrypoint: runs the improve store contract on a REAL SQLite file through `PrismaStore`,
 * closes the store, reopens it, and counts what survived. Prints one JSON object.
 *   bun packages/trent-core/src/improve/sqlite-scenario.ts <sqlite-file>
 */

import { createSqliteStore } from "../store/createStore.js";
import type { ImproveStorePort, StorePort } from "../store/StorePort.js";
import { runStoreContract } from "./store-contract.js";

function improveOf(store: StorePort): ImproveStorePort {
  if (store.improve === undefined) throw new Error("PrismaStore must expose the improve tables");
  return store.improve();
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: sqlite-scenario <sqlite-file>");
  const url = `file:${file}`;

  const store = await createSqliteStore({ url });
  // The three pre-existing tables carry a foreign key to Company; the contract's company must exist.
  await store.createCompany({ id: "co_contract", name: "Contract", slug: "co-contract" });
  const first = await runStoreContract(improveOf(store));
  await store.close();

  const reopened = await createSqliteStore({ url });
  const improve = improveOf(reopened);
  const result = {
    first,
    reopened: {
      traces: (await improve.listTraces("co_contract")).length,
      drafts: (await improve.listDrafts("co_contract")).length,
      ledger: (await improve.listLedger("co_contract")).length,
      gateCache: (await improve.getGateCache("co_contract", "baseline:s:v1:h1")) === null ? 0 : 1,
      agentVersions: (await improve.listAgentVersions("co_contract")).length,
    },
  };
  await reopened.close();
  process.stdout.write(JSON.stringify(result));
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exit(1);
});
