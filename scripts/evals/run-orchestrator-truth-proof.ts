/**
 * scripts/evals/run-orchestrator-truth-proof.ts
 *
 * Deterministic, no-live-provider proof that the durable run has ONE truth across
 * the snapshot endpoint and the trace endpoint. It reproduces the production bug
 * (orc_o6wvnxfj05mg): a durable run finishes — steps terminal, a `run_done` event
 * persisted — while the run ROW's status write is lost and stays "planning". We
 * then assert the reconciliation makes the snapshot AND the trace agree on the
 * truthful terminal status, and that a genuinely-terminal run is not falsely
 * flagged as reconciled (no false positives).
 *
 * Run: npm run orc:truth-proof
 * Exits 0 and writes artifacts/live-proofs/orchestrator-truth-YYYY-MM-DD.json
 */
import fs from "node:fs";
import path from "node:path";

// Force the in-memory store + no queue/redis BEFORE importing anything that
// reads these at module load.
process.env.DATABASE_URL = "";
process.env.REDIS_URL = "";
process.env.TRENT_QUEUE_FALLBACK = "disabled";

type Check = { name: string; ok: boolean; detail: string };

async function main() {
  const { store } = await import("@/lib/store");
  const { makeId } = await import("@/lib/utils");
  const { getOrchestrationRunSnapshot } = await import("@/lib/orchestrator");
  const { clearOrchestrationRunCache } = await import("@/lib/orchestrator-cache");
  const { buildOrchestratorTraceReplay } = await import("@/lib/orchestrator-trace-replay");

  const checks: Check[] = [];

  const company = await store.createCompany({
    name: `Truth Proof ${makeId("co")}`,
    brief: { vision: "durable run truth" },
  });
  const companyId = company.id;

  // ── Case A: a finished durable run whose row status write was LOST ──────────
  // Persist the run as "planning" (stale), but lay down a completed step set and
  // a terminal run_done event — exactly the orc_o6wvnxfj05mg shape.
  const staleRunId = makeId("orc");
  await store.createOrchestratorRun({
    id: staleRunId,
    companyId,
    objective: "Prove snapshot/trace agreement on a stale durable run",
    trigger: "manual",
    status: "planning" as never,
    modelPolicy: {},
    budgetCents: 500,
    costCents: 0,
    summary: "CEO: shipped the durable run report.",
  });
  for (const [i, id] of ["s1", "s2"].entries()) {
    await store.upsertOrchestratorStep({
      id,
      runId: staleRunId,
      companyId,
      seq: i + 1,
      title: `Durable step ${id}`,
      rationale: "needed",
      agentRole: "analyst",
      dependsOn: i === 0 ? [] : ["s1"],
      expectedOutput: "Report",
      riskLevel: "low",
      needsApproval: false,
      status: "completed",
      output: `output:${id}`,
      costCents: 11,
    });
  }
  await store.appendOrchestratorEvent({ runId: staleRunId, companyId, kind: "run_start", payload: {} });
  await store.appendOrchestratorEvent({ runId: staleRunId, companyId, kind: "step_end", stepId: "s2", payload: {} });
  await store.appendOrchestratorEvent({
    runId: staleRunId,
    companyId,
    kind: "run_done",
    payload: { run: { id: staleRunId, status: "completed" } },
  });

  // Confirm the persisted row is genuinely stale before reconciliation.
  const rowBefore = await store.getOrchestratorRun(staleRunId);
  checks.push(check("persisted row is stale at planning before read", rowBefore?.status === "planning", `row=${rowBefore?.status}`));

  clearOrchestrationRunCache();
  const snapshot = await getOrchestrationRunSnapshot(staleRunId);

  const [run, steps, events] = await Promise.all([
    store.getOrchestratorRun(staleRunId),
    store.listOrchestratorSteps(staleRunId),
    store.listOrchestratorEvents(staleRunId),
  ]);
  const trace = buildOrchestratorTraceReplay({ run: run!, steps, events });

  checks.push(check("snapshot reconciles stale planning → completed", snapshot?.status === "completed", `snapshot=${snapshot?.status}`));
  checks.push(check("snapshot flags reconciliation metadata", snapshot?.reconciled === true && snapshot?.staleSnapshotDetected === true && snapshot?.reconciledFrom === "trace", `reconciled=${snapshot?.reconciled} from=${snapshot?.reconciledFrom} stale=${snapshot?.staleSnapshotDetected}`));
  checks.push(check("trace reconciles stale planning → completed", trace.status === "completed", `trace=${trace.status}`));
  checks.push(check("SNAPSHOT and TRACE agree on one truth", snapshot?.status === trace.status, `snapshot=${snapshot?.status} trace=${trace.status}`));
  checks.push(check("self-heal corrected the persisted row durably", run?.status === "completed", `row=${run?.status}`));

  // ── Case B: a genuinely-terminal run is NOT falsely reconciled ──────────────
  const cleanRunId = makeId("orc");
  await store.createOrchestratorRun({
    id: cleanRunId,
    companyId,
    objective: "Control: honest completed run",
    trigger: "manual",
    status: "completed" as never,
    modelPolicy: {},
    budgetCents: 500,
    costCents: 0,
    summary: "done",
  });
  await store.upsertOrchestratorStep({
    id: "c1", runId: cleanRunId, companyId, seq: 1, title: "done", rationale: "x",
    agentRole: "analyst", dependsOn: [], expectedOutput: "y", riskLevel: "low",
    needsApproval: false, status: "completed", output: "ok",
  });
  await store.appendOrchestratorEvent({ runId: cleanRunId, companyId, kind: "run_done", payload: { run: { status: "completed" } } });
  clearOrchestrationRunCache();
  const cleanSnapshot = await getOrchestrationRunSnapshot(cleanRunId);
  checks.push(check("honest completed run is not falsely flagged stale", cleanSnapshot?.status === "completed" && cleanSnapshot?.reconciled === false && cleanSnapshot?.staleSnapshotDetected === false, `reconciled=${cleanSnapshot?.reconciled} stale=${cleanSnapshot?.staleSnapshotDetected}`));

  const ok = checks.every((c) => c.ok);
  const report = {
    proof: "orchestrator-truth-proof",
    generatedAt: new Date().toISOString(),
    knownProductionRun: "orc_o6wvnxfj05mg",
    ok,
    summary: {
      total: checks.length,
      passed: checks.filter((c) => c.ok).length,
      failed: checks.filter((c) => !c.ok).length,
    },
    staleRun: {
      runId: staleRunId,
      persistedRowBefore: rowBefore?.status,
      snapshotStatus: snapshot?.status,
      snapshotReconciledFrom: snapshot?.reconciledFrom,
      traceStatus: trace.status,
      agree: snapshot?.status === trace.status,
    },
    checks,
  };

  const day = report.generatedAt.slice(0, 10);
  const outPath = path.join("artifacts", "live-proofs", `orchestrator-truth-${day}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nArtifact: ${outPath}\n`);
  if (!ok) process.exitCode = 1;
}

function check(name: string, ok: boolean, detail: string): Check {
  return { name, ok, detail };
}

main().catch((err) => {
  console.error("orchestrator-truth-proof failed:", err);
  process.exitCode = 1;
});
