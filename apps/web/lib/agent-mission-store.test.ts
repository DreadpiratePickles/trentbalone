import { describe, expect, it } from "vitest";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

describe("agent mission durable store", () => {
  it("persists a mission run and reads it back by id and company", async () => {
    const company = await store.createCompany({ name: `Mission ${makeId("co")}`, brief: { vision: "test" } });
    const runId = makeId("amr");
    const created = await store.createAgentMissionRun({
      id: runId,
      companyId: company.id,
      objective: "Produce content and publish",
      missionType: "content_social_ads",
      status: "planning",
      trigger: "manual",
      ownerSeat: "ceo",
      budgetCents: 5000,
      costCents: 0,
      approvalPolicy: { publish: "required", paid_spend: "required" },
      modelPolicy: { default: "sonnet" },
    });

    expect(created.id).toBe(runId);
    expect(created.startedAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();

    const fetched = await store.getAgentMissionRun(runId);
    expect(fetched?.objective).toBe("Produce content and publish");
    expect(fetched?.approvalPolicy).toEqual({ publish: "required", paid_spend: "required" });

    const list = await store.listAgentMissionRuns(company.id);
    expect(list.map((r) => r.id)).toContain(runId);
  });

  it("updates run status and final summary", async () => {
    const company = await store.createCompany({ name: `Mission ${makeId("co")}`, brief: { vision: "test" } });
    const runId = makeId("amr");
    await store.createAgentMissionRun({
      id: runId,
      companyId: company.id,
      objective: "Research viral angles",
      missionType: "research",
      status: "running",
      trigger: "command",
      ownerSeat: "ceo",
      budgetCents: 0,
      costCents: 0,
      approvalPolicy: {},
      modelPolicy: {},
    });

    const updated = await store.updateAgentMissionRun(runId, {
      status: "completed",
      finalSummary: "Found 5 angles",
      costCents: 1200,
      completedAt: new Date().toISOString(),
    });

    expect(updated?.status).toBe("completed");
    expect(updated?.finalSummary).toBe("Found 5 angles");
    expect(updated?.costCents).toBe(1200);
    expect(updated?.completedAt).toBeTruthy();
  });

  it("upserts steps and lists them in seq order", async () => {
    const company = await store.createCompany({ name: `Mission ${makeId("co")}`, brief: { vision: "test" } });
    const runId = makeId("amr");
    await store.createAgentMissionRun({
      id: runId,
      companyId: company.id,
      objective: "Produce content and publish",
      missionType: "content_social_ads",
      status: "running",
      trigger: "manual",
      ownerSeat: "ceo",
      budgetCents: 0,
      costCents: 0,
      approvalPolicy: {},
      modelPolicy: {},
    });

    const stepB = {
      id: `${runId}:s2`,
      runId,
      companyId: company.id,
      seq: 2,
      agentRole: "growth" as const,
      title: "Growth strategy",
      objective: "Plan distribution",
      status: "pending" as const,
      dependsOn: [`${runId}:s1`],
      expectedOutput: "distributionPlan",
      costCents: 0,
    };
    const stepA = {
      id: `${runId}:s1`,
      runId,
      companyId: company.id,
      seq: 1,
      agentRole: "analyst" as const,
      title: "Research",
      objective: "Find trends",
      status: "pending" as const,
      dependsOn: [],
      expectedOutput: "trendSignals",
      costCents: 0,
    };

    await store.upsertAgentMissionStep(stepB);
    await store.upsertAgentMissionStep(stepA);

    const steps = await store.listAgentMissionSteps(runId);
    expect(steps.map((s) => s.seq)).toEqual([1, 2]);

    const reExecuted = await store.upsertAgentMissionStep({ ...stepA, status: "completed", output: "trendSignals: 3" });
    expect(reExecuted.status).toBe("completed");
    const afterUpdate = await store.listAgentMissionSteps(runId);
    expect(afterUpdate).toHaveLength(2);
    expect(afterUpdate.find((s) => s.id === stepA.id)?.output).toBe("trendSignals: 3");
  });

  it("appends events with monotonic seq and replays them in order", async () => {
    const company = await store.createCompany({ name: `Mission ${makeId("co")}`, brief: { vision: "test" } });
    const runId = makeId("amr");
    await store.createAgentMissionRun({
      id: runId,
      companyId: company.id,
      objective: "Produce content and publish",
      missionType: "content_social_ads",
      status: "running",
      trigger: "manual",
      ownerSeat: "ceo",
      budgetCents: 0,
      costCents: 0,
      approvalPolicy: {},
      modelPolicy: {},
    });

    await store.appendAgentMissionEvent({ runId, companyId: company.id, kind: "run_start", payload: {} });
    await store.appendAgentMissionEvent({ runId, companyId: company.id, kind: "step_start", stepId: `${runId}:s1`, payload: { seat: "analyst" } });
    await store.appendAgentMissionEvent({ runId, companyId: company.id, kind: "run_done", payload: {} });

    const events = await store.listAgentMissionEvents(runId);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events.map((e) => e.kind)).toEqual(["run_start", "step_start", "run_done"]);
    expect(events[1].stepId).toBe(`${runId}:s1`);
    expect(events[1].payload).toEqual({ seat: "analyst" });
  });
});
