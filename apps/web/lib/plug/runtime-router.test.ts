import { describe, expect, it, vi } from "vitest";
import { store } from "@/lib/store";
import { findPlugBySlug } from "@/lib/plug/registry";
import { installPlugForCompany, listInstalledPlugsForCompany, runInstalledPlug } from "@/lib/plug/runtime-router";

describe("Plug runtime router", () => {
  it("installs and runs a Plug through the workbench and durable subtask queue", async () => {
    const plug = findPlugBySlug("weekly-ops-review");
    if (!plug) throw new Error("missing test plug");
    const company = await store.createCompany({
      name: `Plug Runtime ${Date.now()}`,
      brief: { vision: "Run installed plugs" },
    });
    const enqueueSubtaskRun = vi.fn()
      .mockResolvedValueOnce({ id: "job_analyst" })
      .mockResolvedValueOnce({ id: "job_critic" });

    const install = await installPlugForCompany({ companyId: company.id, plug });
    const installs = await listInstalledPlugsForCompany(company.id);
    const run = await runInstalledPlug({
      install,
      plug,
      variables: { company: "Acme" },
      enqueueSubtaskRun,
    });

    const session = await store.getWorkbenchSession(run.sessionId);
    const artifacts = await store.listWorkbenchArtifacts(run.sessionId);

    expect(install).toMatchObject({ companyId: company.id, plugId: plug.id, version: plug.version });
    expect(installs).toEqual([expect.objectContaining({
      plugId: plug.id,
      publisherId: plug.publisher.id,
      creatorVerified: plug.publisher.verified,
    })]);
    expect(session?.objective).toContain("Plug weekly-ops-review");
    expect(enqueueSubtaskRun).toHaveBeenCalledWith(expect.objectContaining({
      companyId: company.id,
      subtask: expect.objectContaining({
        seat: plug.seats[0].seat,
        outputContractId: plug.seats[0].outputContract,
        input: expect.objectContaining({
          plugRun: expect.objectContaining({ plugId: plug.id, sessionId: run.sessionId }),
        }),
      }),
      trigger: "system",
    }));
    expect(run.enqueuedJobRunIds).toEqual(["job_analyst"]);
    expect(artifacts.some((artifact) => artifact.id === run.outputArtifactId)).toBe(true);
  });

  it("routes Plug workbench sessions through the configured cloud sandbox provider when available", async () => {
    const originalDaytona = process.env.DAYTONA_API_KEY;
    const originalE2b = process.env.E2B_API_KEY;
    const originalDefault = process.env.WORKBENCH_DEFAULT_PROVIDER;
    process.env.DAYTONA_API_KEY = "test_daytona_key";
    delete process.env.E2B_API_KEY;
    delete process.env.WORKBENCH_DEFAULT_PROVIDER;
    try {
      const plug = findPlugBySlug("weekly-ops-review");
      if (!plug) throw new Error("missing test plug");
      const company = await store.createCompany({
        name: `Plug Cloud Runtime ${Date.now()}`,
        brief: { vision: "Run installed plugs in cloud sandboxes" },
      });
      const enqueueSubtaskRun = vi.fn().mockResolvedValue({ id: "job_analyst" });

      const install = await installPlugForCompany({ companyId: company.id, plug });
      const run = await runInstalledPlug({
        install,
        plug,
        variables: { company: "Acme" },
        enqueueSubtaskRun,
      });

      const session = await store.getWorkbenchSession(run.sessionId);
      expect(session?.provider).toBe("daytona");
    } finally {
      if (originalDaytona === undefined) delete process.env.DAYTONA_API_KEY;
      else process.env.DAYTONA_API_KEY = originalDaytona;
      if (originalE2b === undefined) delete process.env.E2B_API_KEY;
      else process.env.E2B_API_KEY = originalE2b;
      if (originalDefault === undefined) delete process.env.WORKBENCH_DEFAULT_PROVIDER;
      else process.env.WORKBENCH_DEFAULT_PROVIDER = originalDefault;
    }
  });
});
