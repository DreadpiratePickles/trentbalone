import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureOrchestrationFailureGolden,
  goldenObjectives,
  listOrchestrationGoldens,
  promoteOrchestrationGolden,
  sanitizeGoldenText,
} from "@/lib/orchestration-golden-capture";
import {
  buildOrchestrationEvalScorecard,
  buildOrchestrationSmokeReproducibility,
  meetsOrchestrationPassRateThreshold,
  partitionQuarantinedResults,
  scoreOrchestrationRun,
} from "@/lib/orchestration-eval";
import { store } from "@/lib/store";
import { makeId } from "@/lib/utils";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "trent-goldens-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function persistFailedRun(objective: string): Promise<string> {
  const company = await store.createCompany({ name: `Golden Co ${makeId("test")}`, brief: { vision: "g" } });
  const run = await store.createOrchestratorRun({
    id: makeId("orcrun"),
    companyId: company.id,
    objective,
    trigger: "manual",
    status: "failed",
    modelPolicy: {},
    budgetCents: 100,
    costCents: 3,
    summary: "step exploded",
  });
  await store.appendOrchestratorEvent({ runId: run.id, companyId: company.id, kind: "run_failed", payload: {} });
  return run.id;
}

describe("sanitizeGoldenText", () => {
  it("redacts key material, bearer tokens, and emails", () => {
    const raw = "Email ops@example.com using Bearer abc123token and key sk-live_abcdefgh1234 now";
    const clean = sanitizeGoldenText(raw);

    expect(clean).not.toContain("ops@example.com");
    expect(clean).not.toContain("Bearer abc123token");
    expect(clean).not.toContain("sk-live_abcdefgh1234");
    expect(clean).toContain("[EMAIL_REDACTED]");
  });
});

describe("captureOrchestrationFailureGolden", () => {
  it("captures a failed run as a quarantined, sanitized, runnable golden", async () => {
    const runId = await persistFailedRun("Send the digest to founder@example.com with Bearer secrettoken99");

    const golden = await captureOrchestrationFailureGolden({ runId, reason: "run_failed: step exploded", dir });

    expect(golden).toBeDefined();
    expect(golden!.status).toBe("quarantined");
    expect(golden!.objective).not.toContain("founder@example.com");
    expect(golden!.objective).not.toContain("secrettoken99");
    // Runnable: the golden converts to the exact objective shape the
    // integration suite consumes.
    const listed = await listOrchestrationGoldens(dir);
    const objectives = goldenObjectives(listed, { statuses: ["quarantined"] });
    expect(objectives).toEqual([{ id: golden!.id, objective: golden!.objective, teamShape: "full_team" }]);
  });

  it("is append-only: a second capture for the same run returns the existing golden", async () => {
    const runId = await persistFailedRun("Repeatable failure objective");

    const first = await captureOrchestrationFailureGolden({ runId, reason: "run_failed: a", dir });
    const second = await captureOrchestrationFailureGolden({ runId, reason: "critic_escalate: b", dir });

    expect(second!.id).toBe(first!.id);
    expect(second!.reason).toBe(first!.reason);
    expect(await listOrchestrationGoldens(dir)).toHaveLength(1);
  });

  it("returns undefined for an unknown run", async () => {
    await expect(captureOrchestrationFailureGolden({ runId: "orcrun_ghost", reason: "x", dir })).resolves.toBeUndefined();
  });
});

describe("promotion gate", () => {
  it("quarantined goldens are excluded from the blocking objective set until promoted", async () => {
    const runId = await persistFailedRun("Quarantine me");
    const golden = await captureOrchestrationFailureGolden({ runId, reason: "run_failed: q", dir });

    expect(goldenObjectives(await listOrchestrationGoldens(dir))).toEqual([]);

    const promoted = await promoteOrchestrationGolden(golden!.id, dir);
    expect(promoted!.status).toBe("blocking");
    expect(promoted!.promotedAt).toBeTruthy();

    const blocking = goldenObjectives(await listOrchestrationGoldens(dir));
    expect(blocking).toEqual([{ id: golden!.id, objective: golden!.objective, teamShape: "full_team" }]);
  });

  it("promoting an already-blocking golden is idempotent", async () => {
    const runId = await persistFailedRun("Promote twice");
    const golden = await captureOrchestrationFailureGolden({ runId, reason: "run_failed: p", dir });
    const once = await promoteOrchestrationGolden(golden!.id, dir);
    const twice = await promoteOrchestrationGolden(golden!.id, dir);

    expect(twice).toEqual(once);
  });
});

describe("quarantined results cannot fail CI", () => {
  it("a failing quarantined result is excluded from passRate and the threshold gate", () => {
    const passing = scoreOrchestrationRun({
      objectiveId: "orc_ok",
      planValid: true,
      stepSuccessRate: 1,
      objectiveAchieved: true,
      costCents: 10,
      wallClockMs: 100,
    });
    const failingQuarantined = {
      ...scoreOrchestrationRun({
        objectiveId: "orcgolden_bad",
        planValid: false,
        stepSuccessRate: 0,
        objectiveAchieved: false,
        costCents: 10,
        wallClockMs: 100,
      }),
      quarantined: true,
    };

    const { blocking, quarantined } = partitionQuarantinedResults([passing, failingQuarantined]);
    expect(quarantined).toHaveLength(1);

    const scorecard = buildOrchestrationEvalScorecard(blocking, buildOrchestrationSmokeReproducibility(blocking));
    expect(scorecard.passRate).toBe(1);
    expect(meetsOrchestrationPassRateThreshold(scorecard, 0.9)).toBe(true);
  });
});
