/**
 * Persistence tests for Prisma-backed self-improvement stores.
 *
 * Guarded by describeIfDb: these tests SKIP unless VITEST_DB_AVAILABLE=1 is
 * set (which requires a real Postgres test DB). In CI without a DB this suite
 * reports as skipped — the expected outcome in the current environment.
 *
 * All Prisma client instantiation and DB calls are kept inside it() bodies so
 * the describe.skip callback-collection pass never touches the DB.
 */

import { it, expect } from "vitest";
import { describeIfDb } from "@/lib/vitest-guards";
import { PrismaTraceStore } from "@/lib/self-improvement/trace-store.prisma";
import { PrismaSkillDraftStore } from "@/lib/self-improvement/skill-draft-store.prisma";
import { PrismaIterationLog } from "@/lib/self-improvement/iteration-log.prisma";
import type { TraceRecord } from "@/lib/trace-store";
import type { SelfImprovementIteration } from "@/lib/self-improvement/iteration-log";

describeIfDb("self-improvement persistence (Prisma)", () => {
  const COMPANY_ID = `co_persist_test_${Date.now()}`;

  it("trace store round-trips by company + taskType", async () => {
    // Seed the company row first (FK constraint).
    const { db } = await import("@/lib/db");
    await db.company.create({
      data: {
        id: COMPANY_ID,
        name: "Persistence Test Co",
        slug: `persist-test-${Date.now()}`,
        brief: {},
        metrics: {},
      },
    });

    const store = new PrismaTraceStore();

    const record: TraceRecord = {
      id: `trace_test_${Date.now()}`,
      companyId: COMPANY_ID,
      runId: `run_test_${Date.now()}`,
      taskType: "ads",
      agentRole: "growth",
      stepTitle: "Plan campaign",
      status: "completed",
      toolCalls: ["search", "draft"],
      toolCallCount: 2,
      critiqueVerdict: "pass",
      improvement: undefined,
      evalScore: 0.85,
      costCents: 5,
      latencyMs: 1200,
      humanCorrected: false,
      createdAt: new Date().toISOString(),
    };

    await store.append(record);

    const byCompany = await store.query(COMPANY_ID, "ads");
    expect(byCompany).toHaveLength(1);
    expect(byCompany[0].id).toBe(record.id);
    expect(byCompany[0].toolCalls).toEqual(["search", "draft"]);
    expect(byCompany[0].evalScore).toBe(0.85);
    expect(byCompany[0].critiqueVerdict).toBe("pass");
    expect(byCompany[0].improvement).toBeUndefined();

    const byRun = await store.byRun(record.runId);
    expect(byRun).toHaveLength(1);
    expect(byRun[0].id).toBe(record.id);

    // Cleanup
    await db.company.delete({ where: { id: COMPANY_ID } });
  });

  it("skill draft store write→read→promote→readLive round-trips", async () => {
    const companyId = `co_skill_test_${Date.now()}`;
    const { db } = await import("@/lib/db");
    await db.company.create({
      data: {
        id: companyId,
        name: "Skill Draft Test Co",
        slug: `skill-test-${Date.now()}`,
        brief: {},
        metrics: {},
      },
    });

    const store = new PrismaSkillDraftStore();
    const taskType = "content-generation";
    const content = "# Skill\n\nStep 1: Do the thing.";

    const draftId = await store.writeQuarantine(companyId, taskType, content);
    expect(typeof draftId).toBe("string");
    expect(draftId.length).toBeGreaterThan(0);

    const quarantined = await store.readQuarantine(companyId, taskType);
    expect(quarantined).toBe(content);

    // Live should be empty before promotion
    expect(await store.readLive(companyId, taskType)).toBeUndefined();

    await store.promote(companyId, taskType);

    // After promotion: live has content, quarantine is gone
    expect(await store.readLive(companyId, taskType)).toBe(content);
    expect(await store.readQuarantine(companyId, taskType)).toBeUndefined();

    const taskTypes = await store.listLiveTaskTypes(companyId);
    expect(taskTypes).toContain(taskType);

    // Cleanup
    await db.company.delete({ where: { id: companyId } });
  });

  it("iteration log append→list newest-first", async () => {
    const companyId = `co_iter_test_${Date.now()}`;
    const { db } = await import("@/lib/db");
    await db.company.create({
      data: {
        id: companyId,
        name: "Iteration Log Test Co",
        slug: `iter-test-${Date.now()}`,
        brief: {},
        metrics: {},
      },
    });

    const log = new PrismaIterationLog();

    const older: SelfImprovementIteration = {
      id: `iter_older_${Date.now()}`,
      companyId,
      taskType: "ads",
      decision: "rejected",
      triggers: ["tool_call_threshold"],
      blockedBy: "regression",
      createdAt: new Date(Date.now() - 10_000).toISOString(),
    };

    const newer: SelfImprovementIteration = {
      id: `iter_newer_${Date.now()}`,
      companyId,
      taskType: "ads",
      candidateId: "skill_abc",
      candidateKind: "skill",
      score: 0.9,
      delta: 0.05,
      decision: "pending_approval",
      triggers: ["high_score_no_skill"],
      approvalId: "appr_123",
      createdAt: new Date().toISOString(),
    };

    await log.append(older);
    await log.append(newer);

    const results = await log.list(companyId);
    expect(results).toHaveLength(2);
    // Newest first
    expect(results[0].id).toBe(newer.id);
    expect(results[1].id).toBe(older.id);

    expect(results[0].candidateKind).toBe("skill");
    expect(results[0].score).toBe(0.9);
    expect(results[0].triggers).toEqual(["high_score_no_skill"]);
    expect(results[1].blockedBy).toBe("regression");
    expect(results[1].candidateId).toBeUndefined();

    // Cleanup
    await db.company.delete({ where: { id: companyId } });
  });
});
