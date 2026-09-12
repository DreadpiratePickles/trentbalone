import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCompanyCycle } from "@/lib/cycles";
import {
  createWeeklyReport,
  materializeCompanyRecurringTasksJob,
  materializeDueRecurringTasks,
  runScheduledCycleSweep
} from "@/lib/scheduler";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

const uniqueCompanyName = (base: string) => `${base} ${makeId("test")}`;

describe("runCompanyCycle", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_BASE_URL", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GITHUB_OWNER", "");
    vi.stubEnv("GITHUB_REPO", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates tasks, approvals, reports, executions, and usage", async () => {
    const companies = await store.listCompanies();
    const company = companies[0];
    const result = await runCompanyCycle(company.id);
    expect(result.cycle.status).toBe("completed");
    expect(result.tasks.length).toBeGreaterThan(0);
    expect(result.approvals.length).toBeGreaterThan(0);
    expect(result.reports.length).toBeGreaterThan(0);
    expect(result.executions.length).toBeGreaterThan(0);
    expect(result.usage.length).toBeGreaterThan(0);
    const updated = await store.getCompany(company.id);
    expect(updated?.lastCycleAt).toBeTruthy();
  });

  it("runs a full E2E operating cycle, generating a CEO chat briefing and out-of-scope suggestions", async () => {
    const company = await store.createCompany({
      name: uniqueCompanyName("E2E Test Company"),
      brief: { vision: "Build autonomous software teams" }
    });

    const result = await runCompanyCycle(company.id);

    expect(result.cycle.status).toBe("completed");
    expect(result.tasks.length).toBeGreaterThan(0);
    expect(result.approvals.length).toBeGreaterThan(0);
    expect(result.reports.length).toBeGreaterThan(0);
    expect(result.executions.length).toBeGreaterThan(0);
    expect(result.usage.length).toBeGreaterThan(0);

    // Verify CEO autopilot messages and suggestions
    const messages = await store.listCeoMessages(company.id);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages[0].direction).toBe("from_ceo");
    expect(messages[0].kind).toBe("autopilot_update");
    expect(messages[0].content).toContain("Cycle complete");

    const suggestions = await store.listCeoSuggestions(company.id);
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].status).toBe("pending");
  });

  it("marks a cycle failed when spend caps block execution", async () => {
    const company = await store.createCompany({
      name: uniqueCompanyName("Cycle Spend Block Co"),
      budgetCents: 0,
      brief: { vision: "Do not spend" }
    });

    await expect(runCompanyCycle(company.id)).rejects.toThrow("spend cap");
    const cycles = await store.listCycles(company.id);
    expect(cycles[0]?.status).toBe("failed");
  });

  it("searches memory and creates weekly operating reports", async () => {
    const companies = await store.listCompanies();
    const company = companies[0];
    const report = await createWeeklyReport(company.id);
    const results = await store.searchMemory(company.id, "approval GitHub growth");
    expect(report.type).toBe("weekly");
    expect(results.length).toBeGreaterThan(0);
  });

  it("materializes due recurring task templates", async () => {
    const companies = await store.listCompanies();
    const company = companies[0];
    const templates = await store.listRecurringTasks(company.id);
    const template = templates[0];
    await store.updateRecurringTask(template.id, { nextRunAt: new Date(Date.now() - 1000).toISOString() });
    const tasks = await materializeDueRecurringTasks(company.id);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0]?.recurringTemplateId).toBe(template.id);
  });

  it("records scheduler job runs", async () => {
    const companies = await store.listCompanies();
    const company = companies[0];
    const recurringJob = await materializeCompanyRecurringTasksJob(company.id);
    const sweepJob = await runScheduledCycleSweep("system", [company.id]);
    const jobs = await store.listJobRuns();

    expect(recurringJob?.status).toBe("completed");
    expect(sweepJob?.status).toMatch(/completed|failed/);
    expect(jobs.length).toBeGreaterThanOrEqual(2);
  });
});
