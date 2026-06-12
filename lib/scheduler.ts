import type { Company, JobRun, RecurringTaskTemplate, Report } from "@/lib/types";
import { store } from "@/lib/store";
import { nowIso } from "@/lib/utils";
import { nextRunFromSchedule } from "@/lib/schedule-grammar";
import { deliverMorningBriefingEmail } from "@/lib/morning-briefing-email";
import { buildMorningOutcomeSnapshot } from "@/lib/morning-outcome-snapshot";

export { parseSchedule, nextRunFromSchedule as nextRunFromGrammar } from "@/lib/schedule-grammar";

/**
 * nextRunFrom — computes the next run timestamp for a recurring task.
 * Accepts either the legacy "daily" | "weekly" cadence strings or any
 * natural-language / cron schedule supported by the schedule grammar.
 */
export function nextRunFrom(dateIso: string, cadence: string): string {
  return nextRunFromSchedule(dateIso, cadence);
}

export function nextCycleFrom(company: Company, fromIso = nowIso()) {
  if (company.cycleFrequency === "manual") return undefined;
  const date = new Date(fromIso);
  date.setDate(date.getDate() + (company.cycleFrequency === "daily" ? 1 : 7));
  return date.toISOString();
}

export async function materializeDueRecurringTasks(
  companyId: string,
  atIso = nowIso()
): Promise<ReturnType<typeof store.createTask> extends Promise<infer T> ? T[] : never> {
  const templates = await store.listRecurringTasks(companyId);
  const due = templates.filter(
    (template) => template.enabled && new Date(template.nextRunAt).getTime() <= new Date(atIso).getTime()
  );

  const tasks = [];
  for (const template of due) {
    const task = await store.createTask({
      companyId,
      title: template.title,
      prompt: template.prompt,
      status: template.agentRole === "engineer" ? "waiting_approval" : "queued",
      priority: template.priority,
      agentRole: template.agentRole,
      tags: [...template.tags, "recurring"],
      recurringTemplateId: template.id
    });
    await store.updateRecurringTask(template.id, {
      lastMaterializedAt: atIso,
      nextRunAt: nextRunFrom(atIso, template.cadence as RecurringTaskTemplate["cadence"])
    });
    tasks.push(task);
  }
  return tasks as ReturnType<typeof store.createTask> extends Promise<infer T> ? T[] : never;
}

/** Returns true if a company with nightlyRunHour=H has not yet run a cycle this UTC hour */
function isNightlyRunDue(company: Company, atIso: string): boolean {
  if (company.nightlyRunHour === undefined) return false;
  const at = new Date(atIso);
  if (at.getUTCHours() !== company.nightlyRunHour) return false;
  if (!company.lastCycleAt) return true;
  const last = new Date(company.lastCycleAt);
  // already ran during this UTC hour today
  return !(
    last.getUTCFullYear() === at.getUTCFullYear() &&
    last.getUTCMonth() === at.getUTCMonth() &&
    last.getUTCDate() === at.getUTCDate() &&
    last.getUTCHours() === at.getUTCHours()
  );
}

export async function runDueScheduledCycles(atIso = nowIso(), companyIds?: string[]) {
  const companies = await store.listCompanies();
  const atMs = new Date(atIso).getTime();

  const dueCompanies = companies
    .filter((company) => company.status === "active")
    .filter((company) => !companyIds || companyIds.includes(company.id))
    .filter((company) =>
      // regular frequency-based schedule
      (company.cycleFrequency !== "manual" &&
        company.nextCycleAt &&
        new Date(company.nextCycleAt).getTime() <= atMs) ||
      // nightly autonomous run
      isNightlyRunDue(company, atIso)
    );

  // Process expired approvals across ALL active companies (not just due ones)
  const allActive = companies.filter((c) => c.status === "active");
  for (const company of allActive) {
    try {
      await processExpiredApprovals(company.id);
    } catch {
      // expiry processing failure must not block cycles
    }
  }

  const results = [];
  for (const company of dueCompanies) {
    await materializeDueRecurringTasks(company.id, atIso);
    const { launchOrchestration } = await import("@/lib/orchestrator");
    const run = await launchOrchestration({
      companyId: company.id,
      objective: buildOperatingCycleObjective("scheduled"),
      trigger: "scheduled",
      fullTeam: true,
      cycleKind: "scheduled",
    });
    results.push(run);
    // Assemble morning briefing after nightly autonomous runs
    if (isNightlyRunDue(company, atIso)) {
      try {
        await assembleMorningBriefing(company.id);
      } catch {
        // briefing failure must not block cycle completion
      }
    }
  }
  return results;
}

function buildOperatingCycleObjective(trigger: "manual" | "scheduled"): string {
  return [
    `Inspect company state for this ${trigger} operating cycle.`,
    "Identify the highest-leverage opportunities across company memory, tasks, approvals, usage, recent cycles, and connected tools.",
    "Execute safe work through the durable multi-agent orchestrator.",
    "Surface required approvals instead of taking irreversible external actions.",
    "Produce a CEO-ready summary, report, audit trail, and memory log.",
  ].join(" ");
}

export async function runScheduledCycleSweep(trigger: JobRun["trigger"] = "system", companyIds?: string[]) {
  const job = await store.createJobRun({
    type: "scheduled_cycle_sweep",
    status: "running",
    trigger,
    summary: "Checking companies with due scheduled cycles.",
    resultCount: 0,
    metadata: {
      at: nowIso(),
      scopedCompanyCount: companyIds?.length ?? 0
    }
  });

  try {
    const results = await runDueScheduledCycles(undefined, companyIds);
    return await store.updateJobRun(job.id, {
      status: "completed",
      completedAt: nowIso(),
      resultCount: results.length,
      summary: `Completed scheduled cycle sweep with ${results.length} cycle${results.length === 1 ? "" : "s"} run.`,
      metadata: {
        ...job.metadata,
        cycleCount: results.length
      }
    });
  } catch (error) {
    return await store.updateJobRun(job.id, {
      status: "failed",
      completedAt: nowIso(),
      error: error instanceof Error ? error.message : "Unknown scheduler error",
      summary: "Scheduled cycle sweep failed."
    });
  }
}

export async function materializeCompanyRecurringTasksJob(
  companyId: string,
  trigger: JobRun["trigger"] = "user"
) {
  const job = await store.createJobRun({
    type: "recurring_task_materialization",
    status: "running",
    companyId,
    trigger,
    summary: "Materializing due recurring task templates.",
    resultCount: 0,
    metadata: { at: nowIso() }
  });

  try {
    const tasks = await materializeDueRecurringTasks(companyId);
    return await store.updateJobRun(job.id, {
      status: "completed",
      completedAt: nowIso(),
      resultCount: tasks.length,
      summary: `Materialized ${tasks.length} recurring task${tasks.length === 1 ? "" : "s"}.`,
      metadata: {
        ...job.metadata,
        taskCount: tasks.length
      }
    });
  } catch (error) {
    return await store.updateJobRun(job.id, {
      status: "failed",
      completedAt: nowIso(),
      error: error instanceof Error ? error.message : "Unknown recurring task error",
      summary: "Recurring task materialization failed."
    });
  }
}

/**
 * Assembly point for the morning briefing (T3.1 / T9.1).
 * Called after the nightly cycle sweep to create a "morning_briefing" report
 * that summarises what Trent did while the founder slept.
 * Email delivery is optional; when no provider is configured this function only creates the report.
 */
/**
 * T6.5 — Re-plan on approval expiry.
 * Scans all pending approvals; marks expired ones as rejected and creates a re-plan task
 * so the agent knows to re-scope the work rather than silently dropping it.
 */
export async function processExpiredApprovals(companyId: string): Promise<number> {
  const approvals = await store.listApprovals(companyId);
  const now = Date.now();
  let expired = 0;

  for (const approval of approvals) {
    if (approval.status !== "pending") continue;
    if (!approval.expiresAt) continue;
    if (new Date(approval.expiresAt).getTime() > now) continue;

    // Mark as rejected (expired)
    await store.resolveApproval(approval.id, "rejected");
    await store.addAudit(
      companyId,
      "system",
      "approval.expired",
      "approval",
      approval.id,
      `Approval for "${approval.action}" expired without action.`
    );

    // Create a re-plan task so the agent re-scopes
    const replanTask = await store.createTask({
      companyId,
      title: `Re-plan: "${approval.action}" approval expired`,
      prompt: `The previous approval request for "${approval.action}" expired before the founder could review it. Re-plan the work with adjusted scope, reduced blast radius, or break into smaller approvable chunks. Do not repeat the same approach that timed out.`,
      status: "queued",
      priority: "medium",
      agentRole: "ceo",
      tags: ["replan", "expired_approval"],
      costCents: 0,
    });

    await store.addAudit(
      companyId,
      "system",
      "task.replan_created",
      "task",
      replanTask.id,
      `Re-plan task created from expired approval: ${approval.action}`
    );

    expired++;
  }

  return expired;
}

export async function assembleMorningBriefing(companyId: string): Promise<Report> {
  const company = await store.getCompany(companyId);
  if (!company) throw new Error("Company not found");

  const twelveHoursAgoIso = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  const tasks = await store.listTasks(companyId);
  const cycles = await store.listCycles(companyId);
  const usage = await store.listUsage(companyId);
  const approvals = await store.listApprovals(companyId);

  const overnightCycles = cycles.filter((c) => c.startedAt >= twelveHoursAgoIso);
  const overnightTasks = tasks.filter(
    (t) => (t.status === "completed" || t.status === "waiting_approval") && t.updatedAt >= twelveHoursAgoIso
  );
  const completedOvernight = overnightTasks.filter((t) => t.status === "completed");
  const newApprovals = overnightTasks.filter((t) => t.status === "waiting_approval");
  const pendingApprovals = approvals.filter((a) => a.status === "pending");
  const outcomeSnapshot = await buildMorningOutcomeSnapshot({ company, usage, approvals });
  const overnightSpend = usage
    .filter((u) => u.createdAt >= twelveHoursAgoIso)
    .reduce((sum, u) => sum + u.amountCents, 0);

  const subject = `Morning briefing — ${company.name} · ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}`;

  const findings: string[] = [];

  if (overnightCycles.length > 0) {
    findings.push(`Trent ran ${overnightCycles.length} overnight cycle${overnightCycles.length === 1 ? "" : "s"} while you slept.`);
  } else {
    findings.push("No overnight cycles ran. Check the nightly run schedule in Settings.");
  }

  if (completedOvernight.length > 0) {
    findings.push(`${completedOvernight.length} task${completedOvernight.length === 1 ? "" : "s"} completed overnight.`);
    findings.push(`Completed: ${completedOvernight.map((task) => task.title).slice(0, 8).join("; ")}.`);
  }

  if (newApprovals.length > 0) {
    findings.push(`${newApprovals.length} new item${newApprovals.length === 1 ? "" : "s"} waiting for your approval.`);
  }

  if (pendingApprovals.length > 0) {
    findings.push(`${pendingApprovals.length} approval${pendingApprovals.length === 1 ? "" : "s"} in queue — review when ready.`);
  }

  if (overnightSpend > 0) {
    const dollars = (overnightSpend / 100).toFixed(2);
    findings.push(`$${dollars} in operating spend logged overnight.`);
  }

  if (findings.length === 0) {
    findings.push("Quiet night — no activity recorded. Trent's standing by.");
  }

  const recommendations: string[] = [];
  if (pendingApprovals.length > 0) {
    recommendations.push(`Review ${pendingApprovals.length} pending approval${pendingApprovals.length === 1 ? "" : "s"} in the Approvals queue.`);
  }
  recommendations.push("Check the Console for the latest cycle digest.");
  if (overnightCycles.length === 0 && company.nightlyRunHour === undefined) {
    recommendations.push("Enable a nightly run window in Settings → Budget Controls to automate overnight execution.");
  }

  const report = await store.createReport({
    companyId,
    type: "morning_briefing",
    title: subject,
    findings,
    recommendations,
  });
  const delivery = await deliverMorningBriefingEmail({
    company,
    report,
    outcomeSnapshot,
    findings,
    recommendations,
  });

  // Save as a searchable document in memory
  await store.createDocument({
    companyId,
    type: "weekly_report",
    title: subject,
    content: [
      outcomeSnapshot.join("\n"),
      "",
      findings.join("\n"),
      "",
      `Email delivery: ${delivery.summary}`,
      "",
      `Action items:\n${recommendations.join("\n")}`,
    ].join("\n"),
    source: "morning-briefing",
    version: 1,
  });

  await store.addAudit(
    companyId,
    "system",
    "morning_briefing.assembled",
    "report",
    report.id,
    `Morning briefing assembled for ${company.name}.`
  );

  await store.addAudit(
    companyId,
    "system",
    `morning_briefing.email_${delivery.status}`,
    "report",
    report.id,
    delivery.summary,
  );

  return report;
}

export async function createWeeklyReport(companyId: string): Promise<Report> {
  const company = await store.getCompany(companyId);
  if (!company) throw new Error("Company not found");
  const tasks = await store.listTasks(companyId);
  const cycles = await store.listCycles(companyId);
  const usage = await store.listUsage(companyId);
  const approvals = await store.listApprovals(companyId);
  const spend = usage.reduce((sum, entry) => sum + entry.amountCents, 0);
  const completed = tasks.filter((task) => task.status === "completed").length;
  const waiting = tasks.filter((task) => task.status === "waiting_approval").length;
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending").length;

  const report = await store.createReport({
    companyId,
    type: "weekly",
    title: "Weekly Operating Report",
    findings: [
      `${cycles.length} operating cycle${cycles.length === 1 ? "" : "s"} recorded for ${company.name}.`,
      `${tasks.length} total tasks, ${completed} completed, ${waiting} waiting on approval.`,
      `${pendingApprovals} approval${pendingApprovals === 1 ? "" : "s"} currently require human review.`,
      `${spend} cents logged in the usage ledger against a ${company.budgetCents} cent monthly cap.`
    ],
    recommendations: [
      "Review pending approvals before enabling broader autonomy.",
      "Connect GitHub first, then enable email draft approval once recurring task quality is reliable.",
      "Keep public dashboard visibility intentional and review every report before sharing externally."
    ]
  });

  await store.createDocument({
    companyId,
    type: "weekly_report",
    title: "Weekly Operating Report",
    content: `${report.findings.join("\n")}\n\nRecommendations:\n${report.recommendations.join("\n")}`,
    source: "weekly-report",
    version: 1
  });

  return report;
}
