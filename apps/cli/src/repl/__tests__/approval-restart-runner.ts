/**
 * Two-phase restart proof, run under Bun because the store adapter is bun:sqlite.
 *
 *   phase 1: `open <file>`    — a fresh process opens an approval and dies mid-approval.
 *   phase 2: `resume <file>`  — a fresh process restores the gate from the same database
 *                               and answers the approval that is still pending.
 *
 * Each phase is a SEPARATE process, which is the only honest way to prove a restart.
 * Prints one JSON object on stdout.
 */

import { createSqliteStore } from "../../../../../packages/trent-core/src/store/createStore.js";
import { ApprovalGate } from "../approvals.js";

const COMPANY_ID = "cmp_restart";

async function open(url: string): Promise<unknown> {
  const store = await createSqliteStore({ url });
  try {
    await store.createCompany({ id: COMPANY_ID, name: "Restart Co", slug: "restart-co" });
    const gate = new ApprovalGate(store, COMPANY_ID);
    const record = await gate.open({
      action: "deploy the release",
      reason: "production change requires a human",
      agentRole: "eng-devops",
    });
    return { approvalId: record.id, blocking: gate.blocking, pending: (await gate.pending()).length };
  } finally {
    await store.close();
  }
}

async function resume(url: string): Promise<unknown> {
  const store = await createSqliteStore({ url });
  try {
    const gate = new ApprovalGate(store, COMPANY_ID);
    await gate.restore();
    const pending = await gate.pending();
    const blockingAfterRestore = gate.blocking;
    const first = pending[0];
    const answered = first === undefined ? null : await gate.answer(first.id, "approved");
    return {
      blockingAfterRestore,
      pendingCount: pending.length,
      action: first?.action ?? null,
      reason: first?.reason ?? null,
      statusAfterAnswer: answered?.status ?? null,
      blockingAfterAnswer: gate.blocking,
      pendingAfterAnswer: (await gate.pending()).length,
    };
  } finally {
    await store.close();
  }
}

const PHASES: Record<string, (url: string) => Promise<unknown>> = { open, resume };

async function main(): Promise<void> {
  const [phase, file] = process.argv.slice(2);
  const run = phase === undefined ? undefined : PHASES[phase];
  if (run === undefined || file === undefined) {
    throw new Error(`usage: approval-restart-runner <${Object.keys(PHASES).join("|")}> <sqlite-file>`);
  }
  process.stdout.write(JSON.stringify(await run(`file:${file}`)));
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? `${error.stack ?? error.message}\n` : `${String(error)}\n`);
  process.exit(1);
});
