/**
 * The no-persistence fallback keeps the same row shapes the durable store returns for the life of
 * the process: a job run's metadata payload survives a create-then-list, and the audit reader is
 * present but empty, since nothing here is ever written to an audit chain.
 */
import { describe, expect, it } from "vitest";
import { EphemeralStore } from "../ephemeral-store.js";

describe("EphemeralStore", () => {
  it("keeps a job run's metadata and lists it back", async () => {
    const store = new EphemeralStore();
    const created = await store.createJobRun({ type: "orchestration_step", trigger: "system", companyId: "cmp_1", metadata: { runId: "run_1", objective: "ship it" } });
    expect(created.metadata).toEqual({ runId: "run_1", objective: "ship it" });
    const [listed] = await store.listJobRuns("cmp_1");
    expect(listed?.metadata).toEqual({ runId: "run_1", objective: "ship it" });
  });

  it("lists no audit rows: nothing in the fallback ever reaches an audit chain", async () => {
    const store = new EphemeralStore();
    await store.createJobRun({ type: "orchestration_step", trigger: "system", companyId: "cmp_1" });
    expect(await store.listAuditRows()).toEqual([]);
    expect(await store.listAuditRows({ companyId: "cmp_1" })).toEqual([]);
  });
});
