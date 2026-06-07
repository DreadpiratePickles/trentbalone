import { appendAuditLog } from "@/lib/audit-log";
import { store } from "@/lib/store";
import type { WorkbenchSession } from "@/lib/types";
import type { WorkbenchProviderAdapter, WorkbenchTestResult } from "@/lib/workbench-provider";

export type SelfHealingStatus = "already_green" | "healed" | "unhandled" | "rerun_failed";

export type SelfHealingPatch = {
  filePath: string;
  before: string;
  after: string;
  reason: string;
};

export type SelfHealingResult = {
  status: SelfHealingStatus;
  initial: WorkbenchTestResult;
  patch?: SelfHealingPatch;
  rerun?: WorkbenchTestResult;
};

export async function runWorkbenchSelfHealingLoop(input: {
  session: WorkbenchSession;
  provider: WorkbenchProviderAdapter;
  command?: string;
}): Promise<SelfHealingResult> {
  const initial = await input.provider.runTests(input.session, input.command);
  if (initial.failed === 0 && initial.exitCode === 0) return { status: "already_green", initial };

  await recordStep(input.session, "test", "running", "Self-healing diagnosis started", initial.output.slice(0, 1000));
  await appendAuditLog(
    input.session.companyId,
    "agent",
    "workbench.self_heal.diagnose",
    "workbench_session",
    input.session.id,
    summarizeFailure(initial),
  );

  const patch = await buildPatch(input.session, input.provider, initial);
  if (!patch) return { status: "unhandled", initial };

  await input.provider.writeFile(input.session, patch.filePath, patch.after);
  await recordStep(input.session, "file", "completed", "Self-healing patch applied", `${patch.filePath}: ${patch.reason}`);
  await appendAuditLog(
    input.session.companyId,
    "agent",
    "workbench.self_heal.patch",
    "workbench_session",
    input.session.id,
    `${patch.filePath}: ${patch.reason}`,
  );

  const rerun = await input.provider.runTests(input.session, input.command);
  const healed = rerun.failed === 0 && rerun.exitCode === 0;
  await recordStep(
    input.session,
    "test",
    healed ? "completed" : "failed",
    healed ? "Self-healing rerun passed" : "Self-healing rerun failed",
    rerun.output.slice(0, 1000),
  );
  await appendAuditLog(
    input.session.companyId,
    "agent",
    "workbench.self_heal.rerun",
    "workbench_session",
    input.session.id,
    healed ? "Rerun passed after patch." : "Rerun still failing after patch.",
  );

  return { status: healed ? "healed" : "rerun_failed", initial, patch, rerun };
}

async function buildPatch(
  session: WorkbenchSession,
  provider: WorkbenchProviderAdapter,
  result: WorkbenchTestResult,
): Promise<SelfHealingPatch | undefined> {
  const filePath = findSourcePath(result.output);
  if (!filePath) return undefined;

  const before = await provider.readFile(session, filePath);
  const after = patchSimpleAdditionBug(before);
  if (!after || after === before) return undefined;

  return {
    filePath,
    before,
    after,
    reason: "Corrected arithmetic implementation based on failing addition expectation.",
  };
}

function findSourcePath(output: string) {
  const normalized = output.replace(/\\n/g, "\n");
  return normalized.match(/\bsource:\s*([^\s]+)/i)?.[1]
    ?? normalized.match(/\b([\w./-]+\.tsx?)\b/)?.[1];
}

function patchSimpleAdditionBug(source: string) {
  if (!/function\s+add\b/.test(source)) return undefined;
  return source.replace("return a - b;", "return a + b;");
}

function summarizeFailure(result: WorkbenchTestResult) {
  return `Tests failed: passed=${result.passed}, failed=${result.failed}; ${result.output.slice(0, 500)}`;
}

async function recordStep(
  session: WorkbenchSession,
  type: "test" | "file",
  status: "running" | "completed" | "failed",
  title: string,
  content: string,
) {
  await store.addWorkbenchEvent({
    companyId: session.companyId,
    sessionId: session.id,
    type,
    status,
    title,
    content,
  });
}
