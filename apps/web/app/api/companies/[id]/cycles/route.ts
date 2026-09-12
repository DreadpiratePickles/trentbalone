import { NextResponse } from "next/server";
import { enqueueCompanyCycle, processJobData, removeQueuedBullJob } from "@/lib/queue";
import { launchOrchestration } from "@/lib/orchestrator";
import { buildRunCycleControl } from "@/lib/run-cycle-control";
import { store } from "@/lib/store";
import { getAuthUser, unauthorized, forbidden, requireRoleForRequest } from "@/lib/session";
import { checkRateLimit, checkCycleRateLimit, rateLimitExceeded } from "@/lib/rate-limit";

export const maxDuration = 60;

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const company = await store.getCompany(id);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  
  const check = await requireRoleForRequest(user.id, "viewer", { companyId: company.id });
  if (!check.ok) return forbidden();

  const [cycles, executions] = await Promise.all([
    store.listCycles(company.id),
    store.listExecutions(company.id)
  ]);
  return NextResponse.json({ cycles, executions });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getAuthUser();
  if (!user) return unauthorized();

  const { id } = await params;
  const company = await store.getCompany(id);
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });
  
  const check = await requireRoleForRequest(user.id, "member", { companyId: company.id });
  if (!check.ok) return forbidden();

  const rateLimit = await checkRateLimit(user.id, company.id);
  if (!rateLimit.ok) return rateLimitExceeded(rateLimit.retryAfterSeconds);

  const cycleLimit = await checkCycleRateLimit(company.id);
  if (!cycleLimit.ok) return rateLimitExceeded(cycleLimit.retryAfterSeconds);

  try {
    const body = await req.clone().json().catch(() => ({}));
    const { fromExecutionId, processNow } = body as { fromExecutionId?: string; processNow?: boolean };

    // Debug: re-run from a specific agent execution step
    if (fromExecutionId) {
      if (process.env.NODE_ENV !== "development") {
        return NextResponse.json({ error: "Debug re-run only available in development" }, { status: 403 });
      }
      const executions = await store.listExecutions(company.id);
      const sourceExec = executions.find((e) => e.id === fromExecutionId);
      if (!sourceExec) return NextResponse.json({ error: "Execution not found" }, { status: 404 });
      // Create a single-step debug cycle that replays the agent execution
      const debugTask = await store.createTask({
        companyId: id,
        title: `[debug] re-run ${sourceExec.agentRole} from exec ${fromExecutionId.slice(-6)}`,
        prompt: sourceExec.input,
        status: "queued",
        priority: "medium",
        agentRole: sourceExec.agentRole,
        tags: ["debug", "rerun"],
        costCents: 0,
      });
      const run = await launchOrchestration({
        companyId: id,
        objective: [
          `Debug rerun from execution ${fromExecutionId}.`,
          `Original ${sourceExec.agentRole} input: ${sourceExec.input}`,
          "Use the durable orchestrator path and preserve audit, critic, and memory records.",
        ].join("\n"),
        trigger: "manual",
        fullTeam: false,
        cycleKind: "scheduled",
      });
      return NextResponse.json({ run, cycle: { id: run.cycleId ?? run.id, status: run.status }, debugTask }, { status: 201 });
    }

    const job = await enqueueCompanyCycle({ companyId: id, trigger: "user", cycleTrigger: "manual" });
    if (processNow) {
      const removed = await removeQueuedBullJob(job.id);
      if (!removed.hasQueue) {
        return NextResponse.json({ job, processing: "fallback" }, { status: 202 });
      }
      if (removed.hasQueue && removed.state === "active") {
        return NextResponse.json({ job, processing: "worker_active" }, { status: 202 });
      }
      if (removed.hasQueue && !removed.removed && removed.state !== "missing") {
        return NextResponse.json({ job, processing: "queued" }, { status: 202 });
      }

      await processJobData("company_scheduled_cycle", {
        jobRunId: job.id,
        companyId: id,
        trigger: "user",
        cycleTrigger: "manual",
      });
      const processedJob = await store.getJobRun(job.id) ?? job;
      return NextResponse.json({
        job: processedJob,
        processed: true,
        runCycle: buildRunCycleControl({ job: processedJob }),
      }, { status: 201 });
    }
    return NextResponse.json({ job, runCycle: buildRunCycleControl({ job }) }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cycle failed" }, { status: 400 });
  }
}
