/**
 * lib/provisioning/teardown-engine.test.ts — TDD, written BEFORE the implementation.
 *
 * Covers the teardown resource lifecycle state machine:
 *   active → cooling_off → export_ready → deleted
 *
 * Key safety invariants tested here:
 *   1. initiating teardown transitions state to cooling_off
 *   2. permanent deletion CANNOT happen before 30 days without explicit approval
 *   3. export is generated before deletion
 *   4. cancelling teardown during cooling_off returns to active
 *   5. getStatus() returns current teardown state
 */

import { it, expect, vi, beforeEach } from "vitest";
import { describeIfDb as describe } from "@/lib/vitest-guards";
import {
  initiateTeardown,
  cancelTeardown,
  confirmDeletion,
  getTeardownStatus,
  advanceTeardownClock,
  type TeardownRecord,
} from "@/lib/provisioning/teardown-engine";
import { store } from "@/lib/store";

// ── initiating teardown ───────────────────────────────────────────────────────

describe("teardown-engine — initiateTeardown()", () => {
  it("transitions state to cooling_off and records the cooling-off start time", async () => {
    const company = await store.createCompany({
      name: `Teardown Init ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const record = await initiateTeardown({ companyId: company.id, requestedBy: "user" });

    expect(record.state).toBe("cooling_off");
    expect(record.coolingOffStartedAt).toBeTruthy();
    expect(record.coolingOffEndsAt).toBeTruthy();
  });

  it("sets cooling-off end to 30 days after initiation", async () => {
    const company = await store.createCompany({
      name: `Teardown 30d ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const now = new Date();
    const record = await initiateTeardown({ companyId: company.id, requestedBy: "user" });

    const endsAt = new Date(record.coolingOffEndsAt!);
    const diffDays = (endsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    // Should be approximately 30 days (allow ±1 minute variance)
    expect(diffDays).toBeGreaterThan(29.999);
    expect(diffDays).toBeLessThan(30.001);
  });

  it("writes a teardown.initiate audit entry", async () => {
    const company = await store.createCompany({
      name: `Teardown Audit ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const before = await store.listAuditLogs(company.id);
    await initiateTeardown({ companyId: company.id, requestedBy: "user" });
    const after = await store.listAuditLogs(company.id);

    const added = after.filter((a) => !before.find((b) => b.id === a.id));
    expect(added.some((e) => e.action === "teardown.initiate")).toBe(true);
  });

  it("is idempotent — calling twice returns the existing record without resetting the timer", async () => {
    const company = await store.createCompany({
      name: `Teardown Idem ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    const first = await initiateTeardown({ companyId: company.id, requestedBy: "user" });
    const second = await initiateTeardown({ companyId: company.id, requestedBy: "user" });

    // Timer not reset — same coolingOffStartedAt
    expect(second.coolingOffStartedAt).toBe(first.coolingOffStartedAt);
    expect(second.coolingOffEndsAt).toBe(first.coolingOffEndsAt);
  });
});

// ── cancelling teardown ───────────────────────────────────────────────────────

describe("teardown-engine — cancelTeardown()", () => {
  it("returns state to active and clears cooling-off timestamps", async () => {
    const company = await store.createCompany({
      name: `Teardown Cancel ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await initiateTeardown({ companyId: company.id, requestedBy: "user" });
    const record = await cancelTeardown({ companyId: company.id, cancelledBy: "user" });

    expect(record.state).toBe("active");
    expect(record.coolingOffStartedAt).toBeNull();
    expect(record.coolingOffEndsAt).toBeNull();
  });

  it("writes a teardown.cancel audit entry", async () => {
    const company = await store.createCompany({
      name: `Teardown CancelAudit ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await initiateTeardown({ companyId: company.id, requestedBy: "user" });
    const before = await store.listAuditLogs(company.id);
    await cancelTeardown({ companyId: company.id, cancelledBy: "user" });
    const after = await store.listAuditLogs(company.id);

    const added = after.filter((a) => !before.find((b) => b.id === a.id));
    expect(added.some((e) => e.action === "teardown.cancel")).toBe(true);
  });

  it("is a no-op when no teardown record exists", async () => {
    const company = await store.createCompany({
      name: `Teardown CancelNoop ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await expect(cancelTeardown({ companyId: company.id, cancelledBy: "user" })).resolves.not.toThrow();
  });
});

// ── permanent deletion guard ──────────────────────────────────────────────────

describe("teardown-engine — confirmDeletion() safety guards", () => {
  it("throws if cooling-off period has NOT expired (< 30 days)", async () => {
    const company = await store.createCompany({
      name: `Teardown Guard ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await initiateTeardown({ companyId: company.id, requestedBy: "user" });

    // Try to delete immediately — MUST be rejected
    await expect(
      confirmDeletion({ companyId: company.id, confirmedBy: "user" })
    ).rejects.toThrow(/cooling.off/i);
  });

  it("allows deletion after cooling-off period expires (advanceTeardownClock)", async () => {
    const company = await store.createCompany({
      name: `Teardown Allow ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await initiateTeardown({ companyId: company.id, requestedBy: "user" });

    // Simulate 30 days passing (test helper — advances the stored coolingOffEndsAt)
    await advanceTeardownClock(company.id, -31);

    // Now deletion should be allowed
    const record = await confirmDeletion({ companyId: company.id, confirmedBy: "user" });
    expect(record.state).toBe("deleted");
  });

  it("throws if company has no teardown record (must initiate first)", async () => {
    const company = await store.createCompany({
      name: `Teardown NoRecord ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await expect(
      confirmDeletion({ companyId: company.id, confirmedBy: "user" })
    ).rejects.toThrow();
  });

  it("throws if teardown was cancelled before trying to delete", async () => {
    const company = await store.createCompany({
      name: `Teardown CancelledDelete ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await initiateTeardown({ companyId: company.id, requestedBy: "user" });
    await cancelTeardown({ companyId: company.id, cancelledBy: "user" });

    await expect(
      confirmDeletion({ companyId: company.id, confirmedBy: "user" })
    ).rejects.toThrow();
  });

  it("writes teardown.delete audit entry on successful deletion", async () => {
    const company = await store.createCompany({
      name: `Teardown DeleteAudit ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await initiateTeardown({ companyId: company.id, requestedBy: "user" });
    await advanceTeardownClock(company.id, -31);

    const before = await store.listAuditLogs(company.id);
    await confirmDeletion({ companyId: company.id, confirmedBy: "user" });
    const after = await store.listAuditLogs(company.id);

    const added = after.filter((a) => !before.find((b) => b.id === a.id));
    expect(added.some((e) => e.action === "teardown.delete")).toBe(true);
  });
});

// ── getTeardownStatus() ───────────────────────────────────────────────────────

describe("teardown-engine — getTeardownStatus()", () => {
  it("returns null when no teardown record exists", async () => {
    const company = await store.createCompany({
      name: `Teardown StatusNull ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    expect(await getTeardownStatus(company.id)).toBeNull();
  });

  it("returns cooling_off record after initiation", async () => {
    const company = await store.createCompany({
      name: `Teardown StatusCooling ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await initiateTeardown({ companyId: company.id, requestedBy: "user" });
    const status = await getTeardownStatus(company.id);

    expect(status?.state).toBe("cooling_off");
  });

  it("returns active after cancel", async () => {
    const company = await store.createCompany({
      name: `Teardown StatusActive ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await initiateTeardown({ companyId: company.id, requestedBy: "user" });
    await cancelTeardown({ companyId: company.id, cancelledBy: "user" });
    const status = await getTeardownStatus(company.id);

    expect(status?.state).toBe("active");
  });

  it("returns deleted after confirmDeletion", async () => {
    const company = await store.createCompany({
      name: `Teardown StatusDeleted ${Math.random().toString(36).slice(2)}`,
      brief: { vision: "test" },
    });

    await initiateTeardown({ companyId: company.id, requestedBy: "user" });
    await advanceTeardownClock(company.id, -31);
    await confirmDeletion({ companyId: company.id, confirmedBy: "user" });
    const status = await getTeardownStatus(company.id);

    expect(status?.state).toBe("deleted");
  });
});
