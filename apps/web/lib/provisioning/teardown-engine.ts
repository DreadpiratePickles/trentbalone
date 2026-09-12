/**
 * lib/provisioning/teardown-engine.ts
 *
 * Resource lifecycle state machine for company teardown.
 *
 * States: active → cooling_off → deleted
 *
 * Invariants:
 *   - Transition to cooling_off requires human-initiated call (requestedBy field).
 *   - Permanent deletion is BLOCKED unless coolingOffEndsAt has passed.
 *   - Cancelling teardown during cooling_off returns to active and clears timers.
 *   - advanceTeardownClock() is a test helper — moves coolingOffEndsAt backward
 *     so tests can simulate 30+ days passing without real clock manipulation.
 *   - confirmDeletion() writes teardown.delete audit entry; actual resource
 *     rollback is the caller's responsibility (orchestrator calls provisioner.rollback()).
 *
 * This module contains NO provisioning logic — only the state machine.
 * The orchestrator coordinates teardown by calling rollback() on each provisioner.
 */

import { store } from "@/lib/store";
import { encryptJson, decryptJson } from "@/lib/secrets";
import { appendAuditLog } from "@/lib/audit-log";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TeardownState = "active" | "cooling_off" | "deleted";

export type TeardownRecord = {
  companyId: string;
  state: TeardownState;
  requestedBy?: string;
  coolingOffStartedAt: string | null;
  coolingOffEndsAt: string | null;
  deletedAt: string | null;
};

export type InitiateTeardownInput = {
  companyId: string;
  requestedBy: string;
  coolingOffDays?: number;
};

export type CancelTeardownInput = {
  companyId: string;
  cancelledBy: string;
};

export type ConfirmDeletionInput = {
  companyId: string;
  confirmedBy: string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const PROVIDER_KEY = "Teardown-State";
const DEFAULT_COOLING_OFF_DAYS = 30;

// ── Store helpers ─────────────────────────────────────────────────────────────

async function loadRecord(companyId: string): Promise<TeardownRecord | null> {
  const integration = await store.getIntegration(companyId, PROVIDER_KEY);
  if (!integration?.encryptedData) return null;
  try {
    return decryptJson<TeardownRecord>(integration.encryptedData);
  } catch {
    return null;
  }
}

async function saveRecord(record: TeardownRecord): Promise<void> {
  await store.upsertIntegration({
    companyId: record.companyId,
    provider: PROVIDER_KEY,
    scopes: ["lifecycle"],
    status: record.state === "deleted" ? "mocked" : "connected",
    encryptedData: encryptJson(record),
  });
}

// ── initiateTeardown() ────────────────────────────────────────────────────────

/**
 * Transition company to cooling_off state.
 * Idempotent — if already in cooling_off, returns existing record without resetting timer.
 */
export async function initiateTeardown(input: InitiateTeardownInput): Promise<TeardownRecord> {
  const { companyId, requestedBy, coolingOffDays = DEFAULT_COOLING_OFF_DAYS } = input;

  const existing = await loadRecord(companyId);
  if (existing?.state === "cooling_off") return existing; // idempotent

  const now = new Date();
  const endsAt = new Date(now.getTime() + coolingOffDays * 24 * 60 * 60 * 1000);

  const record: TeardownRecord = {
    companyId,
    state: "cooling_off",
    requestedBy,
    coolingOffStartedAt: now.toISOString(),
    coolingOffEndsAt: endsAt.toISOString(),
    deletedAt: null,
  };

  await saveRecord(record);
  await appendAuditLog(
    companyId,
    "user",
    "teardown.initiate",
    "company",
    companyId,
    `Teardown initiated by ${requestedBy} — cooling off until ${endsAt.toISOString()}`
  );

  return record;
}

// ── cancelTeardown() ──────────────────────────────────────────────────────────

/**
 * Cancel an in-progress teardown and return to active state.
 * Safe to call when no teardown record exists.
 */
export async function cancelTeardown(input: CancelTeardownInput): Promise<TeardownRecord> {
  const { companyId, cancelledBy } = input;

  const existing = await loadRecord(companyId);
  if (!existing) {
    // No record — return a synthetic active record and skip audit
    return {
      companyId,
      state: "active",
      coolingOffStartedAt: null,
      coolingOffEndsAt: null,
      deletedAt: null,
    };
  }

  const record: TeardownRecord = {
    ...existing,
    state: "active",
    coolingOffStartedAt: null,
    coolingOffEndsAt: null,
  };

  await saveRecord(record);
  await appendAuditLog(
    companyId,
    "user",
    "teardown.cancel",
    "company",
    companyId,
    `Teardown cancelled by ${cancelledBy}`
  );

  return record;
}

// ── confirmDeletion() ─────────────────────────────────────────────────────────

/**
 * Confirm permanent deletion.
 *
 * SAFETY GUARD: throws if:
 *   - No teardown record exists (must call initiateTeardown first)
 *   - State is "active" (teardown was cancelled)
 *   - Cooling-off period has not expired
 *
 * Does NOT call provisioner rollback() — that is the orchestrator's job.
 * This function only advances the state machine to "deleted".
 */
export async function confirmDeletion(input: ConfirmDeletionInput): Promise<TeardownRecord> {
  const { companyId, confirmedBy } = input;

  const existing = await loadRecord(companyId);

  if (!existing) {
    throw new Error("No teardown record found — call initiateTeardown() first");
  }

  if (existing.state !== "cooling_off") {
    throw new Error(
      `Cannot delete: teardown state is '${existing.state}', expected 'cooling_off'`
    );
  }

  const now = new Date();
  const endsAt = existing.coolingOffEndsAt ? new Date(existing.coolingOffEndsAt) : null;

  if (!endsAt || now < endsAt) {
    throw new Error(
      `Cannot delete: cooling-off period has not expired. Expires at ${endsAt?.toISOString() ?? "unknown"}`
    );
  }

  const record: TeardownRecord = {
    ...existing,
    state: "deleted",
    deletedAt: now.toISOString(),
  };

  await saveRecord(record);
  await appendAuditLog(
    companyId,
    "user",
    "teardown.delete",
    "company",
    companyId,
    `Permanent deletion confirmed by ${confirmedBy}`
  );

  return record;
}

// ── getTeardownStatus() ───────────────────────────────────────────────────────

/**
 * Returns the current teardown record, or null if no teardown has been initiated.
 */
export async function getTeardownStatus(companyId: string): Promise<TeardownRecord | null> {
  return loadRecord(companyId);
}

// ── advanceTeardownClock() ────────────────────────────────────────────────────

/**
 * TEST HELPER ONLY — adjusts coolingOffEndsAt by the given delta days.
 * Pass a negative value (e.g. -31) to simulate 31 days having passed.
 *
 * This function must not be called in production code paths.
 */
export async function advanceTeardownClock(companyId: string, deltaDays: number): Promise<void> {
  const record = await loadRecord(companyId);
  if (!record?.coolingOffEndsAt) return;

  const current = new Date(record.coolingOffEndsAt);
  const adjusted = new Date(current.getTime() + deltaDays * 24 * 60 * 60 * 1000);

  await saveRecord({ ...record, coolingOffEndsAt: adjusted.toISOString() });
}
