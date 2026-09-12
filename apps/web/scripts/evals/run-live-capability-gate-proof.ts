/**
 * Live capability auto-promotion proof (Epic D).
 *
 *   npm run capability:proof -- --env-file trent.env.local --out artifacts/live-proofs/capability-gate.json
 *
 * Against a real Postgres store: records a measured seat eval, runs the capability
 * sweep, and proves (1) a seat auto-promotes to autonomous with the decision in the
 * audit log, (2) a reversible approval gate is then removed so the action runs
 * un-gated, and (3) a forced critic-flag spike demotes the seat and restores the gate.
 */
import fs from "node:fs";
import path from "node:path";
import { loadAllowedEvalEnvFile } from "@/lib/eval-env-file";

const ALLOWED = new Set(["DATABASE_URL", "DIRECT_URL", "SECRET_ENCRYPTION_KEY"]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const loadedEnvKeys = args.envFile ? loadAllowedEvalEnvFile(args.envFile, (k) => ALLOWED.has(k)) : [];
  if (process.env.DATABASE_URL && !process.env.DIRECT_URL) process.env.DIRECT_URL = process.env.DATABASE_URL;

  // Import store AFTER env is loaded so it binds to Postgres, not the in-memory store.
  const { store } = await import("@/lib/store");
  const { buildSlotEnvironment } = await import("@/lib/agent-catalog");
  const { recordSeatEvalMeasurement, runWeeklySeatCapabilityGateSweep } = await import("@/lib/seat-capability-sweep");
  const { loadLatestSeatCapabilityGateDecision, applySeatCapabilityGate } = await import("@/lib/seat-capability-gating");

  const proof: Record<string, unknown> = { passed: false, generatedAt: new Date().toISOString(), loadedEnvKeys, storeMode: process.env.DATABASE_URL ? "postgres" : "memory" };

  try {
    const role = "engineer" as const;
    const company = await store.createCompany({
      name: `Capability Gate Proof ${new Date().toISOString()}`,
      brief: { vision: "Prove seats earn fewer approval gates by passing real evals." },
    });
    proof.companyId = company.id;

    const baseEnv = buildSlotEnvironment(company.id, role);
    proof.reversibleGatesUnderTest = baseEnv.approvalRequiredFor.filter((g) => g === "github.issue" || g === "github.branch");

    // (1) High eval -> promote to autonomous.
    await recordSeatEvalMeasurement({ companyId: company.id, role, score: 95, criticFlagRate: 0.0, evaluatedAt: new Date(Date.now() - 60_000).toISOString(), evaluator: "capability_proof" });
    const promoteReport = await runWeeklySeatCapabilityGateSweep({ companyId: company.id, roles: [role] });
    const promote = promoteReport.results[0];
    proof.promote = promote;

    const promoteDecision = await loadLatestSeatCapabilityGateDecision(company.id, role);
    const gatedEnv = applySeatCapabilityGate(baseEnv, promoteDecision);
    const reversibleNowUngated = (proof.reversibleGatesUnderTest as string[]).every((g) => !gatedEnv.approvalRequiredFor.includes(g));
    proof.reversibleNowUngated = reversibleNowUngated;
    proof.removedApprovalGates = promoteDecision?.removedApprovalGates ?? [];
    proof.retainedApprovalGates = promoteDecision?.retainedApprovalGates ?? [];

    // (2) Critic-flag spike -> demote, gates restored.
    await recordSeatEvalMeasurement({ companyId: company.id, role, score: 95, criticFlagRate: 0.30, evaluatedAt: new Date().toISOString(), evaluator: "capability_proof_spike" });
    const demoteReport = await runWeeklySeatCapabilityGateSweep({ companyId: company.id, roles: [role] });
    const demote = demoteReport.results[0];
    proof.demote = demote;
    const demoteDecision = await loadLatestSeatCapabilityGateDecision(company.id, role);
    const gatesRestored = (proof.reversibleGatesUnderTest as string[]).every((g) => applySeatCapabilityGate(baseEnv, demoteDecision).approvalRequiredFor.includes(g));
    proof.gatesRestoredAfterDemote = gatesRestored;

    // (3) Audit log evidence.
    const audits = await store.listAuditLogs(company.id);
    const gateAudits = audits.filter((a) => a.action === "agent.capability_gate");
    proof.capabilityGateAuditCount = gateAudits.length;
    proof.capabilityGateAuditSummaries = gateAudits.map((a) => a.summary);

    proof.passed = Boolean(
      promote?.action === "promote"
      && promote?.qualityLabel === "autonomous"
      && reversibleNowUngated
      && demote?.action === "demote"
      && demote?.qualityLabel !== "autonomous"
      && gatesRestored
      && gateAudits.length >= 2,
    );
  } catch (error) {
    proof.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  }

  const json = JSON.stringify(proof, null, 2);
  if (args.outFile) {
    fs.mkdirSync(path.dirname(args.outFile), { recursive: true });
    fs.writeFileSync(args.outFile, json);
  }
  console.log(json);
  process.exitCode = proof.passed ? 0 : 1;
}

function parseArgs(argv: string[]): { envFile?: string; outFile?: string } {
  const out: { envFile?: string; outFile?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env-file") { out.envFile = argv[i + 1]; i++; }
    else if (argv[i] === "--out") { out.outFile = argv[i + 1]; i++; }
  }
  return out;
}

void main();
