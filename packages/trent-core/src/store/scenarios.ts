/**
 * Test scenarios that MUST run under Bun, because the driver adapter is bun:sqlite.
 *
 * They live here rather than inside a vitest file so they are type-checked with the rest of
 * the package and executed by the real runtime through scenario-runner.ts. Each returns a
 * plain JSON-serializable result that the vitest suite asserts on.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "./generated/client";
import { PrismaBunSQLite } from "./bun-sqlite-adapter.mjs";
import { createSqliteStore, readDerivedDdl } from "./createStore.js";
import { PrismaStore } from "./PrismaStore.js";
import type { JsonObject, StorePort } from "./StorePort.js";
import { computeAuditRowHash, exportAudit, GENESIS_HASH } from "../audit/export.js";
import { generateAuditKeyPair } from "../audit/signing.js";
import { verifyAuditExport } from "../audit/verify.js";

export interface DurabilityResult {
  beforeClose: { companyId: string; runId: string; stepCount: number; approvalStatus: string };
  afterReopen: {
    companyFound: boolean;
    companyName: string | null;
    runFound: boolean;
    runObjective: string | null;
    runStatus: string | null;
    stepTitles: string[];
    eventKinds: string[];
    approvalFound: boolean;
    approvalStatus: string | null;
    jobRunCount: number;
    jobRunMetadata: JsonObject[];
  };
  afterCascadeDelete: {
    companyFound: boolean;
    runFound: boolean;
    stepCount: number;
    eventCount: number;
    approvalFound: boolean;
  };
}

async function seed(store: StorePort): Promise<{
  companyId: string;
  runId: string;
  approvalId: string;
}> {
  const company = await store.createCompany({
    name: "Durable Co",
    slug: `durable-${Date.now()}`,
    budgetCents: 25_00,
  });
  const run = await store.createRun({
    id: "run_durable_1",
    companyId: company.id,
    objective: "prove --continue can resume a real run",
    trigger: "cli",
    status: "running",
    modelPolicy: { planner: "mock", worker: "mock" },
    budgetCents: 10_00,
  });
  for (const [index, title] of ["draft the plan", "execute the plan"].entries()) {
    await store.upsertStep({
      id: `step_durable_${index + 1}`,
      runId: run.id,
      companyId: company.id,
      seq: index + 1,
      title,
      rationale: "seeded",
      agentRole: index === 0 ? "ceo" : "engineer",
      dependsOn: index === 0 ? [] : ["step_durable_1"],
      expectedOutput: "text",
      riskLevel: "low",
      status: index === 0 ? "completed" : "waiting_approval",
      needsApproval: index === 1,
      costCents: index === 0 ? 12 : null,
    });
    await store.appendEvent({
      runId: run.id,
      companyId: company.id,
      seq: index + 1,
      kind: index === 0 ? "step_start" : "step_end",
      stepId: `step_durable_${index + 1}`,
      payload: { seq: index + 1 },
    });
  }
  const approval = await store.createApproval({
    companyId: company.id,
    action: "publish the post",
    reason: "risk level requires a human",
  });
  await store.createJobRun({
    type: "orchestrator",
    trigger: "cli",
    companyId: company.id,
    metadata: { runId: run.id, action: "execute_step" },
  });
  return { companyId: company.id, runId: run.id, approvalId: approval.id };
}

/**
 * The test that proves `--continue` can resume a real run: write state, close the client
 * ENTIRELY, open a new one against the same file, and read everything back.
 */
export async function runDurabilityScenario(url: string): Promise<DurabilityResult> {
  const first = await createSqliteStore({ url });
  const ids = await seed(first);
  const stepsBefore = await first.listSteps(ids.runId);
  const approvalBefore = await first.getApproval(ids.approvalId);
  await first.close();

  const second = await createSqliteStore({ url });
  const company = await second.getCompany(ids.companyId);
  const run = await second.getRun(ids.runId);
  const steps = await second.listSteps(ids.runId);
  const events = await second.listEvents(ids.runId);
  const approval = await second.getApproval(ids.approvalId);
  const jobRuns = await second.listJobRuns(ids.companyId);

  await second.deleteCompany(ids.companyId);
  const afterDelete = {
    companyFound: (await second.getCompany(ids.companyId)) !== null,
    runFound: (await second.getRun(ids.runId)) !== null,
    stepCount: (await second.listSteps(ids.runId)).length,
    eventCount: (await second.listEvents(ids.runId)).length,
    approvalFound: (await second.getApproval(ids.approvalId)) !== null,
  };
  await second.close();

  return {
    beforeClose: {
      companyId: ids.companyId,
      runId: ids.runId,
      stepCount: stepsBefore.length,
      approvalStatus: approvalBefore?.status ?? "missing",
    },
    afterReopen: {
      companyFound: company !== null,
      companyName: company?.name ?? null,
      runFound: run !== null,
      runObjective: run?.objective ?? null,
      runStatus: run?.status ?? null,
      stepTitles: steps.map((step) => step.title),
      eventKinds: events.map((event) => event.kind),
      approvalFound: approval !== null,
      approvalStatus: approval?.status ?? null,
      jobRunCount: jobRuns.length,
      jobRunMetadata: jobRuns.map((job) => job.metadata ?? {}),
    },
    afterCascadeDelete: afterDelete,
  };
}

export interface ConcurrencyResult {
  writes: number;
  eventsSeen: number;
  journalMode: string;
  busyTimeoutMs: number;
  error: string | null;
}

/**
 * Review finding C4. Two independent connections write to the same file at the same time.
 * Without WAL plus a busy timeout the loser raises SQLITE_BUSY.
 */
export async function runConcurrencyScenario(url: string): Promise<ConcurrencyResult> {
  const setup = await createSqliteStore({ url });
  const company = await setup.createCompany({ name: "Busy Co", slug: `busy-${Date.now()}` });
  const run = await setup.createRun({
    id: "run_busy_1",
    companyId: company.id,
    objective: "concurrent writers",
    trigger: "cli",
    status: "running",
    modelPolicy: {},
  });
  await setup.close();

  const a = await createSqliteStore({ url });
  const b = await createSqliteStore({ url });
  let error: string | null = null;
  const total = 40;
  try {
    await Promise.all(
      Array.from({ length: total }, (_unused, i) =>
        (i % 2 === 0 ? a : b).appendEvent({
          runId: run.id,
          companyId: company.id,
          seq: i + 1,
          kind: "tick",
          payload: { i },
        }),
      ),
    );
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  const eventsSeen = (await b.listEvents(run.id)).length;
  const pragmas = await readPragmas(url);
  await a.close();
  await b.close();

  return { writes: total, eventsSeen, error, ...pragmas };
}

async function readPragmas(url: string): Promise<{ journalMode: string; busyTimeoutMs: number }> {
  const connection = await new PrismaBunSQLite({ url }).connect();
  try {
    const journal = await connection.queryRaw({
      sql: "PRAGMA journal_mode",
      args: [],
      argTypes: [],
    });
    const busy = await connection.queryRaw({ sql: "PRAGMA busy_timeout", args: [], argTypes: [] });
    return {
      journalMode: String(journal.rows[0]?.[0] ?? ""),
      busyTimeoutMs: Number(busy.rows[0]?.[0] ?? 0),
    };
  } finally {
    await connection.dispose();
  }
}

export interface TransactionResult {
  committed: number;
  rolledBack: boolean;
  afterRollback: number;
  error: string | null;
}

/**
 * Guards the adapter semantics the spike found the hard way: startTransaction issues BEGIN,
 * and commit/rollback only release the mutex. Doubling COMMIT/ROLLBACK surfaces as P2028.
 */
export async function runTransactionScenario(url: string): Promise<TransactionResult> {
  await (await createSqliteStore({ url })).close();
  const prisma = new PrismaClient({ adapter: new PrismaBunSQLite({ url }) });
  const store = new PrismaStore(prisma);
  const company = await store.createCompany({ name: "Tx Co", slug: `tx-${Date.now()}` });

  let error: string | null = null;
  let rolledBack = false;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.jobRun.create({
        data: { type: "a", trigger: "cli", companyId: company.id, summary: "", metadata: {} },
      });
      await tx.jobRun.create({
        data: { type: "b", trigger: "cli", companyId: company.id, summary: "", metadata: {} },
      });
    });
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const committed = (await store.listJobRuns(company.id)).length;

  try {
    await prisma.$transaction(async (tx) => {
      await tx.jobRun.create({
        data: { type: "c", trigger: "cli", companyId: company.id, summary: "", metadata: {} },
      });
      throw new Error("deliberate rollback");
    });
  } catch {
    rolledBack = true;
  }
  const afterRollback = (await store.listJobRuns(company.id)).length;

  await store.close();
  return { committed, rolledBack, afterRollback, error };
}

const AUDIT_COMPANY_ID = "cmp_audit";

/**
 * Three chained AuditLog rows for one company, written the way the wrapped application's
 * `audit-log.ts` writes them: `prevHash` is `genesis` for the first row and the prior row's hash
 * after that, and the hash is computed over the ISO `createdAt` string.
 */
export async function seedAuditChain(url: string): Promise<{ companyId: string; ids: string[] }> {
  await (await createSqliteStore({ url })).close();
  const prisma = new PrismaClient({ adapter: new PrismaBunSQLite({ url }) });
  const store = new PrismaStore(prisma);
  try {
    const company = await store.createCompany({ id: AUDIT_COMPANY_ID, name: "Audit Co", slug: `audit-${Date.now()}` });
    const ids: string[] = [];
    let prevHash = GENESIS_HASH;
    for (let i = 1; i <= 3; i += 1) {
      const createdAt = new Date(Date.UTC(2026, 8, 15, 9, i));
      const row = {
        id: `aud_${i}`,
        companyId: company.id,
        actor: "user",
        action: `run.step_${i}`,
        objectType: "run",
        objectId: "run_1",
        summary: `row ${i}`,
        prevHash,
        createdAt: createdAt.toISOString(),
      };
      const hash = computeAuditRowHash(row);
      await prisma.auditLog.create({ data: { ...row, hash, createdAt } });
      prevHash = hash;
      ids.push(row.id);
    }
    return { companyId: company.id, ids };
  } finally {
    await store.close();
  }
}

export interface AuditScenarioResult {
  listedIds: string[];
  listedPrevHashes: string[];
  listedForOtherCompany: number;
  exportedRows: number;
  lines: number;
  verified: boolean;
  failures: readonly unknown[];
}

/** Seeds the chain, reads it back through `StorePort.listAuditRows`, exports it beside the database and verifies the export. */
export async function runAuditScenario(url: string): Promise<AuditScenarioResult> {
  await seedAuditChain(url);
  const store = await createSqliteStore({ url });
  try {
    const listed = await store.listAuditRows();
    const other = await store.listAuditRows({ companyId: "cmp_none" });
    const outFile = path.join(path.dirname(url.replace(/^file:/, "")), "audit.ndjson");
    const exported = await exportAudit({ source: store, outFile, key: generateAuditKeyPair() });
    const lines = readFileSync(outFile, "utf8").split("\n").filter((line) => line.length > 0).length;
    const report = await verifyAuditExport(outFile);
    return {
      listedIds: listed.map((row) => row.id),
      listedPrevHashes: listed.map((row) => row.prevHash),
      listedForOtherCompany: other.length,
      exportedRows: exported.rows,
      lines,
      verified: report.ok,
      failures: report.failures,
    };
  } finally {
    await store.close();
  }
}

export function ddlStatementCount(): number {
  return (readDerivedDdl().match(/^CREATE TABLE /gm) ?? []).length;
}
